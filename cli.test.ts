import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const darwin = process.platform === "darwin";
const macOS = test.skipIf(!darwin);
const otherOS = test.skipIf(darwin);

// Fake docker: logs every call, plays a running proxy, and tracks Compose project resources as
// files named LOG.<project>.<c|n|v> (containers, networks, volumes). `compose up` creates all three.
// FAIL is a comma-separated list of substrings; a call whose arguments contain one fails.
const DOCKER = `
const fs = require('node:fs');
const a = process.argv.slice(2);
const line = a.join(' ');
fs.appendFileSync(process.env.LOG, JSON.stringify({ call: 'docker ' + line, url: process.env.APP_PUBLIC_URL }) + '\\n');
const state = (project, kind) => process.env.LOG + '.' + project + '.' + kind;
const project = a[0] === 'compose' && a.includes('--project-name') ? a[a.indexOf('--project-name') + 1] : undefined;
if (project && a.includes('up')) {
  for (const kind of ['c', 'n', 'v']) fs.writeFileSync(state(project, kind), '');
  if (process.env.SLOW_UP) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.SLOW_UP));
}
if (process.env.CRASH && line.includes(process.env.CRASH)) process.kill(process.ppid, 'SIGKILL');
if (process.env.FAIL && process.env.FAIL.split(',').some((s) => line.includes(s))) { console.error('fake failure: ' + line); process.exit(1); }
const labeled = (kind) => {
  const owner = /com\\.docker\\.compose\\.project=(\\S+)/.exec(line)[1];
  if (fs.existsSync(state(owner, kind))) console.log(owner + '-' + kind);
};
const drop = (kind) => { for (const id of a) if (id.endsWith('-' + kind)) fs.rmSync(state(id.slice(0, -2), kind), { force: true }); };
if (a[0] === 'ps' && a[1] === '-aq') labeled('c');
else if (a[0] === 'ps' && (!process.env.FRESH_PROXY || fs.existsSync(process.env.MARKER))) {
  console.log(JSON.stringify({ Names: 'unrelated-caddy', Ports: '0.0.0.0:9999->80/tcp' }));
  console.log(JSON.stringify({ Names: 'right-caddy', Ports: '0.0.0.0:8000->80/tcp' }));
}
if (line.startsWith('network ls')) labeled('n');
if (line.startsWith('volume ls')) labeled('v');
if (a[0] === 'rm') drop('c');
if (line.startsWith('network rm')) drop('n');
if (line.startsWith('volume rm')) drop('v');
if (a[0] === 'inspect') console.log(JSON.stringify([{ Source: process.env.BAD_MOUNT ? 'wrong' : process.env.SITES, Destination: '/etc/caddy/sites' }]));
if (a[0] === 'compose' && a.includes('ps')) {
  const rows = (process.env.PORTS || '8123').split(',').map((port) => ({ Publishers: [{ PublishedPort: Number(port) }] }));
  console.log(process.env.ARRAY_PORTS ? JSON.stringify(rows) : rows.map((row) => JSON.stringify(row)).join('\\n'));
}
if (a[0] === 'compose' && a.includes('config') && process.env.COMPOSE_CONFIG) console.log(process.env.COMPOSE_CONFIG);
if (a[0] === 'compose' && a.includes('port') && process.env.TARGET_PORT !== '') console.log('0.0.0.0:' + (process.env.TARGET_PORT || '55001'));
if (a[0] === 'compose' && a.includes('caddy')) {
  fs.writeFileSync(process.env.MARKER, 'started');
  fs.writeFileSync(process.env.PROXY_ENV, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('TUNNEL_')))));
}
`;

