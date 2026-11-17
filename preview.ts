// Previews: an app in a directory, a named URL routed to its port, and a lease.
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { origin, type Config } from "./config";
import { composeFile, projectResources, startCompose, stopCompose } from "./compose";
import { logPath, running, startCommand, stopCommand, waitForHTTP } from "./command";
import { DEFAULT_TTL, installReaper, requireExpirySupport } from "./lease";
import { askThroughProxy, ensureProxy, registerSite, removeSite, sitePath } from "./proxy";
import { errorMessage, type Env } from "./sh";
import { deletePreview, deleteRetained, readPreviews, readRetained, savePreview, type Mode, type Preview } from "./state";

export interface UpOptions {
  dir: string;
  name?: string;
  command?: string[]; // Run this; otherwise the directory's Compose file, or a running app with --local.
  local: boolean;
  port?: number;
  target?: string;
  ttl?: number; // Milliseconds, 0 for no expiry; by default new previews get DEFAULT_TTL.
  waitMs: number;
  build: boolean;
  disposable: boolean;
  services: string[];
  profiles: string[];
  urlEnv: string[];
}

export async function up(config: Config, opts: UpOptions): Promise<void> {
  const all = readPreviews(config);
  const sameDir = all.filter((preview) => preview.dir === opts.dir);
  if (!opts.name && sameDir.length > 1) throw new Error("multiple previews serve this directory; specify --name");
  // Repeating up in a directory reuses its name; otherwise a short random one, e.g. "9f3ab1".
  const name = opts.name ?? sameDir[0]?.name ?? randomBytes(3).toString("hex");
  if (name.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`invalid preview name: ${name}`);
  // Compose previews run as project tunnel-<name>; the shared proxy's project is tunnel-proxy-<hash>.
  if (name === "proxy" || name.startsWith("proxy-")) throw new Error("names starting with proxy are reserved for the shared proxy");
  const url = origin(config, name);
  const existing = all.find((preview) => preview.name === name);
  if (existing && existing.dir !== opts.dir) throw new Error(`${name} already serves ${existing.dir}`);
  if (!existing && existsSync(sitePath(config, name))) throw new Error("hostname already registered outside tunnel; refusing to overwrite");
  if (existing && existing.url !== url) throw new Error("configuration changed; restore it and remove the old preview before re-registering");

  const mode = chooseMode(opts, existing);
  if (existing && existing.mode !== mode) throw new Error(`${name} runs ${describe(existing.mode)}; tunnel down ${name} before changing that`);
  if (opts.disposable && existing && !existing.disposable) throw new Error("--disposable is fixed when a preview is created; remove the preview to change it");
  // A repeated up keeps earlier choices unless new ones replace them.
  const fixedPort = opts.port ?? (opts.target ? undefined : existing?.fixedPort);
  const preview: Preview = {
    name, dir: opts.dir, mode, url,
    port: existing?.port,
    fixedPort,
    expiresAt: existing?.expiresAt,
    urlEnv: union(existing?.urlEnv, opts.urlEnv).map(checkEnvName),
    project: mode === "compose" ? existing?.project ?? `tunnel-${name}` : undefined,
    services: union(existing?.services, opts.services),
    profiles: union(existing?.profiles, opts.profiles),
    target: fixedPort ? undefined : opts.target ?? existing?.target,
    disposable: opts.disposable || !!existing?.disposable,
    command: opts.command ?? existing?.command,
    pid: existing?.pid,
    pidStart: existing?.pidStart,
  };
  checkOptions(preview, opts);

  // New previews get the default lease. Repeating up renews a lease (never shortening it) but
  // leaves a preview without expiry alone; --ttl always sets the lease explicitly. The lease runs
  // from when the preview is ready, so a slow build does not eat into it.
  const leaseFrom = (now: number) => {
    if (opts.ttl !== undefined) return opts.ttl ? now + opts.ttl : undefined;
    if (!existing) return now + DEFAULT_TTL;
    return existing.expiresAt ? Math.max(existing.expiresAt, now + DEFAULT_TTL) : undefined;
  };
  const leased = leaseFrom(Date.now()) !== undefined;
  if (leased) requireExpirySupport();
  if (mode === "compose" && !existing) claimProject(config, preview);

  // Validation is done; from here on, Docker, processes and launchd change.
  if (leased) installReaperFor(config, all);
  ensureProxy(config);
  // Record a new preview, with a provisional lease, before starting it, so after a crash down or
  // cleanup can still remove whatever started.
  let current: Preview = { ...preview, port: undefined, expiresAt: leaseFrom(Date.now()) };
  if (!existing) {
    savePreview(config, current);
    if (preview.project) deleteRetained(config, preview.project);
  }
  try {
    // The old port may be gone once the app restarts, so stop routing to it until the new one is known.
    if (existing) removeSite(config, name);
    const env: Env = Object.fromEntries(preview.urlEnv.map((key) => [key, url]));
    let port: number;
    if (mode === "compose") {
      port = await startCompose(config, preview, { build: opts.build, env, waitMs: opts.waitMs });
    } else if (mode === "command") {
      if (existing) await stopCommand(existing);
      const started = await startCommand(config, preview, { ...env, TUNNEL_URL: url });
      current = { ...current, pid: started.pid, pidStart: started.pidStart };
      savePreview(config, existing ? { ...existing, pid: started.pid, pidStart: started.pidStart } : current);
      port = await waitForHTTP(config, preview, started, opts.waitMs);
    } else {
      port = preview.fixedPort!;
    }
    registerSite(config, name, port);
    const ready = Date.now();
    current = { ...current, port, expiresAt: leaseFrom(ready) };
    savePreview(config, current);
    console.log(`${url} -> ${opts.dir} (port ${port})`);
    if (mode === "command") console.log(`logs: tunnel logs ${name}`);
    await warnIfHostRejected(config, name);
    console.log(`stop it: tunnel down ${name}; ${current.expiresAt ? `expires in ${Math.round((current.expiresAt - ready) / 60_000)} minutes` : "no expiry"}`);
  } catch (error) {
    // A failed new preview is removed. A failed restart keeps its record, unrouted, for a retried
    // up or down, but a command that never became ready is stopped rather than left running.
    try {
      if (!existing) await teardown(config, current);
      else if (mode === "command") await stopCommand(current);
    } catch (rollback) {
      throw new Error(`${errorMessage(error)}; rollback failed: ${errorMessage(rollback)}; retry with tunnel down ${name}`);
    }
    throw error;
  }
}

