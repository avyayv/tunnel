import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { configDir, type Config } from "./config";
import { sh } from "./docker";
import { writeAtomic } from "./state";

export const DEFAULT_TTL = 30 * 60_000;

// Everything `tunnel cleanup` loads at runtime, plus the proxy files next to it.
const RUNTIME_FILES = ["cli.ts", "config.ts", "docker.ts", "lease.ts", "proxy.ts", "state.ts", "compose.yaml", "Caddyfile", "Corefile"];

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

// One per-user job per state directory runs `tunnel cleanup --scheduled` every minute and at login,
// with this configuration baked in. It stays loaded; ticks with nothing expired are cheap no-ops.
export function installReaper(config: Config): void {
  const label = `dev.tunnel.cleanup.${createHash("sha256").update(config.stateDir).digest("hex").slice(0, 8)}`;
  const domain = `gui/${process.getuid!()}`;
  const path = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const runtime = installRuntime(config.stateDir);
  // Only settings and Docker's location; never the caller's other environment.
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
  const plistString = (value: string) => `<string>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</string>`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${plistString(label)}
  <key>ProgramArguments</key>
  <array>${[process.execPath, join(runtime, "cli.ts"), "cleanup", "--scheduled"].map(plistString).join("")}</array>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env).map(([key, value]) => `<key>${key}</key>${plistString(value)}`).join("")}</dict>
  <key>StandardOutPath</key>${plistString(log)}
  <key>StandardErrorPath</key>${plistString(log)}
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
  const target = `${domain}/${label}`;
  const loaded = () => { try { sh("launchctl", ["print", target]); return true; } catch { return false; } };
  if (existsSync(path) && readFileSync(path, "utf8") === plist && loaded()) return;
  sh("launchctl", ["bootout", target], { quiet: true });
  // bootout returns before launchd has fully unloaded the job; bootstrapping too early fails with EIO.
  for (let i = 0; i < 50 && loaded(); i++) Bun.sleepSync(100);
  writeAtomic(path, plist);
  for (let attempt = 1; ; attempt++) {
    try { sh("launchctl", ["bootstrap", domain, path]); break; }
    catch (error) { if (attempt === 5) throw error; Bun.sleepSync(500); }
  }
  for (const version of readdirSync(dirname(runtime))) {
    if (version !== basename(runtime)) rmSync(join(dirname(runtime), version), { recursive: true, force: true });
  }
}

// Copies the job's code into the state directory, so deleting the checkout that installed it
// cannot break expiry. Versions are content-addressed and appear atomically.
function installRuntime(stateDir: string): string {
  const files = RUNTIME_FILES.map((name) => [name, readFileSync(join(import.meta.dir, name))] as const);
  const hash = createHash("sha256");
  for (const [name, data] of files) hash.update(name).update("\0").update(data).update("\0");
  const dir = join(stateDir, "runtime", hash.digest("hex").slice(0, 12));
  if (existsSync(dir)) return dir;
  const staged = `${dir}.${process.pid}.tmp`;
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged, { recursive: true });
  for (const [name, data] of files) writeFileSync(join(staged, name), data);
  renameSync(staged, dir);
  return dir;
}
