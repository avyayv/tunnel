import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configDir, type Config } from "./config";
import { sh } from "./docker";
import { writeAtomic } from "./state";

export const DEFAULT_TTL = 30 * 60_000;

export function parseTTL(value: string): number {
  if (value === "never") return 0;
  const match = /^(\d+)(m|h)$/.exec(value);
  const ms = match ? Number(match[1]) * (match[2] === "h" ? 3_600_000 : 60_000) : 0;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 7 * 86_400_000) throw new Error("TTL must be 1m–168h, or never");
  return ms;
}

export function requireExpirySupport(): void {
  if (process.platform !== "darwin") {
    throw new Error("automatic expiry requires macOS; pass --ttl never and remove the preview with tunnel down");
  }
}

// One per-user job per state directory runs `tunnel cleanup` every minute and at login, with this
// configuration baked in. It stays loaded; ticks with nothing expired are cheap no-ops.
export function installReaper(config: Config): void {
  const label = `dev.tunnel.cleanup.${createHash("sha256").update(config.stateDir).digest("hex").slice(0, 8)}`;
  const domain = `gui/${process.getuid!()}`;
  const path = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const env: Record<string, string> = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    TUNNEL_CONFIG_DIR: configDir,
    TUNNEL_STATE_DIR: config.stateDir,
    TUNNEL_DOMAIN: config.domain,
    TUNNEL_PROXY_IP: config.ip,
    TUNNEL_PROXY_PORT: config.port,
    TUNNEL_PROXY_BIND: config.bind,
    TUNNEL_DNS: config.dns,
  };
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  const log = join(config.stateDir, "cleanup.log");
  const string = (value: string) => `<string>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</string>`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${string(label)}
  <key>ProgramArguments</key>
  <array>${string(process.execPath)}${string(join(import.meta.dir, "cli.ts"))}${string("cleanup")}</array>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env).map(([key, value]) => `<key>${key}</key>${string(value)}`).join("")}</dict>
  <key>StandardOutPath</key>${string(log)}
  <key>StandardErrorPath</key>${string(log)}
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
  const loaded = () => { try { sh("launchctl", ["print", `${domain}/${label}`]); return true; } catch { return false; } };
  if (existsSync(path) && readFileSync(path, "utf8") === plist && loaded()) return;
  sh("launchctl", ["bootout", `${domain}/${label}`], { quiet: true });
  writeAtomic(path, plist);
  sh("launchctl", ["bootstrap", domain, path]);
}