// Dev servers commonly answer only to localhost (Vite's allowedHosts, Django's ALLOWED_HOSTS,
// Jupyter's allow_remote_access). The route works either way, so this only warns.
async function warnIfHostRejected(config: Config, name: string): Promise<void> {
  const answer = await askThroughProxy(config, name);
  if (!answer || ![400, 403, 421].includes(answer.status)) return;
  const hint = /allowedHosts/.test(answer.body) ? " (Vite: add it to server.allowedHosts)"
    : /DisallowedHost|ALLOWED_HOSTS/.test(answer.body) ? " (Django: add it to ALLOWED_HOSTS)"
    : /jupyter/i.test(answer.body) ? " (Jupyter: pass --ServerApp.allow_remote_access=True)" : "";
  console.error(`tunnel: warning: the app answers HTTP ${answer.status} for ${name}.${config.domain}; `
    + `if it checks the Host header, allow that hostname${hint}`);
}

function chooseMode(opts: UpOptions, existing: Preview | undefined): Mode {
  if (opts.command) return "command";
  if (opts.local) return "local";
  if (existing) return existing.mode;
  if (composeFile(opts.dir)) return "compose";
  if (opts.port) return "local";
  throw new Error(`nothing to run in ${opts.dir}: give a command after --, add a Compose file, or route a running app with --local --port`);
}

const describe = (mode: Mode) => ({ compose: "a Compose stack", command: "a command", local: "an app tunnel did not start" })[mode];

function checkOptions(preview: Preview, opts: UpOptions): void {
  const composeOnly = { "--target": !!opts.target, "--service": opts.services.length > 0, "--profile": opts.profiles.length > 0,
    "--build": opts.build, "--disposable": opts.disposable };
  if (preview.mode !== "compose") {
    const used = Object.entries(composeOnly).filter(([, set]) => set).map(([flag]) => flag);
    if (used.length) throw new Error(`only Compose previews take ${used.join(", ")}`);
  }
  if (preview.mode === "local") {
    if (!preview.fixedPort) throw new Error("--local needs the --port the app listens on");
    if (preview.urlEnv.length) throw new Error("--url-env cannot reach an app tunnel did not start");
  }
}

const union = (...lists: (readonly string[] | undefined)[]) => [...new Set(lists.flatMap((list) => list ?? []))];

