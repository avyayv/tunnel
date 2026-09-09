#!/usr/bin/env bun
import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { configDir, configFile, savedSettings, settings, validatePort, type Config, type Settings } from "./config";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

let config: Config;
let SITES_DIR: string;
let MAPPINGS_DIR: string;
const PROXY_PROJECT = `tunnel-proxy-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;

function configure(value = settings()): void {
  config = value;
  SITES_DIR = join(config.stateDir, "dev-proxy", "sites");
  MAPPINGS_DIR = join(config.stateDir, "dev-proxy", "mappings");
}
const PROXY_FILE = join(import.meta.dir, "compose.yaml");
const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

interface Mapping {
  readonly name: string;
  readonly project?: string;
  readonly dir: string;
  readonly port: string;
  readonly mode?: "compose" | "local";
  readonly url?: string;
  readonly file?: string;
}

function sh(
  command: string,
  args: string[],
  { quiet = false, env }: { quiet?: boolean; env?: Record<string, string | undefined> } = {},
): string {
  const child = Bun.spawnSync([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : process.env,
  });
  const out = child.stdout.toString().trim();
  if (child.exitCode !== 0 && !quiet) {
    const error = child.stderr.toString().trim() || out || `${command} exited ${child.exitCode}`;
    throw new Error(error);
  }
  return out;
}

function compose(
  args: readonly string[],
  { quiet = false, env }: { quiet?: boolean; env?: Record<string, string | undefined> } = {},
): string {
  return sh("docker", ["compose", ...args], { quiet, env });
}

function composeFileOf(dir: string): string {
  const file = COMPOSE_FILES.map((name) => join(dir, name)).find((path) => existsSync(path));
  if (!file) {
    console.error(`tunnel: no compose file in ${dir}`);
    process.exit(1);
  }
  return file;
}

function mappings(): Mapping[] {
  if (!existsSync(MAPPINGS_DIR)) return [];
  return readdirSync(MAPPINGS_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(MAPPINGS_DIR, file), "utf8")) as Mapping);
}

function origin(name: string): string {
  return `http://${name}.${config.domain}${config.port === "80" ? "" : `:${config.port}`}`;
}

function proxyContainer(): string | undefined {
  const rows = sh("docker", ["ps", "--filter", "name=caddy", "--filter", "status=running", "--format", "{{json .}}"]);
  const candidates = rows.split("\n").filter(Boolean).map((row) => JSON.parse(row))
    .filter((row) => String(row.Ports).includes(`:${config.port}->80/tcp`));
  if (candidates.length > 1) throw new Error("multiple Caddy containers own the proxy port");
  if (!candidates[0]) return undefined;
  const name = candidates[0].Names;
  const mounts = JSON.parse(sh("docker", ["inspect", name, "--format", "{{json .Mounts}}"]));
  if (!mounts.some((mount: { Source: string; Destination: string }) =>
    resolve(mount.Source) === resolve(SITES_DIR) && mount.Destination === "/etc/caddy/sites")) {
    throw new Error("proxy port belongs to a Caddy with a different sites directory");
  }
  return name;
}

function reloadProxy(): void {
  const caddy = proxyContainer();
  if (!caddy) throw new Error("the proxy Caddy is not running");
  sh("docker", ["exec", caddy, "caddy", "reload", "--config", "/etc/caddy/Caddyfile"]);
}

function ensureProxy(): void {
  if (proxyContainer()) return;
  mkdirSync(SITES_DIR, { recursive: true });
  compose(["--project-name", PROXY_PROJECT, "--file", PROXY_FILE, "up", "-d", "--wait", "--wait-timeout", "45", "caddy",
    ...(config.dns === "split" ? ["dns"] : [])], {
    env: {
      TUNNEL_DOMAIN: config.domain,
      TUNNEL_PROXY_IP: config.ip,
      TUNNEL_PROXY_PORT: config.port,
      TUNNEL_PROXY_BIND: config.bind,
      TUNNEL_PROXY_SITES: SITES_DIR,
    },
  });
}

function registerSite(name: string, port: string): void {
  mkdirSync(SITES_DIR, { recursive: true });
  const path = join(SITES_DIR, `${name}.caddy`);
  const previous = existsSync(path) ? readFileSync(path) : undefined;
  writeFileSync(
    path,
    `http://${name}.${config.domain} {\n\treverse_proxy host.docker.internal:${port}\n}\n`,
  );
  try {
    reloadProxy();
  } catch (error) {
    if (previous) writeFileSync(path, previous);
    else rmSync(path, { force: true });
    throw error;
  }
}

function publishedPorts(project: string, file: string): string[] {
  const rows = compose(
    ["--project-name", project, "--file", file, "ps", "--format", "json"],
  );
  const ports = new Set<string>();
  const containers = rows.trim().startsWith("[") ? JSON.parse(rows) : rows.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  for (const container of containers) {
    for (const publisher of (container.Publishers ?? []) as { PublishedPort: number }[]) {
      if (publisher.PublishedPort > 0) ports.add(String(publisher.PublishedPort));
    }
  }
  return [...ports];
}