// Fake launchctl: logs calls and remembers whether the job is loaded. Like launchd, it can keep
// reporting a booted-out job for BOOTOUT_LAG more prints and fail the first BOOTSTRAP_FAILS
// bootstraps with EIO.
const LAUNCHCTL = `
const fs = require('node:fs');
const a = process.argv.slice(2);
const file = (name) => process.env.LOG + '.' + name;
const count = (name) => fs.existsSync(file(name)) ? Number(fs.readFileSync(file(name), 'utf8')) : 0;
fs.appendFileSync(process.env.LOG, JSON.stringify({ call: 'launchctl ' + a.join(' ') }) + '\\n');
if (a[0] === 'print') {
  if (count('lag') > 0) { fs.writeFileSync(file('lag'), String(count('lag') - 1)); process.exit(0); }
  process.exit(fs.existsSync(file('loaded')) ? 0 : 113);
}
if (a[0] === 'bootout') {
  fs.rmSync(file('loaded'), { force: true });
  fs.writeFileSync(file('lag'), process.env.BOOTOUT_LAG || '0');
}
if (a[0] === 'bootstrap') {
  if (count('fails') < Number(process.env.BOOTSTRAP_FAILS || 0)) {
    fs.writeFileSync(file('fails'), String(count('fails') + 1));
    console.error('Bootstrap failed: 5: Input/output error');
    process.exit(5);
  }
  fs.writeFileSync(file('loaded'), '');
}
`;

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tunnel-test-")));
  const bin = join(root, "bin");
  const app = join(root, "app");
  const config = join(root, "config");
  const sites = join(config, "dev-proxy/sites");
  const log = join(root, "log");
  mkdirSync(bin);
  mkdirSync(app);
  writeFileSync(join(app, "compose.yaml"), "services: {}");
  writeFileSync(join(bin, "docker"), `#!${process.execPath}\n${DOCKER}`, { mode: 0o755 });
  writeFileSync(join(bin, "launchctl"), `#!${process.execPath}\n${LAUNCHCTL}`, { mode: 0o755 });
  writeFileSync(join(bin, "tailscale"), `#!${process.execPath}\nconsole.log('100.64.0.2');`, { mode: 0o755 });
  const env = (extra: Record<string, string>) => ({
    ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, TUNNEL_CONFIG_DIR: config,
    TUNNEL_PROXY_PORT: "8000", TUNNEL_DOMAIN: "dev.example.com", TUNNEL_PROXY_IP: "100.64.0.2",
    TUNNEL_STATE_DIR: "", TUNNEL_PROXY_BIND: "", TUNNEL_DNS: "", TUNNEL_PROBE_MS: "0",
    SITES: sites, LOG: log, MARKER: join(root, "proxy-started"), PROXY_ENV: join(root, "proxy-env"), ...extra,
  });
  const command = (args: string[], cli = join(import.meta.dir, "cli.ts")) => [process.execPath, cli, ...args];
  // Off macOS, finite leases are refused, so ordinary cases opt out of expiry explicitly.
  const portable = (args: string[]) => !darwin && args[0] === "up" && !args.includes("--ttl") ? [...args, "--ttl", "never"] : args;
  const mappingPath = join(config, "dev-proxy/mappings/review.json");
  const rows = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((row) => JSON.parse(row)) : [];
  return {
    root, app, sites, config, mappingPath,
    route: join(sites, "review.caddy"),
    lock: join(config, "tunnel.lock"),
    runRaw: (args: string[], extra: Record<string, string> = {}) => Bun.spawnSync(command(args), { cwd: app, env: env(extra) }),
    run: (args: string[], extra: Record<string, string> = {}) => Bun.spawnSync(command(portable(args)), { cwd: app, env: env(extra) }),
    runCli: (cli: string, args: string[]) => Bun.spawnSync(command(args, cli), { cwd: app, env: env({}) }),
    spawn: (args: string[]) => Bun.spawn(command(portable(args)), { cwd: app, env: env({}), stdout: "pipe", stderr: "pipe" }),
    calls: (): string[] => rows().map((row) => row.call),
    urlFor: (prefix: string): string | undefined => rows().find((row) => row.call.startsWith(prefix))?.url,
    // Whether the fake Docker holds a resource of the project: c(ontainers), n(etworks), v(olumes).
    docker: (project: string, kind: "c" | "n" | "v") => existsSync(`${log}.${project}.${kind}`),
    seedDocker: (project: string, kind: "c" | "n" | "v") => writeFileSync(`${log}.${project}.${kind}`, ""),
    mapping: () => JSON.parse(readFileSync(mappingPath, "utf8")),
    editMapping: (change: (mapping: Record<string, unknown>) => void) => {
      const mapping = JSON.parse(readFileSync(mappingPath, "utf8"));
      change(mapping);
      writeFileSync(mappingPath, JSON.stringify(mapping));
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

type Fixture = ReturnType<typeof fixture>;

function withFixture(fn: (f: Fixture) => void | Promise<void>) {
  return async () => {
    const f = fixture();
    try { await fn(f); } finally { f.close(); }
  };
}

function success(result: ReturnType<Fixture["run"]>) {
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

function failure(result: ReturnType<Fixture["run"]>) {
  expect(result.exitCode).not.toBe(0);
  return result.stderr.toString();
}

const composeBase = (f: Fixture, project = "tunnel-review") => `docker compose --project-name ${project} --file ${join(f.app, "compose.yaml")}`;
const expire = (f: Fixture) => f.editMapping((m) => { m.expiresAt = 1; });

test("Compose preview routes its published port, reuses its name, and retains volumes on teardown", withFixture((f) => {
  expect(success(f.run(["up", "--name", "review"]))).toContain(`http://review.dev.example.com:8000 -> ${f.app} (port 8123)`);
  expect(readFileSync(f.route, "utf8")).toContain("host.docker.internal:8123");
  expect(success(f.run(["up"]))).toContain("http://review.dev.example.com:8000");
  expect(success(f.run(["ls"]))).toContain(`http://review.dev.example.com:8000\t${f.app} (port 8123, compose;`);
  expect(f.calls()).toContain("docker exec right-caddy caddy reload --config /etc/caddy/Caddyfile");
  expect(f.calls().some((call) => call.includes("unrelated-caddy"))).toBe(false);

  success(f.run(["down"]));
  expect(f.calls()).toContain("docker stop tunnel-review-c");
  expect(f.docker("tunnel-review", "c")).toBe(false);
  expect(f.docker("tunnel-review", "n")).toBe(false);
  expect(f.docker("tunnel-review", "v")).toBe(true);
  expect(existsSync(f.route)).toBe(false);
  expect(existsSync(f.mappingPath)).toBe(false);
  // Retained data is never adopted by a later preview; only manual inspection reaches it.
  expect(failure(f.run(["up", "--name", "review"]))).toContain("docker volume ls");
  expect(f.docker("tunnel-review", "v")).toBe(true);
}));

test("--target resolves an ephemeral host port after startup and is re-resolved on repeat up", withFixture((f) => {
  success(f.run(["up", "--name", "review", "--profile", "sandbox", "--service", "api", "--target", "api:8080", "--url-env", "APP_PUBLIC_URL"]));
  const base = `${composeBase(f)} --profile sandbox`;
  expect(f.calls()).toContain(`${base} up -d api`);
  expect(f.calls()).toContain(`${base} port api 8080`);
  expect(f.urlFor(`${base} up`)).toBe("http://review.dev.example.com:8000");
  expect(readFileSync(f.route, "utf8")).toContain("host.docker.internal:55001");

  // Recreated containers get new ephemeral ports; the remembered selection follows them.
  success(f.run(["up", "--build"], { TARGET_PORT: "55002" }));
  expect(f.calls()).toContain(`${base} up -d --build api`);
  expect(readFileSync(f.route, "utf8")).toContain("host.docker.internal:55002");
  expect(f.mapping().port).toBe("55002");
}));

test("pinned host ports are republished ephemerally and the default override file is loaded", withFixture((f) => {
  writeFileSync(join(f.app, "compose.override.yaml"), "services: {}");
  const config = { services: {
    web: { ports: [{ mode: "ingress", target: 8000, published: "8000", protocol: "tcp" }] },
    worker: {},
  } };
  success(f.run(["up", "--name", "review", "--disposable"], { COMPOSE_CONFIG: JSON.stringify(config) }));
  const ports = join(f.config, "dev-proxy/compose/review.yaml");
  expect(readFileSync(ports, "utf8")).toBe('services:\n  "web":\n    ports: !override [{"mode":"ingress","target":8000,"protocol":"tcp"}]\n');
  expect(f.calls()).toContain(`${composeBase(f)} --file ${join(f.app, "compose.override.yaml")} --file ${ports} up -d`);

  success(f.run(["down"]));
  expect(existsSync(ports)).toBe(false);
  // --port names a fixed host port, so it keeps the stack's own ports.
  success(f.run(["up", "--name", "review", "--port", "8123"], { COMPOSE_CONFIG: JSON.stringify(config) }));
  expect(existsSync(ports)).toBe(false);
}));

test("with several published ports, the only one answering HTTP is routed", withFixture(async (f) => {
  // A separate process, since the CLI runs synchronously and would block an in-test server.
  const server = Bun.spawn([process.execPath, "-e", "console.log(Bun.serve({ port: 0, fetch: () => new Response('ok') }).port)"], { stdout: "pipe" });
  try {
    const { value } = await server.stdout.getReader().read();
    const port = new TextDecoder().decode(value).trim();
    // Port 1 refuses connections, like a database that does not speak HTTP.
    expect(success(f.run(["up", "--name", "review"], { PORTS: `1,${port}` }))).toContain(`(port ${port})`);
    expect(failure(f.run(["up", "--name", "other", "--build"], { PORTS: "1,2" }))).toContain("found 2; select one");
  } finally { server.kill(); }
}));

for (const [label, args, env] of [
  ["Compose fails to start", ["up", "--name", "review"], { FAIL: "up -d" }],
  ["the proxy rejects the route", ["up", "--name", "review"], { FAIL: "caddy reload" }],
  ["the target is not published", ["up", "--name", "review", "--target", "api:8080"], { TARGET_PORT: "" }],
  ["the requested port is not published", ["up", "--name", "review", "--port", "9000"], {}],
  ["several ports are published and none selected", ["up", "--name", "review"], { PORTS: "8123,9000" }],
] as const) {
  test(`new preview is rolled back when ${label}`, withFixture((f) => {
    failure(f.run([...args], env));
    expect(f.docker("tunnel-review", "c")).toBe(false);
    expect(f.docker("tunnel-review", "n")).toBe(false);
    expect(existsSync(f.route)).toBe(false);
    expect(existsSync(f.mappingPath)).toBe(false);
  }));
}

test("new preview refuses a Compose project that tunnel did not start", withFixture((f) => {
  f.seedDocker("tunnel-review", "c");
  expect(failure(f.run(["up", "--name", "review"]))).toContain("no preview owns");
  expect(f.calls().some((call) => call.includes(" up ") || call.startsWith("docker stop"))).toBe(false);
  expect(f.docker("tunnel-review", "c")).toBe(true);

  rmSync(`${join(f.root, "log")}.tunnel-review.c`);
  f.seedDocker("tunnel-review", "v");
  failure(f.run(["up", "--name", "review"]));
  failure(f.run(["up", "--name", "review", "--disposable"]));
  expect(f.docker("tunnel-review", "v")).toBe(true);
  expect(existsSync(f.mappingPath)).toBe(false);
}));

test("a preview's volume policy is fixed when it is created", withFixture((f) => {
  success(f.run(["up", "--name", "review"]));
  expect(failure(f.run(["up", "--disposable"]))).toContain("--disposable is fixed");
  expect(f.mapping().disposable).toBe(false);
  success(f.run(["down", "review"]));
  expect(f.docker("tunnel-review", "v")).toBe(true);
}));

test("repeat up keeps a --port selection until --target replaces it", withFixture((f) => {
  const env = { PORTS: "8123,9000" };
  success(f.run(["up", "--name", "review", "--port", "9000"], env));
  success(f.run(["up"], env));
  expect(readFileSync(f.route, "utf8")).toContain("host.docker.internal:9000");
  success(f.run(["up", "--target", "api:8080"], env));
  success(f.run(["up"], { ...env, TARGET_PORT: "55002" }));
  expect(readFileSync(f.route, "utf8")).toContain("host.docker.internal:55002");
}));

test("repeat up of a borrowed local app reuses its port", withFixture((f) => {
  success(f.run(["up", "--local", "--port", "5191", "--name", "review"]));
  success(f.run(["up"]));
  expect(readFileSync(f.route, "utf8")).toContain("host.docker.internal:5191");
}));

test("failed restart keeps the record but stops routing to a possibly reassigned port", withFixture((f) => {
  success(f.run(["up", "--name", "review", "--port", "8123"], { PORTS: "8123,9000" }));
  failure(f.run(["up", "--port", "9000"], { PORTS: "8123,9000", FAIL: "caddy reload" }));
  expect(readFileSync(f.route, "utf8")).toContain("host.docker.internal:8123");
  expect(f.mapping().port).toBe("8123");
  expect(f.docker("tunnel-review", "c")).toBe(true);
  failure(f.run(["up", "--port", "9000"], { PORTS: "8123,9000", FAIL: "up -d" }));
  expect(existsSync(f.route)).toBe(false);
  expect(f.mapping().port).toBe("8123");
}));

test("failed rollback keeps the mapping so down can finish later", withFixture((f) => {
  expect(failure(f.run(["up", "--name", "review"], { FAIL: "caddy reload,stop tunnel-review-c" }))).toContain("rollback failed");
  expect(existsSync(f.mappingPath)).toBe(true);
  success(f.run(["down", "review"]));
  expect(f.docker("tunnel-review", "c")).toBe(false);
  expect(existsSync(f.mappingPath)).toBe(false);
}));

test("crash mid-startup reports the stale lock and leaves a preview that down removes", withFixture((f) => {
  failure(f.run(["up", "--name", "review"], { CRASH: "up -d" }));
  expect(failure(f.run(["setup"]))).toContain(`stale lock from pid`);
  expect(failure(f.run(["down", "review"]))).toContain(`remove ${f.lock}`);
  expect(f.docker("tunnel-review", "c")).toBe(true);
  rmSync(f.lock, { recursive: true });
  expect(success(f.run(["ls"]))).toContain("(port starting, compose;");
  success(f.run(["down", "review"]));
  expect(f.docker("tunnel-review", "c")).toBe(false);
  expect(existsSync(f.mappingPath)).toBe(false);
  expect(existsSync(f.lock)).toBe(false);
}));

test("failed teardown retains route and mapping", withFixture((f) => {
  success(f.run(["up", "--name", "review"]));
  failure(f.run(["down"], { FAIL: "stop tunnel-review-c" }));
  expect(existsSync(f.route)).toBe(true);
  expect(existsSync(f.mappingPath)).toBe(true);
}));

test("failed reload during removal restores route", withFixture((f) => {
  success(f.run(["up", "--local", "--port", "8123", "--name", "review"]));
  failure(f.run(["down"], { FAIL: "caddy reload" }));
  expect(existsSync(f.route)).toBe(true);
  expect(existsSync(f.mappingPath)).toBe(true);
}));

test("wrong proxy mount is rejected before starting app", withFixture((f) => {
  failure(f.run(["up", "--name", "review"], { BAD_MOUNT: "1" }));
  expect(existsSync(f.route)).toBe(false);
  expect(f.calls().some((call) => call.includes(" up "))).toBe(false);
}));

test("unmanaged site files are never overwritten", withFixture((f) => {
  mkdirSync(f.sites, { recursive: true });
  writeFileSync(f.route, "original");
  failure(f.run(["up", "--name", "review"]));
  expect(readFileSync(f.route, "utf8")).toBe("original");
  expect(f.calls()).toEqual([]);
}));

test("Compose array JSON format is supported", withFixture((f) => {
  success(f.run(["up", "--name", "review"], { ARRAY_PORTS: "1" }));
  expect(f.mapping().port).toBe("8123");
}));

test("borrowed local app: only its route is managed", withFixture((f) => {
  success(f.run(["up", "--local", "--port", "5191", "--name", "review"]));
  expect(readFileSync(f.route, "utf8")).toContain("host.docker.internal:5191");
  expect(success(f.run(["down", "review"]))).toContain("local app left running");
  expect(f.calls().some((call) => call.startsWith("docker compose") || call.startsWith("docker stop"))).toBe(false);
}));

test("port-only app without Compose automatically uses local mode", withFixture((f) => {
  rmSync(join(f.app, "compose.yaml"));
  success(f.run(["up", "--port", "5191", "--name", "review"]));
  expect(f.mapping().mode).toBe("local");
  expect(f.calls().some((call) => call.startsWith("docker compose"))).toBe(false);
}));

test("default nip.io uses detected Tailscale IP; proxy starts without DNS", withFixture((f) => {
  const output = success(f.run(["up", "--name", "review"], { TUNNEL_DOMAIN: "", TUNNEL_PROXY_IP: "", FRESH_PROXY: "1" }));
  expect(output).toContain("http://review.100.64.0.2.nip.io:8000");
  expect(f.calls().find((call) => call.includes(" caddy"))).toEndWith("up -d --wait --wait-timeout 45 caddy");
  const env = JSON.parse(readFileSync(join(f.root, "proxy-env"), "utf8"));
  expect(env.TUNNEL_DOMAIN).toBe("100.64.0.2.nip.io");
  expect(env.TUNNEL_PROXY_IP).toBe("100.64.0.2");
  expect(env.TUNNEL_PROXY_SITES).toBe(f.sites);
}));

test("split DNS bootstrap includes CoreDNS", withFixture((f) => {
  success(f.run(["up", "--name", "review"], { TUNNEL_DNS: "split", FRESH_PROXY: "1" }));
  expect(f.calls().some((call) => call.endsWith(" caddy dns"))).toBe(true);
}));

test("setup persists generic config and environment overrides it", withFixture((f) => {
  const env = { TUNNEL_DOMAIN: "", TUNNEL_PROXY_IP: "", TUNNEL_PROXY_PORT: "" };
  expect(success(f.run(["setup", "--domain", "demo.example.org", "--ip", "192.168.1.5", "--port", "80"], env)))
    .toContain("http://app.demo.example.org");
  expect(JSON.parse(readFileSync(join(f.config, "config.json"), "utf8")).ip).toBe("192.168.1.5");
  expect(success(f.run(["setup"], { ...env, TUNNEL_PROXY_PORT: "8080" }))).toContain(":8080");
  expect(success(f.run(["setup", "--domain", "auto"], env))).toContain("192.168.1.5.nip.io");
  expect(f.calls()).toEqual([]);
}));

test("setup refuses live configuration changes, including masked and detected values", withFixture((f) => {
  const savedConfig = () => JSON.parse(readFileSync(join(f.config, "config.json"), "utf8"));
  failure(f.run(["setup", "--port", "bad"]));
  success(f.run(["setup", "--domain", "dev.example.com"], { TUNNEL_DOMAIN: "" }));
  success(f.run(["up", "--name", "review"], { TUNNEL_DOMAIN: "" }));
  failure(f.run(["setup", "--domain", "other.example.com"], { TUNNEL_DOMAIN: "" }));
  failure(f.run(["setup", "--domain", "other.example.com"])); // Masked by TUNNEL_DOMAIN.
  expect(savedConfig().domain).toBe("dev.example.com");
  // The preview was registered under the detected address, so pinning another one is a live change.
  failure(f.run(["setup", "--ip", "192.168.1.5"], { TUNNEL_DOMAIN: "", TUNNEL_PROXY_IP: "" }));
  expect(savedConfig().ip).toBeUndefined();
}));

test("legacy mappings keep their project, list, never expire, and are removed", withFixture((f) => {
  success(f.run(["up", "--name", "review", "--ttl", "never"]));
  f.editMapping((m) => {
    for (const key of ["mode", "url", "expiresAt", "services", "profiles", "urlEnv", "disposable"]) delete m[key];
    m.project = "selfbench-review";
  });
  expect(success(f.run(["ls"]))).toContain("http://review.dev.example.com:8000");
  success(f.run(["cleanup"]));
  success(f.runRaw(["up", "--name", "review"])); // No --ttl: an unleased preview stays unleased.
  expect(f.mapping().expiresAt).toBeUndefined();
  expect(f.calls()).toContain(`${composeBase(f, "selfbench-review")} up -d`);
  success(f.run(["down", "review"]));
  expect(f.calls()).toContain("docker stop selfbench-review-c");
  expect(existsSync(f.mappingPath)).toBe(false);
}));

test("mapping URL is preserved and incompatible reuse rejected", withFixture((f) => {
  success(f.run(["up", "--name", "review"]));
  const env = { TUNNEL_DOMAIN: "changed.example.com" };
  expect(success(f.run(["ls"], env))).toContain("review.dev.example.com");
  failure(f.run(["up", "--name", "review"], env));
  failure(f.run(["down", "review"], env));
  failure(f.run(["up", "--local", "--port", "8123", "--name", "review"]));
}));

test("invalid input is rejected without Docker or launchd side effects", withFixture((f) => {
  for (const args of [
    ["up", "--name", "../escape"], ["up", "--name", "a".repeat(64)], ["up", "--name", "a", "--name", "b"],
    ["up", "--port", "65536"], ["up", "--port"], ["up", "--name", "--build"],
    ["up", "--ttl", "0m"], ["up", "--ttl", "garbage"],
    ["up", "--url-env", "not-valid"], ["up", "--url-env", "PATH"], ["up", "--url-env", "DOCKER_HOST"], ["up", "--url-env", "COMPOSE_FILE"],
    ["up", "--target", "api"], ["up", "--target", "api:http"], ["up", "--target", "api:0"], ["up", "--target", "api:65536"],
    ["up", "--port", "8123", "--target", "api:8080"], ["up", "--local", "--port", "5191", "--target", "api:8080"],
    ["up", "--local", "--port", "5191", "--profile", "x"], ["up", "--local"], ["up", "--local", "--port", "80", "--build"],
    ["up", "--unknown"], ["up", "one", "two"], ["up", "--name", "proxy"], ["up", "--name", "proxy-1a2b3c4d"],
    ["extend"], ["extend", "missing"], ["down", "missing"], ["cleanup", "extra"], ["cleanup", "--scheduled", "extra"], ["ls", "extra"],
    ["setup", "--ip", "bad"], ["setup", "--dns", "bad"], ["setup", "--bind", "bad"],
    ["setup", "--domain", "bad\n{evil}"], ["setup", "--port", "zero"], ["setup", "--wat", "x"],
  ]) {
    // Disable fixed environment settings so setup validates the supplied values.
    expect(f.run(args, { TUNNEL_DOMAIN: "", TUNNEL_PROXY_IP: "", TUNNEL_PROXY_PORT: "" }).exitCode, args.join(" ")).not.toBe(0);
  }
  expect(f.calls()).toEqual([]);
  expect(existsSync(f.lock)).toBe(false);
}));

test("persisted --url-env names are revalidated before Compose runs", withFixture((f) => {
  success(f.run(["up", "--name", "review"]));
  f.editMapping((m) => { m.urlEnv = ["PATH"]; });
  const before = f.calls().length;
  expect(failure(f.run(["up"]))).toContain("cannot override PATH");
  expect(f.calls().length).toBe(before);
}));

test("a directory with several previews requires an explicit name", withFixture((f) => {
  success(f.run(["up", "--name", "review"]));
  success(f.run(["up", "--name", "another"]));
  const before = f.calls().length;
  expect(failure(f.run(["up"]))).toContain("specify --name");
  failure(f.run(["down"]));
  expect(f.calls().length).toBe(before);
  success(f.run(["down", "review"]));
}));

test("scheduled cleanup logs and skips a busy tick; manual commands wait for the lock", withFixture(async (f) => {
  success(f.run(["up", "--name", "review"]));
  expire(f);
  mkdirSync(f.lock);
  writeFileSync(join(f.lock, "pid"), String(process.pid)); // The test runner is alive.
  const skipped = f.run(["cleanup", "--scheduled"]);
  expect(skipped.exitCode).toBe(0);
  expect(skipped.stderr.toString()).toContain(`skipped; pid ${process.pid} has held ${f.lock}`);
  expect(existsSync(f.mappingPath)).toBe(true);

  const waiting = f.spawn(["cleanup"]);
  const reader = waiting.stderr.getReader();
  let stderr = "";
  while (!stderr.includes("waiting for another tunnel operation")) {
    const { value, done } = await reader.read();
    if (done) break;
    stderr += new TextDecoder().decode(value);
  }
  expect(stderr).toContain(`waiting for another tunnel operation (pid ${process.pid})`);
  expect(existsSync(f.mappingPath)).toBe(true);
  rmSync(f.lock, { recursive: true });
  expect(await waiting.exited).toBe(0);
  expect(existsSync(f.mappingPath)).toBe(false);
}));

test("scheduled cleanup does not take the lock when nothing has expired", withFixture((f) => {
  success(f.run(["up", "--name", "review", "--ttl", "never"]));
  mkdirSync(f.lock);
  writeFileSync(join(f.lock, "pid"), String(process.pid));
  success(f.run(["cleanup", "--scheduled"]));
}));

macOS("new previews get a 30-minute lease and a launchd reaper under the user's HOME", withFixture((f) => {
  expect(success(f.run(["up", "--name", "review"], { SECRET_TOKEN: "hunter2" }))).toContain("expires in 30 minutes");
  expect(f.mapping().expiresAt).toBeGreaterThan(Date.now() + 29 * 60_000);
  expect(f.mapping().expiresAt).toBeLessThan(Date.now() + 31 * 60_000);
  const agents = join(f.root, "Library", "LaunchAgents");
  const [plist] = readdirSync(agents);
  expect(plist).toMatch(/^dev\.tunnel\.cleanup\.[0-9a-f]{8}\.plist$/);
  const contents = readFileSync(join(agents, plist!), "utf8");
  expect(contents).not.toContain("hunter2");
  expect(contents).toContain(`<key>TUNNEL_STATE_DIR</key><string>${f.config}</string>`);
  expect(contents).toContain("<key>TUNNEL_DOMAIN</key><string>dev.example.com</string>");
  // An unchanged, loaded job is left alone by later commands.
  success(f.run(["up"]));
  success(f.run(["extend", "review", "1h"]));
  expect(f.calls().filter((call) => call.startsWith("launchctl bootstrap"))).toEqual([`launchctl bootstrap gui/${process.getuid!()} ${join(agents, plist!)}`]);
}));

macOS("the reaper runs a private copy of tunnel that survives deleting the checkout", withFixture((f) => {
  success(f.run(["up", "--name", "review"]));
  const agents = join(f.root, "Library", "LaunchAgents");
  const contents = readFileSync(join(agents, readdirSync(agents)[0]!), "utf8");
  const cli = /<string>([^<]+\/cli\.ts)<\/string><string>cleanup<\/string><string>--scheduled<\/string>/.exec(contents)![1]!;
  expect(cli.startsWith(join(f.config, "runtime"))).toBe(true);
  expect(readdirSync(join(cli, "..")).sort()).toEqual(["Caddyfile", "Corefile", "cli.ts", "compose.yaml", "config.ts", "docker.ts", "lease.ts", "proxy.ts", "state.ts"]);
  expire(f);
  expect(success(f.runCli(cli, ["cleanup", "--scheduled"]))).toContain("review removed");
  expect(existsSync(f.mappingPath)).toBe(false);
}));

macOS("rewriting the reaper waits for launchd to unload it and retries a failed bootstrap", withFixture((f) => {
  success(f.run(["up", "--name", "review"]));
  const before = f.calls().length;
  success(f.run(["up"], { TUNNEL_PROXY_BIND: "127.0.0.1", BOOTOUT_LAG: "3", BOOTSTRAP_FAILS: "1" }));
  const calls = f.calls().slice(before).filter((call) => call.startsWith("launchctl"));
  const bootout = calls.findIndex((call) => call.startsWith("launchctl bootout"));
  const bootstraps = calls.flatMap((call, i) => call.startsWith("launchctl bootstrap") ? [i] : []);
  expect(bootstraps.length).toBe(2);
  expect(calls.slice(bootout, bootstraps[0]).filter((call) => call.startsWith("launchctl print")).length).toBe(4);
}));

macOS("a leased preview from another configuration blocks rewriting the reaper", withFixture((f) => {
  success(f.run(["up", "--name", "review"]));
  const before = f.calls().length;
  const changed = { TUNNEL_DOMAIN: "changed.example.com" };
  expect(failure(f.run(["up", "--name", "another"], changed))).toContain("restore the configuration");
  failure(f.run(["extend", "review", "1h"], changed));
  expect(f.calls().slice(before).filter((call) => call.startsWith("launchctl") || call.includes(" up "))).toEqual([]);
  // Without a lease the reaper is not involved, so the other configuration may still be used.
  success(f.run(["up", "--name", "another", "--ttl", "never"], changed));
}));

macOS("the lease starts when the preview is ready, not before a slow build", withFixture((f) => {
  const started = Date.now();
  success(f.run(["up", "--name", "review", "--ttl", "1m"], { SLOW_UP: "1500" }));
  expect(f.mapping().expiresAt).toBeGreaterThanOrEqual(started + 60_000 + 1_500);
}));

macOS("cleanup tears down only expired previews, deleting volumes only when disposable", withFixture((f) => {
  success(f.run(["up", "--name", "review", "--disposable"]));
  success(f.run(["cleanup"]));
  expect(existsSync(f.mappingPath)).toBe(true);
  expire(f);
  expect(success(f.run(["cleanup"]))).toContain("review removed");
  expect(existsSync(f.mappingPath)).toBe(false);
  expect(f.calls()).toContain("docker rm --volumes tunnel-review-c");
  expect(f.docker("tunnel-review", "v")).toBe(false);
}));

macOS("extend renews or opts out, repeat up never shortens a lease, and failed expiry is retried", withFixture((f) => {
  success(f.run(["up", "--name", "review"]));
  expire(f);
  expect(failure(f.run(["cleanup"], { FAIL: "stop tunnel-review-c" }))).toContain("retrying next run");
  expect(existsSync(f.mappingPath)).toBe(true);
  success(f.run(["extend", "review", "2h"]));
  success(f.run(["up"]));
  expect(f.mapping().expiresAt).toBeGreaterThan(Date.now() + 119 * 60_000);
  success(f.run(["cleanup"]));
  expect(existsSync(f.mappingPath)).toBe(true);
  success(f.run(["extend", "review", "never"]));
  expect(f.mapping().expiresAt).toBeUndefined();
  expire(f);
  success(f.run(["cleanup"]));
  expect(existsSync(f.mappingPath)).toBe(false);
  expect(f.docker("tunnel-review", "v")).toBe(true);
}));

macOS("expired borrowed server loses only its route", withFixture((f) => {
  success(f.run(["up", "--local", "--port", "8123", "--name", "review"]));
  expire(f);
  success(f.run(["cleanup"]));
  expect(existsSync(f.route)).toBe(false);
  expect(existsSync(f.mappingPath)).toBe(false);
  expect(f.calls().some((call) => call.startsWith("docker compose") || call.startsWith("docker stop"))).toBe(false);
}));

otherOS("finite leases are refused off macOS before any side effect", withFixture((f) => {
  expect(failure(f.runRaw(["up", "--name", "review"]))).toContain("--ttl never");
  expect(f.calls()).toEqual([]);
  success(f.run(["up", "--name", "review"]));
  failure(f.runRaw(["extend", "review", "30m"]));
  expect(f.mapping().expiresAt).toBeUndefined();
}));

test("help and skill work without configuration or Docker", withFixture((f) => {
  mkdirSync(f.config, { recursive: true });
  writeFileSync(join(f.config, "config.json"), "invalid json");
  expect(success(f.run(["--help"]))).toContain("tunnel setup");
  expect(success(f.run(["--skill"]))).toBe(readFileSync(join(import.meta.dir, "skills/tunnel-preview/SKILL.md"), "utf8") + "\n");
  expect(f.calls()).toEqual([]);
}));
