#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { configDir, configFile, detectIP, savedSettings, settings, validatePort, type Config, type Settings } from "./config";
import { compose, projectResources, publishedPort, publishedPorts, removeProject, previewOverride, sh, type Env } from "./docker";
import { DEFAULT_TTL, installReaper, parseTTL, requireExpirySupport } from "./lease";
import { ensureProxy, origin, proxyContainer, registerSite, removeSite, sitePath } from "./proxy";
import { acquireLock, deleteMapping, readMappings, saveMapping, type Mapping } from "./state";

const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
// Compose loads the override next to the default file only when no --file is given, so do it here.
const overrideFile = (file: string) => file.replace(/\.(ya?ml)$/, ".override.$1");
const overridePath = (config: Config, name: string) => join(config.stateDir, "dev-proxy", "compose", `${name}.yaml`);

const HELP = `usage: tunnel up [--name NAME] [--port PORT | --target SERVICE:PORT] [--build]
                 [--local] [--ttl 30m|never] [--disposable] [--service SERVICE]
                 [--profile PROFILE] [--url-env VARIABLE] [dir]
       tunnel extend NAME [30m|never]
       tunnel down [name|dir]
       tunnel cleanup
       tunnel ls
       tunnel setup [--ip IPV4] [--domain DOMAIN|auto] [--port PORT]
                    [--bind IPV4] [--dns external|split] [--state-dir DIR]
       tunnel doctor
       tunnel --skill
       tunnel --help

Fixed host ports and container, volume and network names in the Compose file
are made per-preview, so stacks never collide; with several, the one answering HTTP is routed.
--port selects a published host port (and keeps fixed ports). --target SERVICE:PORT resolves the host
port Compose published for a service's container port after startup.
Without a Compose file, --port registers an already-running app.
Use --local to bypass a Compose file. Local apps are never started or stopped.
New previews expire after 30 minutes (macOS launchd; checked every minute).
Elsewhere, pass --ttl never and remove previews with tunnel down.
--disposable deletes Compose volumes on teardown; otherwise data is retained.
Repeat --service, --profile, or --url-env; URL variables apply before Compose starts.
setup saves configuration; up starts the shared proxy automatically.
Requires Bun and running Docker with Compose. No public relay or access control.`;

type FlagKind = "value" | "list" | "switch";

function parseFlags(args: readonly string[], spec: Record<string, FlagKind>) {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const kind = spec[arg];
    if (!kind) {
      if (arg.startsWith("-")) throw new Error(`unexpected argument: ${arg}`);
      positional.push(arg);
    } else if (kind === "switch") {
      flags.set(arg, []);
    } else {
      const value = args[++i];
      if (value === undefined || value.startsWith("-")) throw new Error(`${arg} requires a value`);
      if (kind === "value" && flags.has(arg)) throw new Error(`${arg} given twice`);
      flags.set(arg, [...(flags.get(arg) ?? []), value]);
    }
  }
  return {
    positional,
    has: (flag: string) => flags.has(flag),
    value: (flag: string): string | undefined => flags.get(flag)?.[0],
    list: (flag: string): string[] => flags.get(flag) ?? [],
  };
}