async function up(args: string[]): Promise<void> {
  let name = "";
  let port = "";
  let build = false;
  let local = false;
  let dir = process.cwd();
  let hasDir = false;
  const rest = [...args];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === "--name" || arg === "--port") {
      const value = rest.shift();
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--name") name = value;
      else port = value;
    } else if (arg === "--build") build = true;
    else if (arg === "--local") local = true;
    else if (arg?.startsWith("-") || hasDir) throw new Error(`unexpected argument: ${arg}`);
    else if (arg !== undefined) { dir = resolve(arg); hasDir = true; }
  }
  name = name || mappings().find((mapping) => mapping.dir === dir)?.name || randomBytes(3).toString("hex"); // e.g. "9f3ab1"; short, random, disposable
  if (name.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("invalid tunnel name");
  if (port) validatePort(port);
  const existing = mappings().find((mapping) => mapping.name === name);
  if (existing && existing.dir !== dir) {
    console.error(`tunnel: ${name}.${config.domain} already serves ${existing.dir}`);
    process.exit(1);
  }
  if (!existing && existsSync(join(SITES_DIR, `${name}.caddy`))) throw new Error("hostname already registered outside tunnel; refusing to overwrite");
  const file = COMPOSE_FILES.map((name) => join(dir, name)).find(existsSync);
  local = local || (!file && !!port) || existing?.mode === "local";
  const mode = local ? "local" : "compose";
  if (existing && (existing.mode || "compose") !== mode) throw new Error("remove the existing tunnel before changing its mode");
  if (existing?.url && existing.url !== origin(name)) throw new Error("configuration changed; restore it and remove the old tunnel before re-registering");
  if (local && (build || !port)) throw new Error("local apps require --port and cannot use --build");
  if (!local && !file) throw new Error("no Compose file found; use --port to route an already-running local app");
  ensureProxy();
  let target = port;
  const project = local ? undefined : `tunnel-${name}`;
  if (project && file) {
    compose(["--project-name", project, "--file", file, "up", "-d", ...(build ? ["--build"] : [])]);
    const ports = publishedPorts(project, file);
    if (port && !ports.includes(port)) throw new Error("requested port is not published by this stack");
    if (!port && ports.length !== 1) throw new Error(`expected one published port, found ${ports.length}; select one with --port`);
    target = port || ports[0]!;
  }
  registerSite(name, target);
  mkdirSync(MAPPINGS_DIR, { recursive: true });
  writeFileSync(
    join(MAPPINGS_DIR, `${name}.json`),
    `${JSON.stringify({ name, project, dir, port: target, mode, url: origin(name), file: local ? undefined : file }, null, 2)}\n`,
  );
  console.log(`${origin(name)} -> ${dir} (port ${target})`);
  console.log(`stop it: tunnel down ${name}`);
}

function down(args: string[]): void {
  if (args.length > 1 || args[0]?.startsWith("-")) throw new Error("usage: tunnel down [name|dir]");
  const target = args[0] ?? process.cwd();
  const absolute = resolve(target);
  const all = mappings();
  const exact = all.find((m) => m.name === target);
  const candidates = exact ? [exact] : all.filter((m) => m.dir === absolute);
  if (candidates.length > 1) throw new Error("multiple tunnels serve this directory; specify a name");
  const mapping = candidates[0];
  if (!mapping) {
    console.error(`tunnel: nothing running for ${target}`);
    process.exit(1);
  }
  if (mapping.url && mapping.url !== origin(mapping.name)) throw new Error("configuration changed; restore the original domain and proxy port before removing this tunnel");
  if (mapping.mode !== "local") {
    if (!mapping.project) throw new Error("Compose mapping is missing its project");
    compose(["--project-name", mapping.project, "--file", mapping.file || composeFileOf(mapping.dir), "down"]);
  }
  const path = join(SITES_DIR, `${mapping.name}.caddy`);
  const previous = existsSync(path) ? readFileSync(path) : undefined;
  rmSync(path, { force: true });
  try { reloadProxy(); } catch (error) {
    if (previous) writeFileSync(path, previous);
    throw error;
  }
  rmSync(join(MAPPINGS_DIR, `${mapping.name}.json`), { force: true });
  console.log(`tunnel: ${mapping.name} removed${mapping.mode === "local" ? " (local app left running)" : ""}`);
}

function ls(): void {
  for (const mapping of mappings()) {
    console.log(`${mapping.url || origin(mapping.name)}\t${mapping.dir} (port ${mapping.port}, ${mapping.mode || "compose"})`);
  }
}

const HELP = `usage: tunnel up [--name NAME] [--port PORT] [--build] [--local] [dir]
       tunnel down [name|dir]
       tunnel ls
       tunnel setup [--ip IPV4] [--domain DOMAIN|auto] [--port PORT]
                    [--bind IPV4] [--dns external|split] [--state-dir DIR]
       tunnel doctor
       tunnel --skill
       tunnel --help

Without a Compose file, --port registers an already-running app.
Use --local to bypass a Compose file. Local apps are never started or stopped.
setup saves configuration; up starts the shared proxy automatically.
Requires Bun and running Docker with Compose. No public relay or access control.`;

