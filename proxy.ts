// The shared Caddy proxy: one container per configuration, routing <name>.<domain> to a host
// port through one site file per preview.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configDir, stateRoot, type Config } from "./config";
import { sh } from "./sh";

const PROXY_FILE = join(import.meta.dir, "compose.yaml");
const PROXY_PROJECT = `tunnel-proxy-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;

export const sitesDir = (config: Config) => join(stateRoot(config), "sites");
export const sitePath = (config: Config, name: string) => join(sitesDir(config), `${name}.caddy`);
const siteFile = (config: Config, name: string, port: number) =>
  `http://${name}.${config.domain} {\n\treverse_proxy host.docker.internal:${port}\n}\n`;

// The running Caddy that publishes the proxy port. Another installation's Caddy there is an
// error, never reused.
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
  sh("docker", ["compose", "--project-name", PROXY_PROJECT, "--file", PROXY_FILE, "up", "-d", "--wait", "--wait-timeout", "45", ...services], {
    env: {
      TUNNEL_DOMAIN: config.domain,
      TUNNEL_PROXY_IP: config.ip,
      TUNNEL_PROXY_PORT: config.port,
      TUNNEL_PROXY_BIND: config.bind,
      TUNNEL_PROXY_SITES: sitesDir(config),
    },
  });
}

// Whether the proxy routes `name` to `port`.
export const routes = (config: Config, name: string, port: number | undefined) =>
  port !== undefined && existsSync(sitePath(config, name)) && readFileSync(sitePath(config, name), "utf8") === siteFile(config, name, port);

// The status and start of the body the app returns through the proxy for its hostname, asked
// of the proxy directly so DNS plays no part, following redirects within the app (like
// Jupyter's / to /lab); undefined if the proxy did not answer.
export async function askThroughProxy(config: Config, name: string): Promise<{ status: number; body: string } | undefined> {
  const address = config.bind === "0.0.0.0" ? "127.0.0.1" : config.bind;
  const host = `${name}.${config.domain}`;
  let path = "/";
  try {
    for (let hops = 0; ; hops++) {
      const response = await fetch(`http://${address}:${config.port}${path}`, { headers: { Host: host }, redirect: "manual", signal: AbortSignal.timeout(5000) });
      const location = response.headers.get("location");
      const next = location && new URL(location, `http://${host}${path}`);
      if (hops < 3 && response.status >= 300 && response.status < 400 && next && next.host.split(":")[0] === host) {
        await response.body?.cancel();
        path = next.pathname + next.search;
        continue;
      }
      return { status: response.status, body: (await response.text()).slice(0, 2000) };
    }
  } catch { return undefined; }
}

export const registerSite = (config: Config, name: string, port: number) => changeSite(config, name, port);
export const removeSite = (config: Config, name: string) => changeSite(config, name, undefined);

// Writes, or with no port removes, a route; the old file returns if Caddy rejects the change.
function changeSite(config: Config, name: string, port: number | undefined): void {
  const path = sitePath(config, name);
  const previous = existsSync(path) ? readFileSync(path) : undefined;
  if (port === undefined) {
    if (!previous) return;
    rmSync(path);
  } else {
    mkdirSync(sitesDir(config), { recursive: true });
    writeFileSync(path, siteFile(config, name, port));
  }
  try {
    const caddy = proxyContainer(config);
    if (!caddy) throw new Error("the proxy Caddy is not running");
    sh("docker", ["exec", caddy, "caddy", "reload", "--config", "/etc/caddy/Caddyfile"]);
  } catch (error) {
    if (previous) writeFileSync(path, previous);
    else rmSync(path, { force: true });
    throw error;
  }
}