// Names are persisted and re-applied on every up, so stored ones are checked too.
function checkEnvName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid environment variable name: ${name}`);
  if (["PATH", "HOME"].includes(name) || /^(DOCKER|COMPOSE)_/.test(name)) {
    throw new Error(`--url-env cannot override ${name}; it controls Docker or the shell`);
  }
  return name;
}

const union = (...lists: (readonly string[] | undefined)[]) => [...new Set(lists.flatMap((list) => list ?? []))];

async function up(config: Config, args: string[]): Promise<void> {
  const flags = parseFlags(args, {
    "--name": "value", "--port": "value", "--target": "value", "--ttl": "value",
    "--build": "switch", "--local": "switch", "--disposable": "switch",
    "--service": "list", "--profile": "list", "--url-env": "list",
  });
  if (flags.positional.length > 1) throw new Error(`unexpected argument: ${flags.positional[1]}`);
  const dir = resolve(flags.positional[0] ?? process.cwd());
  const all = readMappings(config);
  const sameDir = all.filter((mapping) => mapping.dir === dir);
  if (!flags.has("--name") && sameDir.length > 1) throw new Error("multiple tunnels serve this directory; specify --name");
  // Repeating up in a directory reuses its name; otherwise a short random one, e.g. "9f3ab1".
  const name = flags.value("--name") ?? sameDir[0]?.name ?? randomBytes(3).toString("hex");
  if (name.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("invalid tunnel name");
  // Preview projects are tunnel-<name>; the shared proxy's project is tunnel-proxy-<hash>.
  if (name === "proxy" || name.startsWith("proxy-")) throw new Error("names starting with proxy are reserved for the shared proxy");
  const url = origin(config, name);
  const existing = all.find((mapping) => mapping.name === name);
  if (existing && existing.dir !== dir) throw new Error(`${name}.${config.domain} already serves ${existing.dir}`);
  if (!existing && existsSync(sitePath(config, name))) throw new Error("hostname already registered outside tunnel; refusing to overwrite");
  if (existing?.url && existing.url !== url) throw new Error("configuration changed; restore it and remove the old tunnel before re-registering");

  const explicitPort = flags.value("--port");
  if (explicitPort) validatePort(explicitPort);
  const explicitTarget = flags.value("--target");
  if (explicitTarget) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*:\d+$/.test(explicitTarget)) throw new Error("--target must be SERVICE:CONTAINER_PORT");
    validatePort(explicitTarget.split(":")[1]!);
  }
  if (explicitPort && explicitTarget) throw new Error("use either --port or --target, not both");
  // A repeated up keeps the previous selection unless a new --port or --target replaces it.
  const port = explicitPort ?? (explicitTarget ? undefined : existing?.mode === "local" ? existing.port : existing?.fixedPort);
  const target = port ? undefined : explicitTarget ?? existing?.target;

  const file = COMPOSE_FILES.map((candidate) => join(dir, candidate)).find(existsSync);
  const local = flags.has("--local") || (!file && !!port) || existing?.mode === "local";
  const mode = local ? "local" : "compose";
  if (existing && (existing.mode ?? "compose") !== mode) throw new Error("remove the existing tunnel before changing its mode");
  if (existing && flags.has("--disposable") && !existing.disposable) {
    throw new Error("--disposable is fixed when a preview is created; remove the preview to change it");
  }
  const disposable = flags.has("--disposable") || !!existing?.disposable;
  const services = union(existing?.services, flags.list("--service"));
  const profiles = union(existing?.profiles, flags.list("--profile"));
  const urlEnv = union(existing?.urlEnv, flags.list("--url-env")).map(checkEnvName);
  if (local) {
    if (!port || flags.has("--build")) throw new Error("local apps require --port and cannot use --build");
    if (target || disposable || services.length || profiles.length || urlEnv.length) throw new Error("Compose options cannot be used with --local");
  } else if (!file) {
    throw new Error("no Compose file found; use --port to route an already-running local app");
  }

  // New previews get the default lease. Repeating up renews a lease (never shortening it) but
  // leaves a preview without expiry alone; --ttl always sets the lease explicitly. The lease runs
  // from when the preview is ready, so a slow build does not eat into it.
  const ttl = flags.has("--ttl") ? parseTTL(flags.value("--ttl")!) : undefined;
  const leaseFrom = (now: number) => {
    if (ttl !== undefined) return ttl ? now + ttl : undefined;
    if (!existing) return now + DEFAULT_TTL;
    return existing.expiresAt ? Math.max(existing.expiresAt, now + DEFAULT_TTL) : undefined;
  };
  const leased = leaseFrom(Date.now()) !== undefined;
  if (leased) requireExpirySupport();

  const project = local ? undefined : existing?.project ?? `tunnel-${name}`;
  if (project && !existing) {
    // Teardown removes everything labeled with the project, so never adopt anything already there,
    // including volumes retained from an earlier preview (inspect or remove those by hand).
    const found = projectResources(project);
    if (found.containers.length || found.networks.length || found.volumes.length) {
      throw new Error(`Docker already has resources for Compose project ${project} that no preview owns. `
        + `Inspect them with docker ps -a, docker network ls and docker volume ls using --filter label=com.docker.compose.project=${project}, or choose another --name`);
    }
  }

  // Validation is done; from here on, Docker and launchd change.
  if (leased) installReaperFor(config, all);
  ensureProxy(config);
  // A provisional lease, so a crash during startup still expires the half-started preview.
  const mapping: Mapping = {
    name, dir, port: port ?? "", mode, project, url, expiresAt: leaseFrom(Date.now()), disposable, services, profiles, urlEnv, target,
    fixedPort: local ? undefined : port,
  };
  // Record a new preview before starting it, so after a crash down or cleanup can still remove it.
  if (!existing) saveMapping(config, mapping);
  try {
    // The prior host port may be reassigned when Compose recreates containers. Stop routing to it
    // until the current stack's port has been resolved and registered successfully.
    if (existing) removeSite(config, name);
    let hostPort = port!;
    if (!local) {
      const files = [file!, overrideFile(file!)].filter(existsSync);
      const env: Env = Object.fromEntries(urlEnv.map((key) => [key, url]));
      const baseWith = (files: string[]) => ["--project-name", project!, ...files.flatMap((f) => ["--file", f]),
        ...profiles.flatMap((profile) => ["--profile", profile])];
      // A --port selection names a fixed host port, so only then are pinned ports kept.
      const override = previewOverride(baseWith(files), env, { keepPorts: !!port });
      const path = overridePath(config, name);
      if (override) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, override);
        files.push(path);
      } else {
        rmSync(path, { force: true }); // Left by an earlier up whose stack needed one.
      }
      const base = baseWith(files);
      compose([...base, "up", "-d", ...(flags.has("--build") ? ["--build"] : []), ...services], env);
      hostPort = target ? publishedPort(base, target, env) : await choosePort(publishedPorts(base, env), port);
    }
    registerSite(config, name, hostPort);
    const ready = Date.now();
    const expiresAt = leaseFrom(ready);
    saveMapping(config, { ...mapping, port: hostPort, expiresAt });
    console.log(`${url} -> ${dir} (port ${hostPort})`);
    console.log(`stop it: tunnel down ${name}; ${expiresAt ? `expires in ${Math.round((expiresAt - ready) / 60_000)} minutes` : "no expiry"}`);
  } catch (error) {
    // A failed restart keeps the existing record, unrouted, for a retried up or down.
    if (!existing) {
      try { teardown(config, mapping); }
      catch (rollback) { throw new Error(`${(error as Error).message}; rollback failed: ${(rollback as Error).message}; retry with tunnel down ${name}`); }
    }
    throw error;
  }
}

// The job tears previews down with the configuration baked in now, so refuse to rewrite it while a
// leased preview was registered under another one (for example before an IP change).
function installReaperFor(config: Config, mappings: Mapping[]): void {
  const stranded = mappings.filter((mapping) => mapping.expiresAt && mapping.url && mapping.url !== origin(config, mapping.name));
  if (stranded.length) {
    throw new Error(`leased preview ${stranded[0]!.name} uses ${stranded[0]!.url}, which this configuration cannot remove; `
      + `restore the configuration it was created with (for example TUNNEL_PROXY_IP) and run tunnel down ${stranded[0]!.name}`);
  }
  installReaper(config);
}

async function choosePort(ports: string[], requested: string | undefined): Promise<string> {
  if (requested) {
    if (!ports.includes(requested)) throw new Error("requested port is not published by this stack");
    return requested;
  }
  if (ports.length === 1) return ports[0]!;
  // Stacks often publish databases beside the app; route to the only port that speaks HTTP.
  const http = ports.length ? await httpPorts(ports) : [];
  if (http.length === 1) return http[0]!;
  throw new Error(`expected one published port, found ${ports.length}${http.length ? ` (${http.length} answer HTTP)` : ""}; `
    + "select one with --target SERVICE:PORT or --port");
}

// Apps may still be booting after compose up, so keep probing until one answers or time runs out.
async function httpPorts(ports: string[]): Promise<string[]> {
  const deadline = Date.now() + Number(process.env.TUNNEL_PROBE_MS || 30_000);
  const answers = async (port: string) => {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual", signal: AbortSignal.timeout(2000) });
      return true;
    } catch { return false; }
  };
  for (;;) {
    const results = await Promise.all(ports.map(answers));
    const found = ports.filter((_, i) => results[i]);
    if (found.length || Date.now() >= deadline) return found;
    await Bun.sleep(500);
  }
}

// Borrowed local apps are never stopped; only their route goes.
function teardown(config: Config, mapping: Mapping): void {
  if (mapping.mode !== "local") {
    if (!mapping.project) throw new Error("Compose mapping is missing its project");
    removeProject(mapping.project, { volumes: !!mapping.disposable });
    rmSync(overridePath(config, mapping.name), { force: true });
  }
  removeSite(config, mapping.name);
  deleteMapping(config, mapping.name);
}

function down(config: Config, args: string[]): void {
  if (args.length > 1 || args[0]?.startsWith("-")) throw new Error("usage: tunnel down [name|dir]");
  const target = args[0] ?? process.cwd();
  const all = readMappings(config);
  const exact = all.find((mapping) => mapping.name === target);
  const candidates = exact ? [exact] : all.filter((mapping) => mapping.dir === resolve(target));
  if (candidates.length > 1) throw new Error("multiple tunnels serve this directory; specify a name");
  const mapping = candidates[0];
  if (!mapping) throw new Error(`nothing running for ${target}`);
  if (mapping.url && mapping.url !== origin(config, mapping.name)) {
    throw new Error("configuration changed; restore the original domain and proxy port before removing this tunnel");
  }
  teardown(config, mapping);
  console.log(`tunnel: ${mapping.name} removed${mapping.mode === "local" ? " (local app left running)" : ""}`);
}

const expired = (mapping: Mapping) => !!mapping.expiresAt && mapping.expiresAt <= Date.now();

function cleanup(config: Config): void {
  for (const mapping of readMappings(config).filter(expired)) {
    try { down(config, [mapping.name]); }
    catch (error) {
      console.error(`tunnel: ${mapping.name} expired but teardown failed; retrying next run: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }
}