function setup(args: string[]): void {
  const saved = savedSettings();
  const next: Settings = { ...saved };
  const keys: Record<string, keyof Settings> = { "--ip": "ip", "--domain": "domain", "--port": "port", "--bind": "bind", "--dns": "dns", "--state-dir": "stateDir" };
  while (args.length) {
    const arg = args.shift()!;
    const key = keys[arg];
    const value = args.shift();
    if (!key || !value || value.startsWith("--")) throw new Error(`invalid setup option: ${arg}`);
    Object.assign(next, { [key]: key === "domain" && value === "auto" ? undefined : key === "stateDir" ? resolve(value) : value });
  }
  const nextSaved = settings(next, {}); // Validate even values masked by environment overrides.
  const previousSaved = settings({ ...saved, ip: saved.ip || nextSaved.ip }, {});
  const resolved = settings(next);
  configure(resolved);
  // Never silently rewrite active routes when changing persistent configuration.
  const oldState = settings({ ...saved, ip: saved.ip || resolved.ip });
  const oldMappings = join(oldState.stateDir, "dev-proxy", "mappings");
  if (existsSync(oldMappings) && readdirSync(oldMappings).some((name) => name.endsWith(".json")) &&
      ["domain", "ip", "port", "bind", "dns", "stateDir"].some((key) =>
        oldState[key as keyof Config] !== resolved[key as keyof Config] ||
        previousSaved[key as keyof Config] !== nextSaved[key as keyof Config])) {
    throw new Error("active mappings exist; remove them with the old configuration before changing setup");
  }
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configFile, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Saved ${configFile}\nURLs: ${origin("app")}\nBind: ${resolved.bind}:${resolved.port}; DNS: ${resolved.dns}`);
  if (resolved.dns === "split") console.log(`Configure a restricted nameserver for ${resolved.domain} pointing to ${resolved.ip}.`);
  else if (next.domain) console.log(`Configure wildcard DNS for *.${resolved.domain} pointing to ${resolved.ip}.`);
  console.log("Run tunnel up to start the proxy. Docker and Bun must already be installed.");
}

async function doctor(): Promise<void> {
  let failures = 0;
  async function check(label: string, fn: () => unknown | Promise<unknown>) {
    try { const detail = await fn(); console.log(`OK ${label}${detail ? `: ${detail}` : ""}`); }
    catch (error) { failures++; console.log(`FAIL ${label}: ${(error as Error).message}`); }
  }
  await check("Docker", () => sh("docker", ["info", "--format", "{{.ServerVersion}}"]));
  await check("Compose", () => compose(["version", "--short"]));
  await check("Proxy", () => { const name = proxyContainer(); if (!name) throw new Error("not running; use tunnel up"); return name; });
  const host = `tunnel-doctor.${config.domain}`;
  await check("Wildcard DNS", async () => {
    const addresses = await lookup(host, { family: 4, all: true });
    if (!addresses.some((entry) => entry.address === config.ip)) throw new Error(`${host} does not resolve to ${config.ip}`);
    return `${host} -> ${config.ip}`;
  });
  for (const mapping of mappings()) {
    await check(mapping.name, async () => {
      if (mapping.url && mapping.url !== origin(mapping.name)) throw new Error("mapping uses a different domain or proxy port");
      const site = join(SITES_DIR, `${mapping.name}.caddy`);
      if (!existsSync(site) || !readFileSync(site, "utf8").includes(`host.docker.internal:${mapping.port}`)) throw new Error("missing or mismatched site file");
      const response = await fetch(mapping.url || origin(mapping.name), { signal: AbortSignal.timeout(5000), redirect: "manual" });
      await response.body?.cancel();
      if (response.status >= 400) throw new Error(`HTTP ${response.status} (authenticated apps may require manual verification)`);
      return `HTTP ${response.status}`;
    });
  }
  console.log(`Network: ${config.ip}; bind ${config.bind}:${config.port}. DNS is not access control.`);
  if (failures) process.exitCode = 1;
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--skill") console.log(readFileSync(join(import.meta.dir, "skills/tunnel-preview/SKILL.md"), "utf8"));
  else if (!command || command === "--help" || command === "help") console.log(HELP);
  else if (command === "setup") setup(args);
  else {
    if (!["up", "down", "ls", "doctor"].includes(command)) throw new Error(`unknown command: ${command}\n${HELP}`);
    if (["ls", "doctor"].includes(command) && args.length) throw new Error(`${command} takes no arguments`);
    configure();
    if (command === "up") await up(args);
    else if (command === "down") down(args);
    else if (command === "ls") ls();
    else await doctor();
  }
} catch (error) {
  console.error(`tunnel: ${(error as Error).message}`);
  process.exitCode = 1;
}
