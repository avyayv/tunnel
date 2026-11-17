// Command previews: any program, started in the background in its own process group so stopping
// it stops everything it spawned.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot, type Config } from "./config";
import { answeringHTTP, freePort, listening } from "./net";
import { sh, type Env } from "./sh";
import type { Preview } from "./state";

export const logPath = (config: Config, name: string) => join(stateRoot(config), "logs", `${name}.log`);

export interface Started {
  readonly pid: number;
  readonly pidStart: string;
  readonly port: number; // PORT as given to the command.
}

// Starts the command in `dir` with PORT set (to --port, or a free port), output appended to the
// preview's log. A single argument is a shell command line, so `$PORT` can be used in it.
export async function startCommand(config: Config, preview: Preview, env: Env): Promise<Started> {
  const command = preview.command!;
  const fixed = preview.fixedPort;
  if (fixed && await listening(fixed)) throw new Error(`port ${fixed} is already in use; to route an app that is already running, use --local`);
  const port = fixed ?? await freePort();
  const log = logPath(config, preview.name);
  mkdirSync(dirname(log), { recursive: true });
  const out = openSync(log, "a");
  writeSync(out, `\n--- ${new Date().toISOString()} tunnel up: ${command.join(" ")} (PORT=${port})\n`);
  const [file, ...args] = command.length === 1 ? ["/bin/sh", "-c", command[0]!] : command;
  const child = spawn(file!, args, {
    cwd: preview.dir,
    env: { ...withoutAgentMarkers(process.env), ...env, PORT: String(port) },
    detached: true, // A new session and process group, which outlives this command and its terminal.
    stdio: ["ignore", out, out],
  });
  closeSync(out);
  const spawned = await new Promise<number>((done, fail) => {
    child.once("spawn", () => done(child.pid!));
    child.once("error", (error) => fail(new Error(`could not start ${file}: ${error.message}`)));
  });
  child.unref();
  const pidStart = processStart(spawned);
  if (!pidStart) throw new Error(`${command.join(" ")} exited immediately${logTail(log)}`);
  return { pid: spawned, pidStart, port };
}

// Returns the port to route once the app answers HTTP. PORT (or --port) was free when the
// command started, so whatever answers there is the app, even when a container publishes it. The
// app may ignore PORT and pick its own (Vite's 5173, say), so unless --port fixed it, every port
// the process group listens on is a candidate too, asked on the loopback address it listens on.
export async function waitForHTTP(config: Config, preview: Preview, { pid: pgid, port }: Started, waitMs: number): Promise<number> {
  const fixed = !!preview.fixedPort;
  const log = logPath(config, preview.name);
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (!groupAlive(pgid)) {
      throw new Error("the command exited before serving HTTP. It must keep running in the foreground: "
        + `if it started a server in the background, use its foreground mode${logTail(log)}`);
    }
    const mine = listeners(pgid);
    const own = fixed ? [] : mine.filter((entry) => entry.port !== port);
    for (const entry of own) {
      // The proxy reaches the host by port, so another process on the same port could answer instead.
      const other = otherListener(entry.port, pgid);
      if (other) {
        throw new Error(`the command listens on ${entry.address}, but pid ${other} also listens on port ${entry.port}, `
          + "so the proxy could reach either. Have the app use the free port tunnel puts in $PORT, or pass --port");
      }
    }
    const candidates = [{ port, host: mine.find((entry) => entry.port === port)?.host ?? "127.0.0.1" }, ...own];
    const http = await answeringHTTP(candidates);
    if (http.includes(port)) return port;
    if (http.length === 1) return http[0]!;
    if (http.length > 1) throw new Error(`the command serves HTTP on ports ${http.join(", ")}; choose one with --port`);
    if (Date.now() >= deadline) {
      const seen = listeners(pgid).map((entry) => entry.address);
      throw new Error(`nothing answered HTTP ${fixed ? `on port ${port} ` : ""}within ${Math.round(waitMs / 1000)}s`
        + `${seen.length ? ` (it listens on ${seen.join(", ")})` : ""}; raise --wait if it starts slowly${logTail(log)}`);
    }
    await Bun.sleep(250);
  }
}

// Stops the command's whole process group: SIGTERM, then SIGKILL after a grace period.
export async function stopCommand(preview: Preview): Promise<void> {
  if (!running(preview)) return;
  const pgid = preview.pid!;
  const gone = async (ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) if (!groupAlive(pgid)) return true;
    return !groupAlive(pgid);
  };
  signal(pgid, "SIGTERM");
  if (await gone(10_000)) return;
  signal(pgid, "SIGKILL");
  if (!await gone(2_000)) throw new Error(`could not stop process group ${pgid}`);
}

// Whether the preview's process group still runs. The group id is the leader's pid, which the
// system cannot reuse while the group has members; a live leader must also have the recorded
// start time, or the pid now belongs to someone else.
export function running(preview: Preview): boolean {
  if (!preview.pid) return false;
  const start = processStart(preview.pid);
  if (start !== undefined && start !== preview.pidStart) return false;
  return groupAlive(preview.pid);
}

// Variables by which coding agents announce themselves. Tools that see one assume the agent's
// shell will block on or kill a long-running server, and some (Astro 7's dev server, via
// am-i-vibing) then detach into the background, escaping the process group tunnel stops. Under
// tunnel the command is supervised, so it runs as if started by hand.
const AGENT_MARKERS = /^(CLAUDECODE|AI_AGENT|AGENT|CODEX_THREAD_ID|GEMINI_CLI|QWEN_CODE|AUGMENT_AGENT|PI_CODING_AGENT|CRUSH|AMP_CURRENT_THREAD_ID|CURSOR_TRACE_ID|CODEIUM_EDITOR_APP_ROOT|OPENCODE(_.*)?|ANTIGRAVITY_.*)$/;
const withoutAgentMarkers = (env: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(env).filter(([key]) => !AGENT_MARKERS.test(key)));

export const logTail = (log: string, lines = 20) => {
  if (!existsSync(log)) return "";
  const tail = readFileSync(log, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  return `\n--- last output (${log}):\n${tail}`;
};

function processStart(pid: number): string | undefined {
  return sh("ps", ["-o", "lstart=", "-p", String(pid)], { quiet: true }) || undefined;
}

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function signal(pgid: number, name: NodeJS.Signals): void {
  try { process.kill(-pgid, name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

// TCP ports the process group listens on, per lsof (none if lsof is missing), each with the
// loopback host that reaches it: IPv6 only when every listener on the port is IPv6-only.
function listeners(pgid: number): { address: string; port: number; host: string }[] {
  if (!Bun.which("lsof")) return [];
  const entries = sh("lsof", ["-nP", "-a", "-g", String(pgid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { quiet: true })
    .split("\n").filter((line) => line.startsWith("n"))
    .map((line) => ({ address: line.slice(1), port: Number(/:(\d+)$/.exec(line)?.[1]) }))
    .filter((entry) => entry.port > 0);
  const byPort = new Map<number, { address: string; port: number; host: string }>();
  for (const entry of entries) {
    const host = entry.address.startsWith("[") ? "[::1]" : "127.0.0.1";
    if (byPort.get(entry.port)?.host !== "127.0.0.1") byPort.set(entry.port, { ...entry, host });
  }
  return [...byPort.values()];
}

// A process outside the group that listens on the port, if any.
function otherListener(port: number, pgid: number): number | undefined {
  let pid: number | undefined;
  for (const line of sh("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpg"], { quiet: true }).split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("g") && Number(line.slice(1)) !== pgid) return pid;
  }
  return undefined;
}
