import { existsSync, readFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";

export const configDir = resolve(process.env.TUNNEL_CONFIG_DIR || join(homedir(), ".config", "tunnel"));
export const configFile = join(configDir, "config.json");
export interface Settings {
  domain?: string;
  ip?: string;
  port?: string;
  bind?: string;
  dns?: "external" | "split";
  stateDir?: string;
}

export function savedSettings(): Settings {
  return existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
}

export function detectIP(): string {
  if (Bun.which("tailscale")) {
    const result = Bun.spawnSync(["tailscale", "ip", "-4"], { stdout: "pipe", stderr: "pipe" });
    const ip = result.stdout.toString().trim();
    if (result.exitCode === 0 && isIPv4(ip)) return ip;
  }
  const ips = [...new Set(Object.values(networkInterfaces()).flatMap((addresses) =>
    (addresses || []).filter((address) => !address.internal && address.family === "IPv4" &&
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address))
      .map((address) => address.address)))];
  if (ips.length === 1) return ips[0]!;
  throw new Error("could not select a reachable IPv4 address; run tunnel setup --ip <tailnet-or-LAN-IP>");
}

export function validatePort(port: string): void {
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("invalid port");
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
  validatePort(port);
  if (domain.length > 253 || !domain.split(".").every((label) =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) {
    throw new Error("invalid domain");
  }
  if (dns !== "external" && dns !== "split") throw new Error("DNS mode must be external or split");
  return { ip, domain, port, bind, dns, stateDir };
}

export type Config = ReturnType<typeof settings>;
