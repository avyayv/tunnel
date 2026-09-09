#!/usr/bin/env bun
/**
 * tunnel — put any docker compose stack behind a subdomain of this machine.
 *
 *   tunnel up [--name S] [--port N] [--build] [dir]   start the stack in dir; it answers at
 *                                                     http://<name>.<domain>
 *   tunnel down [<name>|dir]                          stop the stack and drop its subdomain
 *   tunnel ls                                         what is running, and where
 *
 * The shared door is the dev proxy: Caddy routes <name>.<domain> to the stack's host port on
 * loopback, CoreDNS answers every name under the domain with this machine's address, and
 * `tunnel up` starts the pair if it is not running. Nothing here is reachable off the tailnet.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const DOMAIN = process.env.TUNNEL_DOMAIN?.trim() || "stack.avyayv.com";
const PROXY_PORT = process.env.TUNNEL_PROXY_PORT?.trim() || "8000";
const CONFIG_DIR = process.env.TUNNEL_CONFIG_DIR?.trim() || join(homedir(), ".selfbench");
const SITES_DIR = join(CONFIG_DIR, "dev-proxy", "sites");
const MAPPINGS_DIR = join(CONFIG_DIR, "dev-proxy", "mappings");
const PROXY_PROJECT = "tunnel-proxy";
const PROXY_FILE = join(import.meta.dir, "compose.yaml");
const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

interface Mapping {
  readonly name: string;
  readonly project: string;
  readonly dir: string;
  readonly port: string;
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
    console.error(`tunnel: ${error}`);
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
  return `http://${name}.${DOMAIN}${PROXY_PORT === "80" ? "" : `:${PROXY_PORT}`}`;
}

function proxyContainer(): string | undefined {
  const rows = sh("docker", ["ps", "--filter", "name=caddy", "--filter", "status=running", "--format", "{{json .}}"]);
  const candidates = rows.split("\n").filter(Boolean).map((row) => JSON.parse(row))
    .filter((row) => String(row.Ports).includes(`:${PROXY_PORT}->80/tcp`));
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
  const ip =
    process.env.TUNNEL_PROXY_IP?.trim() ||
    sh("tailscale", ["ip", "-4"], { quiet: true }) ||
    "";
  if (!ip) throw new Error("set TUNNEL_PROXY_IP: could not discover the tailnet address");
  compose(["--project-name", PROXY_PROJECT, "--file", PROXY_FILE, "up", "-d"], {
    env: {
      ...process.env,
      TUNNEL_DOMAIN: DOMAIN,
      TUNNEL_PROXY_IP: ip,
      TUNNEL_PROXY_PORT: PROXY_PORT,
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
    `http://${name}.${DOMAIN} {\n\treverse_proxy host.docker.internal:${port}\n}\n`,
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
    ["--project-name", project, "--file", file, "ps", "--format", "json", "--all"],
    { quiet: true },
  );
  const ports = new Set<string>();
  for (const line of rows.split("\n").filter(Boolean)) {
    for (const publisher of (JSON.parse(line).Publishers ?? []) as { PublishedPort: number }[]) {
      if (publisher.PublishedPort > 0) ports.add(String(publisher.PublishedPort));
    }
  }
  return [...ports];
}

async function up(args: string[]): Promise<void> {
  let name = "";
  let port = "";
  let build = false;
  let dir = process.cwd();
  const rest = [...args];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === "--name") name = rest.shift() ?? "";
    else if (arg === "--port") port = rest.shift() ?? "";
    else if (arg === "--build") build = true;
    else if (arg !== undefined) dir = resolve(arg);
  }
  name = name || mappings().find((mapping) => mapping.dir === dir)?.name || randomBytes(3).toString("hex"); // e.g. "9f3ab1"; short, random, disposable
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("invalid tunnel name");
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) throw new Error("invalid port");
  const existing = mappings().find((mapping) => mapping.name === name);
  if (existing && existing.dir !== dir) {
    console.error(`tunnel: ${name}.${DOMAIN} already serves ${existing.dir}`);
    process.exit(1);
  }
  const file = composeFileOf(dir);
  if (!existing && existsSync(join(SITES_DIR, `${name}.caddy`))) throw new Error("hostname already registered outside tunnel; refusing to overwrite");
  const project = `tunnel-${name}`;

  compose(["--project-name", project, "--file", file, "up", "-d", ...(build ? ["--build"] : [])]);
  const ports = publishedPorts(project, file);
  if (port && !ports.includes(port)) throw new Error("requested port is not published by this stack");
  if (port === "" && ports.length !== 1) {
    console.error(
      ports.length === 0
        ? `tunnel: ${project} publishes no host port; publish one or pass it with --port`
        : `tunnel: several ports are published (${ports.join(", ")}); pass one with --port`,
    );
    process.exit(1);
  }
  const target = port || ports[0]!;

  ensureProxy();
  registerSite(name, target);
  mkdirSync(MAPPINGS_DIR, { recursive: true });
  writeFileSync(
    join(MAPPINGS_DIR, `${name}.json`),
    `${JSON.stringify({ name, project, dir, port: target }, null, 2)}\n`,
  );
  console.log(`${origin(name)} -> ${dir} (port ${target})`);
  console.log(`stop it: tunnel down ${name}`);
}

function down(args: string[]): void {
  const target = args[0] ?? process.cwd();
  const absolute = resolve(target);
  const mapping = mappings().find((m) => m.dir === absolute || m.name === basename(absolute));
  if (!mapping) {
    console.error(`tunnel: nothing running for ${target}`);
    process.exit(1);
  }
  compose(["--project-name", mapping.project, "--file", composeFileOf(mapping.dir), "down"]);
  rmSync(join(SITES_DIR, `${mapping.name}.caddy`), { force: true });
  reloadProxy();
  rmSync(join(MAPPINGS_DIR, `${mapping.name}.json`), { force: true });
  console.log(`tunnel: ${mapping.name}.${DOMAIN} stopped`);
}

function ls(): void {
  for (const mapping of mappings()) {
    console.log(`${origin(mapping.name)}\t${mapping.dir} (port ${mapping.port})`);
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "up") await up(args);
else if (command === "down") down(args);
else if (command === "ls") ls();
else {
  console.error(
    "usage: tunnel up [--name S] [--port N] [--build] [dir]\n       tunnel down [<name>|dir]\n       tunnel ls",
  );
  process.exit(1);
}
