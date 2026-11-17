import { lookup } from "node:dns/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { configDir, configFile, detectIP, origin, savedSettings, settings, worktreeRoot, type Config, type Settings } from "./config";
import { running } from "./command";
import { proxyContainer, routes } from "./proxy";
import { errorMessage, sh } from "./sh";
import { readPreviews } from "./state";

// Saves settings, refusing changes that would strand registered previews.
export function setup(changes: Settings): void {
  const saved = savedSettings();
  const next: Settings = { ...saved, ...changes };
  // Detect the address at most once, so before/after comparisons cannot differ by detection alone.
  // When detection is ambiguous, `--ip` is how the user resolves it, so fall back to that.
  let detected: string | undefined;
  const detect = () => { try { return detectIP(); } catch { return next.ip; } };
  const withIP = (value: Settings): Settings => value.ip ? value : { ...value, ip: (detected ??= detect()) };
  const before = { effective: settings(withIP(saved)), saved: settings(withIP(saved), {}) };
  // Saved values are validated even when the environment masks them.
  const after = { effective: settings(withIP(next)), saved: settings(withIP(next), {}) };
  const changed = (a: Config, b: Config) => (["domain", "ip", "port", "bind", "dns", "stateDir"] as const).some((key) => a[key] !== b[key]);
  if (readPreviews(before.effective).length && (changed(before.effective, after.effective) || changed(before.saved, after.saved))) {
    throw new Error("active previews exist; remove them with the old configuration before changing setup");
  }
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configFile, `${JSON.stringify(next, null, 2)}\n`);
  const config = after.effective;
  console.log(`Saved ${configFile}\nURLs: ${origin(config, "app")}\nBind: ${config.bind}:${config.port}; DNS: ${config.dns}`);
  console.log(`Worktrees: ${worktreeRoot(next)}`);
  if (config.dns === "split") console.log(`Configure a restricted nameserver for ${config.domain} pointing to ${config.ip}.`);
  else if (next.domain) console.log(`Configure wildcard DNS for *.${config.domain} pointing to ${config.ip}.`);
  console.log("Run tunnel up to start the proxy. Docker and Bun must already be installed.");
}

export async function doctor(config: Config): Promise<void> {
  let failures = 0;
  async function check(label: string, fn: () => unknown) {
    try { const detail = await fn(); console.log(`OK ${label}${detail ? `: ${detail}` : ""}`); }
    catch (error) { failures++; console.log(`FAIL ${label}: ${errorMessage(error)}`); }
  }
  await check("Docker", () => sh("docker", ["info", "--format", "{{.ServerVersion}}"]));
  await check("Compose", () => sh("docker", ["compose", "version", "--short"]));
  await check("Proxy", () => { const name = proxyContainer(config); if (!name) throw new Error("not running; use tunnel up"); return name; });
  const host = `tunnel-doctor.${config.domain}`;
  await check("Wildcard DNS", async () => {
    const addresses = await lookup(host, { family: 4, all: true });
    if (!addresses.some((entry) => entry.address === config.ip)) throw new Error(`${host} does not resolve to ${config.ip}`);
    return `${host} -> ${config.ip}`;
  });
  for (const preview of readPreviews(config)) {
    await check(preview.name, async () => {
      if (preview.url !== origin(config, preview.name)) throw new Error("preview uses a different domain or proxy port");
      if (!routes(config, preview.name, preview.port)) throw new Error("missing or mismatched route");
      if (preview.mode === "command" && !running(preview)) throw new Error(`its command exited; see tunnel logs ${preview.name}`);
      const response = await fetch(preview.url, { signal: AbortSignal.timeout(5000), redirect: "manual" });
      await response.body?.cancel();
      if (response.status >= 400) throw new Error(`HTTP ${response.status} (authenticated apps may require manual verification)`);
      return `HTTP ${response.status}`;
    });
  }
  console.log(`Network: ${config.ip}; bind ${config.bind}:${config.port}. DNS is not access control.`);
  if (failures) process.exitCode = 1;
}
