import { existsSync, readFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";

export const configDir = resolve(process.env.TUNNEL_CONFIG_DIR || join(homedir(), ".config", "tunnel"));
export const configFile = join(configDir, "config.json");

// What `tunnel setup` saves. Environment variables override each field.
export interface Settings {
  domain?: string;
  ip?: string;
  port?: string;
  bind?: string;
  dns?: "external" | "split";
  stateDir?: string;
  worktrees?: string;
}

export function savedSettings(): Settings {
  return existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
}

// Where `tunnel new` puts worktrees. Needs no network settings, so worktrees work before setup.
export function worktreeRoot(saved = savedSettings(), env = process.env): string {
  return resolve(env.TUNNEL_WORKTREES?.trim() || saved.worktrees || join(homedir(), ".worktrees"));
}

export function detectIP(): string {
  if (Bun.which("tailscale")) {
    const result = Bun.spawnSync(["tailscale", "ip", "-4"], { stdout: "pipe", stderr: "pipe" });
    const ip = result.stdout.toString().trim();
    if (result.exitCode === 0 && isIPv4(ip)) return ip;
  }
  const ips = new Set(Object.values(networkInterfaces()).flatMap((addresses) => (addresses ?? [])
    .filter((address) => !address.internal && address.family === "IPv4" && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address))
    .map((address) => address.address)));
  if (ips.size === 1) return [...ips][0]!;
  throw new Error("could not select a reachable IPv4 address; run tunnel setup --ip <tailnet-or-LAN-IP>");
}

export function parsePort(value: string, what = "port"): number {
  const port = /^\d+$/.test(value) ? Number(value) : 0;
  if (port < 1 || port > 65535) throw new Error(`invalid ${what}: ${value}`);
  return port;
}

// "90s", "30m" or "2h", in milliseconds.
export function parseDuration(value: string, what: string, { min = 1, max = Infinity } = {}): number {
  const match = /^(\d+)(s|m|h)$/.exec(value);
  const ms = match ? Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[match[2] as "s" | "m" | "h"] : NaN;
  if (!(ms >= min && ms <= max)) throw new Error(`invalid ${what}: ${value}`);
  return ms;
}

export function settings(saved = savedSettings(), env = process.env) {
  const ip = env.TUNNEL_PROXY_IP?.trim() || saved.ip || detectIP();
  const domain = env.TUNNEL_DOMAIN?.trim() || saved.domain || `${ip}.nip.io`;
  const port = env.TUNNEL_PROXY_PORT?.trim() || saved.port || "8000";
  const bind = env.TUNNEL_PROXY_BIND?.trim() || saved.bind || "0.0.0.0";
  const dns = env.TUNNEL_DNS?.trim() || saved.dns || "external";
  const stateDir = resolve(env.TUNNEL_STATE_DIR || saved.stateDir || configDir);
  if (!isIPv4(ip)) throw new Error("proxy IP must be an IPv4 address");
  if (!isIPv4(bind)) throw new Error("proxy bind must be an IPv4 address");
  parsePort(port, "proxy port");
  const label = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
  if (domain.length > 253 || !domain.split(".").every((part) => part.length <= 63 && label.test(part))) throw new Error("invalid domain");
  if (dns !== "external" && dns !== "split") throw new Error("DNS mode must be external or split");
  return { ip, domain, port, bind, dns, stateDir };
}

export type Config = ReturnType<typeof settings>;

// Everything tunnel records for a configuration lives under here.
export const stateRoot = (config: Config) => join(config.stateDir, "dev-proxy");

export const origin = (config: Config, name: string) =>
  `http://${name}.${config.domain}${config.port === "80" ? "" : `:${config.port}`}`;