function extend(config: Config, args: string[]): void {
  if (!args[0] || args.length > 2) throw new Error("usage: tunnel extend NAME [30m|never]");
  const all = readMappings(config);
  const mapping = all.find((m) => m.name === args[0]);
  if (!mapping) throw new Error(`unknown tunnel name: ${args[0]}`);
  const ttl = parseTTL(args[1] ?? "30m");
  if (ttl) {
    requireExpirySupport();
    installReaperFor(config, [...all, { ...mapping, expiresAt: Date.now() + ttl }]);
  }
  saveMapping(config, { ...mapping, expiresAt: ttl ? Date.now() + ttl : undefined });
  console.log(`tunnel: ${mapping.name} ${ttl ? `expires in ${ttl / 60_000} minutes` : "will not expire"}`);
}

function ls(config: Config): void {
  for (const mapping of readMappings(config)) {
    const expiry = mapping.expiresAt ? `expires ${new Date(mapping.expiresAt).toISOString()}` : "no expiry";
    console.log(`${mapping.url || origin(config, mapping.name)}\t${mapping.dir} (port ${mapping.port || "starting"}, ${mapping.mode || "compose"}; ${expiry})`);
  }
}

function setup(args: string[]): void {
  const keys: Record<string, keyof Settings> = { "--ip": "ip", "--domain": "domain", "--port": "port", "--bind": "bind", "--dns": "dns", "--state-dir": "stateDir" };
  const flags = parseFlags(args, Object.fromEntries(Object.keys(keys).map((flag) => [flag, "value" as const])));
  if (flags.positional.length) throw new Error(`invalid setup option: ${flags.positional[0]}`);
  const saved = savedSettings();
  const next: Settings = { ...saved };
  for (const [flag, key] of Object.entries(keys)) {
    const value = flags.value(flag);
    if (value === undefined) continue;
    Object.assign(next, { [key]: key === "domain" && value === "auto" ? undefined : key === "stateDir" ? resolve(value) : value });
  }
  // Detect the address at most once, so before/after comparisons cannot differ by detection alone.
  // When detection is ambiguous, `--ip` is how the user resolves it, so fall back to that.
  let detected: string | undefined;
  const detect = () => { try { return detectIP(); } catch { return next.ip; } };
  const withIP = (value: Settings): Settings => value.ip ? value : { ...value, ip: (detected ??= detect()) };
  const before = { effective: settings(withIP(saved)), saved: settings(withIP(saved), {}) };
  // Saved values are validated even when the environment masks them.
  const after = { effective: settings(withIP(next)), saved: settings(withIP(next), {}) };
  // Never silently rewrite active routes when changing persistent configuration.
  const changed = (a: Config, b: Config) => (["domain", "ip", "port", "bind", "dns", "stateDir"] as const).some((key) => a[key] !== b[key]);
  if (readMappings(before.effective).length && (changed(before.effective, after.effective) || changed(before.saved, after.saved))) {
    throw new Error("active mappings exist; remove them with the old configuration before changing setup");
  }
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configFile, `${JSON.stringify(next, null, 2)}\n`);
  const resolved = after.effective;
  console.log(`Saved ${configFile}\nURLs: ${origin(resolved, "app")}\nBind: ${resolved.bind}:${resolved.port}; DNS: ${resolved.dns}`);
  if (resolved.dns === "split") console.log(`Configure a restricted nameserver for ${resolved.domain} pointing to ${resolved.ip}.`);
  else if (next.domain) console.log(`Configure wildcard DNS for *.${resolved.domain} pointing to ${resolved.ip}.`);
  console.log("Run tunnel up to start the proxy. Docker and Bun must already be installed.");
}

