import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir, origin, stateRoot, type Config } from "./config";

// How a preview's app runs: a Compose stack, a command tunnel started, or an app someone else
// started (local), of which tunnel manages only the route.
export type Mode = "compose" | "command" | "local";

export interface Preview {
  readonly name: string;
  readonly dir: string;
  readonly mode: Mode;
  readonly url: string; // Fixed at creation, so a later configuration change cannot orphan the route.
  readonly port?: number; // The routed host port; absent while a new preview starts.
  readonly fixedPort?: number; // From --port; a repeated up keeps it.
  readonly expiresAt?: number;
  readonly urlEnv: readonly string[];
  // Compose
  readonly project?: string;
  readonly services: readonly string[];
  readonly profiles: readonly string[];
  readonly target?: string; // SERVICE:CONTAINER_PORT, re-resolved on every up.
  readonly disposable: boolean;
  // Command
  readonly command?: readonly string[];
  readonly pid?: number; // Leader of the command's process group.
  readonly pidStart?: string; // The leader's start time, so a reused pid is never signalled.
}

const previewsDir = (config: Config) => join(stateRoot(config), "mappings");

// Records written by older versions lack fields and store ports as strings.
function normalize(config: Config, raw: Record<string, any>): Preview {
  const port = (value: unknown) => (value === undefined || value === "" ? undefined : Number(value));
  const mode: Mode = raw.mode ?? "compose";
  return {
    ...raw,
    name: raw.name,
    dir: raw.dir,
    mode,
    url: raw.url || origin(config, raw.name),
    port: port(raw.port),
    fixedPort: port(raw.fixedPort ?? (mode === "local" ? raw.port : undefined)),
    urlEnv: raw.urlEnv ?? [],
    services: raw.services ?? [],
    profiles: raw.profiles ?? [],
    disposable: !!raw.disposable,
  };
}

export function readPreviews(config: Config): Preview[] {
  const dir = previewsDir(config);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith(".json")).map((file) => {
    try { return normalize(config, JSON.parse(readFileSync(join(dir, file), "utf8"))); }
    catch (error) { throw new Error(`unreadable preview record ${join(dir, file)}: ${(error as Error).message}`); }
  });
}

export function savePreview(config: Config, preview: Preview): void {
  writeAtomic(join(previewsDir(config), `${preview.name}.json`), `${JSON.stringify(preview, null, 2)}\n`);
}

export function deletePreview(config: Config, name: string): void {
  rmSync(join(previewsDir(config), `${name}.json`), { force: true });
}

// Volumes a torn-down Compose preview kept, with the directory it served, so a later up there can
// adopt them and removing that directory (tunnel rm or prune) can delete them.
export interface Retained {
  readonly project: string;
  readonly dir: string;
}

const retainedDir = (config: Config) => join(stateRoot(config), "retained");

export function readRetained(config: Config): Retained[] {
  const dir = retainedDir(config);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as Retained);
}

export function saveRetained(config: Config, retained: Retained): void {
  writeAtomic(join(retainedDir(config), `${retained.project}.json`), `${JSON.stringify(retained)}\n`);
}

export function deleteRetained(config: Config, project: string): void {
  rmSync(join(retainedDir(config), `${project}.json`), { force: true });
}

export function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, contents);
  renameSync(temp, path);
}

// Serializes every command that reads settings and changes previews, so cleanup never races a
// renewal, startup, or setup. One lock per config directory, because setup may move the state
// directory. The lock is a directory holding the owner's pid, renamed into place so it never
// appears without one. A lock left by a dead process is reported, never taken over.
// Returns the release function, or undefined when `wait` is false and the lock is busy.
export function acquireLock({ wait }: { wait: boolean }): (() => void) | undefined {
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, "tunnel.lock");
  const deadline = Date.now() + 10 * 60_000;
  let announced = false;
  for (;;) {
    const staged = `${path}.${process.pid}`;
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, "pid"), String(process.pid));
    try {
      renameSync(staged, path);
      return () => { if (lockOwner(path) === process.pid) rmSync(path, { recursive: true, force: true }); };
    } catch (error) {
      rmSync(staged, { recursive: true, force: true });
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    const owner = lockOwner(path);
    if (owner === undefined) continue; // Released meanwhile.
    if (!isAlive(owner)) {
      throw new Error(`stale lock from pid ${owner}, which is no longer running; if no tunnel command is running, remove ${path}`);
    }
    if (!wait) {
      // Logged every time, so a lock held far too long (for example by a reused pid) is visible.
      const since = statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
      console.error(`tunnel: skipped; pid ${owner} has held ${path} for ${Math.round((Date.now() - since) / 60_000)} min`);
      return undefined;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for tunnel operation (pid ${owner}) holding ${path}`);
    if (!announced) console.error(`tunnel: waiting for another tunnel operation (pid ${owner})`);
    announced = true;
    Bun.sleepSync(200);
  }
}

function lockOwner(path: string): number | undefined {
  try { return Number(readFileSync(join(path, "pid"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
