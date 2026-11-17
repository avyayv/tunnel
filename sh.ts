export type Env = Record<string, string>;

// Runs a command to completion and returns its trimmed stdout. A nonzero exit throws its stderr,
// unless `quiet`, for commands whose failure is an answer (like `launchctl print`).
export function sh(command: string, args: readonly string[], { quiet = false, env }: { quiet?: boolean; env?: Env } = {}): string {
  const child = Bun.spawnSync([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : process.env,
  });
  const out = child.stdout.toString().trim();
  if (child.exitCode !== 0 && !quiet) {
    throw new Error(child.stderr.toString().trim() || out || `${command} exited ${child.exitCode}`);
  }
  return out;
}

export const errorMessage = (error: unknown) => (error as Error).message;