async function doctor(config: Config): Promise<void> {
  let failures = 0;
  async function check(label: string, fn: () => unknown | Promise<unknown>) {
    try { const detail = await fn(); console.log(`OK ${label}${detail ? `: ${detail}` : ""}`); }
    catch (error) { failures++; console.log(`FAIL ${label}: ${(error as Error).message}`); }
  }
  await check("Docker", () => sh("docker", ["info", "--format", "{{.ServerVersion}}"]));
  await check("Compose", () => compose(["version", "--short"]));
  await check("Proxy", () => { const name = proxyContainer(config); if (!name) throw new Error("not running; use tunnel up"); return name; });
  const host = `tunnel-doctor.${config.domain}`;
  await check("Wildcard DNS", async () => {
    const addresses = await lookup(host, { family: 4, all: true });
    if (!addresses.some((entry) => entry.address === config.ip)) throw new Error(`${host} does not resolve to ${config.ip}`);
    return `${host} -> ${config.ip}`;
  });
  for (const mapping of readMappings(config)) {
    await check(mapping.name, async () => {
      if (mapping.url && mapping.url !== origin(config, mapping.name)) throw new Error("mapping uses a different domain or proxy port");
      const site = sitePath(config, mapping.name);
      if (!existsSync(site) || !readFileSync(site, "utf8").includes(`host.docker.internal:${mapping.port}`)) throw new Error("missing or mismatched site file");
      const response = await fetch(mapping.url || origin(config, mapping.name), { signal: AbortSignal.timeout(5000), redirect: "manual" });
      await response.body?.cancel();
      if (response.status >= 400) throw new Error(`HTTP ${response.status} (authenticated apps may require manual verification)`);
      return `HTTP ${response.status}`;
    });
  }
  console.log(`Network: ${config.ip}; bind ${config.bind}:${config.port}. DNS is not access control.`);
  if (failures) process.exitCode = 1;
}

