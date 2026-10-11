import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir, type Config } from "./config";

export interface Mapping {
  readonly name: string;
  readonly dir: string;
  readonly port: string; // Empty while a new preview is starting.
  readonly mode?: "compose" | "local"; // Absent in old mappings, which are all Compose.
  readonly project?: string;
  readonly url?: string;
  readonly expiresAt?: number;
  readonly disposable?: boolean;
  readonly services?: string[];
  readonly profiles?: string[];
  readonly urlEnv?: string[];
  readonly target?: string; // SERVICE:CONTAINER_PORT, re-resolved on every up.
  readonly fixedPort?: string; // Compose host port chosen with --port, reused by a repeated up.
}

export const sitesDir = (config: Config) => join(config.stateDir, "dev-proxy", "sites");
const mappingsDir = (config: Config) => join(config.stateDir, "dev-proxy", "mappings");

export function readMappings(config: Config): Mapping[] {
  const dir = mappingsDir(config);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith(".json")).map((file) => {
    try { return JSON.parse(readFileSync(join(dir, file), "utf8")) as Mapping; }
    catch (error) { throw new Error(`unreadable mapping ${join(dir, file)}: ${(error as Error).message}`); }
  });
}

export function saveMapping(config: Config, mapping: Mapping): void {
  writeAtomic(join(mappingsDir(config), `${mapping.name}.json`), `${JSON.stringify(mapping, null, 2)}\n`);
}

export function deleteMapping(config: Config, name: string): void {
  rmSync(join(mappingsDir(config), `${name}.json`), { force: true });
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
      const minutes = Math.round((Date.now() - since) / 60_000);
      console.error(`tunnel: skipped; pid ${owner} has held ${path} for ${minutes} min`);
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
