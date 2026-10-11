import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configDir, type Config } from "./config";
import { compose, sh } from "./docker";
import { sitesDir } from "./state";

const PROXY_FILE = join(import.meta.dir, "compose.yaml");
const PROXY_PROJECT = `tunnel-proxy-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;

export const origin = (config: Config, name: string) =>
  `http://${name}.${config.domain}${config.port === "80" ? "" : `:${config.port}`}`;

export const sitePath = (config: Config, name: string) => join(sitesDir(config), `${name}.caddy`);

// Another installation's Caddy on the proxy port is an error, never reused.
export function proxyContainer(config: Config): string | undefined {
  const rows = sh("docker", ["ps", "--filter", "name=caddy", "--filter", "status=running", "--format", "{{json .}}"]);
  const candidates = rows.split("\n").filter(Boolean).map((row) => JSON.parse(row))
    .filter((row) => String(row.Ports).includes(`:${config.port}->80/tcp`));
  if (candidates.length > 1) throw new Error("multiple Caddy containers own the proxy port");
  if (!candidates[0]) return undefined;
  const name: string = candidates[0].Names;
  const mounts: { Source: string; Destination: string }[] = JSON.parse(sh("docker", ["inspect", name, "--format", "{{json .Mounts}}"]));
  if (!mounts.some((mount) => resolve(mount.Source) === resolve(sitesDir(config)) && mount.Destination === "/etc/caddy/sites")) {
    throw new Error("proxy port belongs to a Caddy with a different sites directory");
  }
  return name;
}

export function ensureProxy(config: Config): void {
  if (proxyContainer(config)) return;
  mkdirSync(sitesDir(config), { recursive: true });
  const services = config.dns === "split" ? ["caddy", "dns"] : ["caddy"];
  compose(["--project-name", PROXY_PROJECT, "--file", PROXY_FILE, "up", "-d", "--wait", "--wait-timeout", "45", ...services], {
    TUNNEL_DOMAIN: config.domain,
    TUNNEL_PROXY_IP: config.ip,
    TUNNEL_PROXY_PORT: config.port,
    TUNNEL_PROXY_BIND: config.bind,
    TUNNEL_PROXY_SITES: sitesDir(config),
  });
}

function reloadProxy(config: Config): void {
  const caddy = proxyContainer(config);
  if (!caddy) throw new Error("the proxy Caddy is not running");
  sh("docker", ["exec", caddy, "caddy", "reload", "--config", "/etc/caddy/Caddyfile"]);
}

// Writes, or with no port removes, a route; the old file returns if Caddy rejects the change.
function changeSite(config: Config, name: string, port: string | undefined): void {
  const path = sitePath(config, name);
  const previous = existsSync(path) ? readFileSync(path) : undefined;
  if (port === undefined) {
    if (!previous) return;
    rmSync(path);
  } else {
    mkdirSync(sitesDir(config), { recursive: true });
    writeFileSync(path, `http://${name}.${config.domain} {\n\treverse_proxy host.docker.internal:${port}\n}\n`);
  }
  try {
    reloadProxy(config);
  } catch (error) {
    if (previous) writeFileSync(path, previous);
    else rmSync(path, { force: true });
    throw error;
  }
}

export const registerSite = (config: Config, name: string, port: string) => changeSite(config, name, port);
export const removeSite = (config: Config, name: string) => changeSite(config, name, undefined);