async function main([command, ...args]: string[]): Promise<void> {
  if (command === "--skill") {
    console.log(readFileSync(join(import.meta.dir, "skills/tunnel-preview/SKILL.md"), "utf8"));
    return;
  }
  if (!command || command === "--help" || command === "help") {
    console.log(HELP);
    return;
  }
  if (!["up", "down", "ls", "doctor", "cleanup", "extend", "setup"].includes(command)) throw new Error(`unknown command: ${command}\n${HELP}`);
  if (command === "ls" || command === "doctor") {
    if (args.length) throw new Error(`${command} takes no arguments`);
    return command === "ls" ? ls(settings()) : doctor(settings());
  }
  // The launchd job runs `cleanup --scheduled`: it only locks when something has expired, and it
  // skips (with a log line) a tick while another command runs. Everything else waits its turn.
  const scheduled = command === "cleanup" && args[0] === "--scheduled";
  if (command === "cleanup" && args.length > (scheduled ? 1 : 0)) throw new Error("cleanup takes no arguments");
  if (scheduled && !readMappings(settings()).some(expired)) return;
  const release = acquireLock({ wait: !scheduled });
  if (!release) return;
  try {
    // Settings are read under the lock, so a concurrent setup cannot leave this command using stale ones.
    if (command === "setup") return setup(args);
    const config = settings();
    if (command === "up") await up(config, args);
    else if (command === "down") down(config, args);
    else if (command === "extend") extend(config, args);
    else cleanup(config);
  } finally { release(); }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`tunnel: ${(error as Error).message}`);
  process.exitCode = 1;
}
