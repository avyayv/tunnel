import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { sh } from "./docker";

const git = (dir: string, args: readonly string[], quiet = false) => sh("git", ["-C", dir, ...args], { quiet });
const hasRef = (dir: string, ref: string) => Bun.spawnSync(["git", "-C", dir, "show-ref", "--verify", "--quiet", ref]).exitCode === 0;

export const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);

// The checkout a directory belongs to and its repository's main checkout.
export function worktreeOf(dir: string): { top: string; main: string } {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  const main = /^worktree (.+)$/m.exec(git(top, ["worktree", "list", "--porcelain"]))![1]!;
  return { top, main };
}

// A branch's worktree is <root>/<branch with slashes as dashes>. An existing local branch is
// checked out, a remote one (origin/<branch>, or a remote ref given directly) is tracked, and
// anything else becomes a new branch from `from`. Untracked .env* files and node_modules trees are
// symlinked from the main checkout, so the worktree runs and type-checks immediately.
export function createWorktree(cwd: string, root: string, input: string, from = "HEAD"): string {
  const { main } = worktreeOf(cwd);
  const remoteGiven = hasRef(main, `refs/remotes/${input}`);
  const branch = remoteGiven ? input.slice(input.indexOf("/") + 1) : input;
  if (Bun.spawnSync(["git", "check-ref-format", "--branch", branch]).exitCode !== 0) throw new Error(`invalid branch name: ${branch}`);
  const path = join(root, branch.replaceAll("/", "-"));
  if (existsSync(path)) {
    const current = existsSync(join(path, ".git")) ? git(path, ["rev-parse", "--abbrev-ref", "HEAD"], true) : "";
    if (current === branch && worktreeOf(path).main === main) return path;
    throw new Error(`${path} already exists and is not ${branch} of ${main}`);
  }
  git(main, ["fetch", "--prune", "--quiet"], true); // Offline is fine; local refs still work.
  mkdirSync(root, { recursive: true });
  const remote = remoteGiven ? input : hasRef(main, `refs/remotes/origin/${branch}`) ? `origin/${branch}` : undefined;
  if (hasRef(main, `refs/heads/${branch}`)) git(main, ["worktree", "add", path, branch]);
  else if (remote) git(main, ["worktree", "add", "--track", "-b", branch, path, remote]);
  else git(cwd, ["worktree", "add", "-b", branch, path, from]);
  linkShared(main, path);
  return path;
}

function linkShared(source: string, target: string): void {
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const from = join(dir, entry.name);
      const to = join(target, relative(source, from));
      const link = entry.name === "node_modules" ? entry.isDirectory() : entry.name.startsWith(".env") && entry.isFile();
      if (link) {
        if (lstatSync(to, { throwIfNoEntry: false })) continue; // Tracked, like .env.example.
        mkdirSync(dirname(to), { recursive: true });
        symlinkSync(from, to);
        console.error(`linked ${relative(source, from)}`);
      } else if (entry.isDirectory()) {
        walk(from);
      }
    }
  };
  walk(source);
}

// Uncommitted or untracked work that removing the worktree would lose.
export function isDirty(top: string): boolean {
  return git(top, ["status", "--porcelain"]) !== "";
}

export function removeWorktree(main: string, top: string): void {
  try { git(main, ["worktree", "remove", "--force", top]); }
  catch {
    // A locked or half-registered worktree: delete it and let git forget it.
    rmSync(top, { recursive: true, force: true });
    git(main, ["worktree", "prune"]);
  }
}

