// Removing everything a directory started: on tunnel rm, on prune, and hourly for deleted worktrees.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot, worktreeRoot, type Config } from "./config";
import { composeProjects, defaultProjectName, projectResources, pruneBuildLeftovers, removeProject } from "./compose";
import { teardown } from "./preview";
import { errorMessage } from "./sh";
import { deleteRetained, readPreviews, readRetained } from "./state";
import { inside, isDirty, removeWorktree, worktreeOf } from "./worktree";

// Removes everything for directories matching `gone`: tunnel's previews (stopping their
// commands and stacks), retained volumes, and Compose stacks started by hand. A stack with
// containers names its directory; one with only volumes left is matched by Compose's default
// project name (`byName`). Returns what it removed, or with dryRun what it would remove.
async function removeAll(config: Config, gone: (dir: string) => boolean, { volumes, dryRun = false, byName }: {
  volumes: boolean; dryRun?: boolean; byName?: string;
}): Promise<string[]> {
  const removed: string[] = [];
  const act = async (label: string, fn: () => unknown) => {
    if (!dryRun) await fn();
    removed.push(label);
  };
  for (const preview of readPreviews(config).filter((p) => gone(p.dir))) {
    await act(`preview ${preview.name}`, () => teardown(config, preview, { volumes: preview.disposable || volumes }));
  }
  const owned = new Set(readPreviews(config).flatMap((p) => p.project ? [p.project] : []));
  for (const [project, dir] of composeProjects()) {
    if (gone(dir) && !owned.has(project)) await act(`stack ${project}`, () => removeProject(project, { volumes }));
  }
  if (volumes) {
    for (const kept of readRetained(config).filter((r) => gone(r.dir))) {
      await act(`volumes of ${kept.project}`, () => { removeProject(kept.project, { volumes: true }); deleteRetained(config, kept.project); });
    }
    if (byName && !composeProjects().has(byName) && projectResources(byName).volumes.length) {
      await act(`volumes of ${byName}`, () => removeProject(byName, { volumes: true }));
    }
  }
  return removed;
}

// Deletes the worktree containing `dir` with everything started in it; returns the main checkout.
export async function rm(config: Config, dir: string, { force, keepVolumes }: { force: boolean; keepVolumes: boolean }): Promise<string> {
  const { top, main } = worktreeOf(dir);
  if (top === main) throw new Error(`${top} is the repository's main checkout, not a worktree`);
  if (!force && isDirty(top)) throw new Error(`${top} has uncommitted or untracked changes; commit them or pass --force`);
  for (const label of await removeAll(config, (d) => inside(top, d), { volumes: !keepVolumes, byName: defaultProjectName(top) })) {
    console.error(`tunnel: removed ${label}`);
  }
  removeWorktree(main, top);
  console.error(`tunnel: removed worktree ${top}`);
  return main;
}

export async function prune(config: Config, { dryRun }: { dryRun: boolean }): Promise<void> {
  for (const label of await removeAll(config, (dir) => !existsSync(dir), { volumes: true, dryRun })) {
    console.log(`${dryRun ? "would remove" : "removed"} ${label}`);
  }
  if (!dryRun) pruneBuildLeftovers();
  console.log(`${dryRun ? "would also remove" : "removed"} untagged images and build cache older than a week`);
}

// The expiry job prunes at most hourly, and only what deleted worktrees under the worktree
// directory left behind, since tunnel created those; anything else waits for an explicit prune.
const PRUNE_EVERY = 60 * 60_000;
const pruneStamp = (config: Config) => join(stateRoot(config), "pruned");
export const pruneDue = (config: Config) => (statSync(pruneStamp(config), { throwIfNoEntry: false })?.mtimeMs ?? 0) + PRUNE_EVERY <= Date.now();

export async function scheduledPrune(config: Config): Promise<void> {
  mkdirSync(dirname(pruneStamp(config)), { recursive: true });
  writeFileSync(pruneStamp(config), ""); // Before pruning, so a failing prune is retried an hour later, not every minute.
  const root = worktreeRoot();
  try {
    for (const label of await removeAll(config, (dir) => inside(root, dir) && !existsSync(dir), { volumes: true })) {
      console.log(`tunnel: removed ${label} (its worktree is gone)`);
    }
    pruneBuildLeftovers();
  } catch (error) {
    console.error(`tunnel: prune failed; retrying in an hour: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