// Names are persisted and re-applied on every up, so stored ones are checked too.
function checkEnvName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid environment variable name: ${name}`);
  if (["PATH", "HOME", "PORT"].includes(name) || /^(DOCKER|COMPOSE)_/.test(name)) {
    throw new Error(`--url-env cannot override ${name}; tunnel, Docker or the shell relies on it`);
  }
  return name;
}

// Teardown removes everything labeled with the project, so never adopt anything already there,
// except volumes an earlier preview of this same directory kept.
function claimProject(config: Config, preview: Preview): void {
  const project = preview.project!;
  const found = projectResources(project);
  const ours = readRetained(config).some((kept) => kept.project === project && kept.dir === preview.dir);
  if (found.containers.length || found.networks.length || (found.volumes.length && !ours)) {
    throw new Error(`Docker already has resources for Compose project ${project} that no preview owns. `
      + `Inspect them with docker ps -a, docker network ls and docker volume ls using --filter label=com.docker.compose.project=${project}, or choose another --name`);
  }
}

// The job tears previews down with the configuration baked in now, so refuse to rewrite it while a
// leased preview was registered under another one (for example before an IP change).
export function installReaperFor(config: Config, previews: Preview[]): void {
  const stranded = previews.find((preview) => preview.expiresAt && preview.url !== origin(config, preview.name));
  if (stranded) {
    throw new Error(`leased preview ${stranded.name} uses ${stranded.url}, which this configuration cannot remove; `
      + `restore the configuration it was created with (for example TUNNEL_PROXY_IP) and run tunnel down ${stranded.name}`);
  }
  installReaper(config);
}

// Stops what the preview runs (an app tunnel did not start is left alone) and removes its route
// and record. Volumes go only for disposable previews unless `volumes` says otherwise.
export async function teardown(config: Config, preview: Preview, { volumes = preview.disposable } = {}): Promise<void> {
  if (preview.mode === "compose") stopCompose(config, preview, { volumes });
  else if (preview.mode === "command") await stopCommand(preview);
  removeSite(config, preview.name);
  deletePreview(config, preview.name);
  rmSync(logPath(config, preview.name), { force: true });
}

// The preview named `target`, or else the one serving the directory `target`.
export function findPreview(config: Config, target: string, dir: string): Preview {
  const all = readPreviews(config);
  const exact = all.find((preview) => preview.name === target);
  const candidates = exact ? [exact] : all.filter((preview) => preview.dir === dir);
  if (candidates.length > 1) throw new Error("multiple previews serve this directory; specify a name");
  if (!candidates[0]) throw new Error(`no preview named or serving ${target}`);
  return candidates[0];
}

export async function down(config: Config, preview: Preview): Promise<void> {
  if (preview.url !== origin(config, preview.name)) {
    throw new Error("configuration changed; restore the original domain and proxy port before removing this preview");
  }
  await teardown(config, preview);
  console.log(`tunnel: ${preview.name} removed${preview.mode === "local" ? " (local app left running)" : ""}`);
}

export const expired = (preview: Preview) => !!preview.expiresAt && preview.expiresAt <= Date.now();

export async function cleanup(config: Config): Promise<void> {
  for (const preview of readPreviews(config).filter(expired)) {
    try { await down(config, preview); }
    catch (error) {
      console.error(`tunnel: ${preview.name} expired but teardown failed; retrying next run: ${errorMessage(error)}`);
      process.exitCode = 1;
    }
  }
}

export function extend(config: Config, name: string, ttl: number): void {
  const all = readPreviews(config);
  const preview = all.find((p) => p.name === name);
  if (!preview) throw new Error(`no preview named ${name}`);
  const expiresAt = ttl ? Date.now() + ttl : undefined;
  if (ttl) {
    requireExpirySupport();
    installReaperFor(config, [...all, { ...preview, expiresAt }]);
  }
  savePreview(config, { ...preview, expiresAt });
  console.log(`tunnel: ${name} ${ttl ? `expires in ${ttl / 60_000} minutes` : "will not expire"}`);
}

export function ls(config: Config): void {
  for (const preview of readPreviews(config)) {
    const what = preview.mode === "command" ? `command${running(preview) ? "" : ", exited"}` : preview.mode;
    const expiry = preview.expiresAt ? `expires ${new Date(preview.expiresAt).toISOString()}` : "no expiry";
    console.log(`${preview.url}\t${preview.dir} (port ${preview.port ?? "starting"}, ${what}; ${expiry})`);
  }
}
