import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tunnel-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const app = join(root, "app");
  mkdirSync(app);
  writeFileSync(join(app, "compose.yaml"), "services: {}");
  const config = join(root, "config");
  const sites = join(config, "dev-proxy/sites");
  const marker = join(root, "proxy-started");
  writeFileSync(join(bin, "docker"), `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.LOG, JSON.stringify(a) + '\\n');
if (a[0] === 'ps' && (!process.env.FRESH_PROXY || fs.existsSync(process.env.MARKER))) {
  console.log(JSON.stringify({Names:'unrelated-caddy', Ports:'0.0.0.0:9999->80/tcp'}));
  console.log(JSON.stringify({Names:'right-caddy', Ports:'0.0.0.0:8000->80/tcp'}));
}
if (a[0] === 'inspect') console.log(JSON.stringify([{Source:process.env.BAD_MOUNT ? 'wrong' : process.env.SITES, Destination:'/etc/caddy/sites'}]));
if (a[0] === 'compose' && a.includes('ps')) {
  const rows = [{Publishers:[{PublishedPort:8123}]}];
  console.log(JSON.stringify(process.env.ARRAY_PORTS ? rows : rows[0]));
}
if (a[0] === 'compose' && a.includes('caddy')) {
  fs.writeFileSync(process.env.MARKER, 'started');
  fs.writeFileSync(process.env.PROXY_ENV, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('TUNNEL_')))));
}
if (a.includes('down') && process.env.FAIL_DOWN) process.exit(1);
if (a[0] === 'exec' && process.env.FAIL_RELOAD) process.exit(1);
`, { mode: 0o755 });
  writeFileSync(join(bin, "tailscale"), `#!${process.execPath}\nconsole.log('100.64.0.2');`, { mode: 0o755 });
  const run = (args: string[], extra: Record<string, string> = {}) => Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "cli.ts"), ...args], {
      cwd: app,
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, TUNNEL_CONFIG_DIR: config,
        TUNNEL_PROXY_PORT: "8000", TUNNEL_DOMAIN: "dev.example.com", TUNNEL_PROXY_IP: "100.64.0.2",
        TUNNEL_STATE_DIR: "", TUNNEL_PROXY_BIND: "", TUNNEL_DNS: "",
        SITES: sites, LOG: join(root, "log"), MARKER: marker, PROXY_ENV: join(root, "proxy-env"), ...extra,
      },
    },
  );
  return {
    root, app, sites, config, run,
    route: join(sites, "review.caddy"), mapping: join(config, "dev-proxy/mappings/review.json"),
    log: () => existsSync(join(root, "log")) ? readFileSync(join(root, "log"), "utf8") : "",
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function withFixture(fn: (f: ReturnType<typeof fixture>) => void) {
  const f = fixture();
  try { fn(f); } finally { f.close(); }
}

function success(result: ReturnType<ReturnType<typeof fixture>["run"]>) {
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

test("full URLs, stable identity, exact proxy selection, and route removal", () => withFixture((f) => {
  expect(success(f.run(["up", "--name", "review"]))).toContain("http://review.dev.example.com:8000");
  expect(success(f.run(["up"]))).toContain("http://review.dev.example.com:8000");
  expect(success(f.run(["ls"]))).toContain("http://review.dev.example.com:8000");
  expect(f.log()).toContain('["exec","right-caddy"');
  expect(f.log()).not.toContain('["exec","unrelated-caddy"');
  success(f.run(["down"]));
  expect(existsSync(f.route)).toBe(false);
  expect(existsSync(f.mapping)).toBe(false);
}));

test("failed shutdown retains route and mapping", () => withFixture((f) => {
  success(f.run(["up", "--name", "review"]));
  expect(f.run(["down"], { FAIL_DOWN: "1" }).exitCode).not.toBe(0);
  expect(existsSync(f.route)).toBe(true);
  expect(existsSync(f.mapping)).toBe(true);
}));

test("failed reload during removal restores route", () => withFixture((f) => {
  success(f.run(["up", "--local", "--port", "8123", "--name", "review"]));
  expect(f.run(["down"], { FAIL_RELOAD: "1" }).exitCode).not.toBe(0);
  expect(existsSync(f.route)).toBe(true);
  expect(existsSync(f.mapping)).toBe(true);
}));

test("wrong proxy mount is rejected before starting app", () => withFixture((f) => {
  expect(f.run(["up", "--name", "review"], { BAD_MOUNT: "1" }).exitCode).not.toBe(0);
  expect(existsSync(f.route)).toBe(false);
  expect(f.log()).not.toContain('"up"');
}));

test("registration failure rolls back and unmanaged sites are protected", () => withFixture((f) => {
  expect(f.run(["up", "--name", "review"], { FAIL_RELOAD: "1" }).exitCode).not.toBe(0);
  expect(existsSync(f.route)).toBe(false);
  mkdirSync(f.sites, { recursive: true });
  writeFileSync(f.route, "original");
  expect(f.run(["up", "--name", "review"]).exitCode).not.toBe(0);
  expect(readFileSync(f.route, "utf8")).toBe("original");
}));

test("unpublished target port is rejected for Compose", () => withFixture((f) => {
  expect(f.run(["up", "--name", "review", "--port", "9000"]).exitCode).not.toBe(0);
  expect(existsSync(f.route)).toBe(false);
}));

test("Compose array JSON format is supported", () => withFixture((f) => {
  success(f.run(["up", "--name", "review"], { ARRAY_PORTS: "1" }));
}));

test("local app skips Compose and down leaves app running", () => withFixture((f) => {
  success(f.run(["up", "--local", "--port", "5191", "--name", "review"]));
  expect(readFileSync(f.route, "utf8")).toContain("host.docker.internal:5191");
  expect(JSON.parse(readFileSync(f.mapping, "utf8")).mode).toBe("local");
  expect(success(f.run(["down", "review"]))).toContain("local app left running");
  expect(f.log()).not.toContain('"compose"');
}));

test("port-only app without Compose automatically uses local mode", () => withFixture((f) => {
  rmSync(join(f.app, "compose.yaml"));
  success(f.run(["up", "--port", "5191", "--name", "review"]));
  expect(f.log()).not.toContain('"compose"');
}));

test("default nip.io uses detected Tailscale IP; proxy starts without DNS", () => withFixture((f) => {
  const output = success(f.run(["up", "--name", "review"], { TUNNEL_DOMAIN: "", TUNNEL_PROXY_IP: "", FRESH_PROXY: "1" }));
  expect(output).toContain("http://review.100.64.0.2.nip.io:8000");
  const boot = f.log().split("\n").find((line) => line.includes('"caddy"'))!;
  expect(boot).not.toContain('"dns"');
  expect(boot).toContain('"--wait"');
  const env = JSON.parse(readFileSync(join(f.root, "proxy-env"), "utf8"));
  expect(env.TUNNEL_DOMAIN).toBe("100.64.0.2.nip.io");
  expect(env.TUNNEL_PROXY_IP).toBe("100.64.0.2");
  expect(env.TUNNEL_PROXY_SITES).toBe(f.sites);
}));

test("split DNS bootstrap includes CoreDNS", () => withFixture((f) => {
  success(f.run(["up", "--name", "review"], { TUNNEL_DNS: "split", FRESH_PROXY: "1" }));
  expect(f.log()).toContain('"caddy","dns"');
}));

test("setup persists generic config and environment overrides it", () => withFixture((f) => {
  const env = { TUNNEL_DOMAIN: "", TUNNEL_PROXY_IP: "", TUNNEL_PROXY_PORT: "" };
  expect(success(f.run(["setup", "--domain", "demo.example.org", "--ip", "192.168.1.5", "--port", "80"], env)))
    .toContain("http://app.demo.example.org");
  const config = JSON.parse(readFileSync(join(f.config, "config.json"), "utf8"));
  expect(config.ip).toBe("192.168.1.5");
  expect(success(f.run(["setup"], { ...env, TUNNEL_PROXY_PORT: "8080" }))).toContain(":8080");
  expect(success(f.run(["setup", "--domain", "auto"], env))).toContain("192.168.1.5.nip.io");
  expect(f.log()).toBe("");
}));

test("setup refuses live configuration changes", () => withFixture((f) => {
  const env = { TUNNEL_DOMAIN: "" };
  success(f.run(["setup", "--domain", "dev.example.com"], env));
  success(f.run(["up", "--name", "review"], env));
  expect(f.run(["setup", "--domain", "other.example.com"], env).exitCode).not.toBe(0);
  expect(JSON.parse(readFileSync(join(f.config, "config.json"), "utf8")).domain).toBe("dev.example.com");
}));

test("setup validates and protects saved values masked by environment", () => withFixture((f) => {
  expect(f.run(["setup", "--port", "bad"]).exitCode).not.toBe(0);
  success(f.run(["setup", "--domain", "dev.example.com"]));
  success(f.run(["up", "--name", "review"]));
  expect(f.run(["setup", "--domain", "other.example.com"]).exitCode).not.toBe(0);
  expect(JSON.parse(readFileSync(join(f.config, "config.json"), "utf8")).domain).toBe("dev.example.com");
}));

test("legacy mappings still list and remove their Compose project", () => withFixture((f) => {
  success(f.run(["up", "--name", "review"]));
  const mapping = JSON.parse(readFileSync(f.mapping, "utf8"));
  delete mapping.mode; delete mapping.url; delete mapping.file;
  writeFileSync(f.mapping, JSON.stringify(mapping));
  expect(success(f.run(["ls"]))).toContain("http://review.dev.example.com:8000");
  success(f.run(["down", "review"]));
  expect(f.log()).toContain('"down"');
}));

test("mapping URL is preserved and incompatible reuse rejected", () => withFixture((f) => {
  success(f.run(["up", "--name", "review"]));
  const env = { TUNNEL_DOMAIN: "changed.example.com" };
  expect(success(f.run(["ls"], env))).toContain("review.dev.example.com");
  expect(f.run(["up", "--name", "review"], env).exitCode).not.toBe(0);
  expect(f.run(["down", "review"], env).exitCode).not.toBe(0);
  expect(f.run(["up", "--local", "--port", "8123", "--name", "review"]).exitCode).not.toBe(0);
}));

test("invalid input is rejected without Docker side effects", () => withFixture((f) => {
  for (const args of [
    ["up", "--name", "../escape"], ["up", "--name", "a".repeat(64)],
    ["up", "--port", "65536"], ["up", "--port"], ["up", "--name", "--build"],
    ["up", "--unknown"], ["up", "--local"], ["up", "--local", "--port", "80", "--build"],
    ["setup", "--ip", "bad"], ["setup", "--dns", "bad"], ["setup", "--bind", "bad"],
    ["setup", "--domain", "bad\n{evil}"], ["setup", "--port", "zero"], ["setup", "--wat", "x"],
  ]) {
    // Disable fixed environment settings so setup validates the supplied values.
    expect(f.run(args, { TUNNEL_DOMAIN: "", TUNNEL_PROXY_IP: "", TUNNEL_PROXY_PORT: "" }).exitCode).not.toBe(0);
  }
  expect(f.log()).toBe("");
}));

test("ambiguous down requires exact name", () => withFixture((f) => {
  success(f.run(["up", "--name", "review"]));
  success(f.run(["up", "--name", "another"]));
  expect(f.run(["down"]).exitCode).not.toBe(0);
  success(f.run(["down", "review"]));
}));

test("help and skill work without configuration or Docker", () => withFixture((f) => {
  mkdirSync(f.config, { recursive: true });
  writeFileSync(join(f.config, "config.json"), "invalid json");
  expect(success(f.run(["--help"]))).toContain("tunnel setup");
  expect(success(f.run(["--skill"]))).toBe(readFileSync(join(import.meta.dir, "skills/tunnel-preview/SKILL.md"), "utf8") + "\n");
  expect(f.log()).toBe("");
}));
