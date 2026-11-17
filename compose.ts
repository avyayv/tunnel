// Compose previews: tunnel runs the stack under its own project name, so several previews of one
// project can run side by side, and removes it by label.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot, type Config } from "./config";
import { answeringHTTP } from "./net";
import { sh, type Env } from "./sh";
import { saveRetained, type Preview } from "./state";

const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

export const composeFile = (dir: string) => COMPOSE_FILES.map((name) => join(dir, name)).find(existsSync);

const compose = (args: readonly string[], env?: Env) => sh("docker", ["compose", ...args], { env });
const overridePath = (config: Config, name: string) => join(stateRoot(config), "compose", `${name}.yaml`);

// Starts (or updates) the preview's stack and returns the host port to route.
export async function startCompose(config: Config, preview: Preview, { build, env, waitMs }: { build: boolean; env: Env; waitMs: number }): Promise<number> {
  const file = composeFile(preview.dir);
  if (!file) throw new Error(`no Compose file in ${preview.dir}`);
  // Compose loads the override next to the default file only when no --file is given, so do it here.
  const files = [file, file.replace(/\.(ya?ml)$/, ".override.$1")].filter(existsSync);
  const base = (files: string[]) => ["--project-name", preview.project!, ...files.flatMap((f) => ["--file", f]),
    ...preview.profiles.flatMap((profile) => ["--profile", profile])];
  // Docker Desktop and OrbStack forward host.docker.internal to the Mac's loopback, so the proxy
  // still reaches loopback-only ports there; Linux bridge containers cannot.
  const override = previewOverride(base(files), env, { keepPorts: !!preview.fixedPort, loopback: process.platform === "darwin" });
  const path = overridePath(config, preview.name);
  if (override) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, override);
    files.push(path);
  } else {
    rmSync(path, { force: true }); // Left by an earlier up whose stack needed one.
  }
  const args = base(files);
  compose([...args, "up", "-d", ...(build ? ["--build"] : []), ...preview.services], env);
  if (preview.target) return publishedPort(args, preview.target, env);
  const ports = publishedPorts(args, env);
  if (preview.fixedPort) {
    if (!ports.includes(preview.fixedPort)) throw new Error(`port ${preview.fixedPort} is not published by this stack`);
    return preview.fixedPort;
  }
  if (ports.length === 1) return ports[0]!;
  // Stacks often publish databases beside the app; route to the only port that speaks HTTP. The
  // app may still be booting, so keep asking until one answers or time runs out.
  const deadline = Date.now() + waitMs;
  for (;;) {
    const http = ports.length ? await answeringHTTP(ports) : [];
    if (http.length === 1) return http[0]!;
    if (http.length > 1 || Date.now() >= deadline) {
      throw new Error(`expected one published port, found ${ports.length}${http.length ? ` (${http.length} answer HTTP)` : ""}; `
        + "select one with --target SERVICE:PORT or --port");
    }
    await Bun.sleep(500);
  }
}

// Removes the stack, and keeps a record of its volumes unless they went too.
export function stopCompose(config: Config, preview: Preview, { volumes }: { volumes: boolean }): void {
  if (!preview.project) throw new Error("Compose preview is missing its project");
  removeProject(preview.project, { volumes });
  if (!volumes && projectResources(preview.project).volumes.length) saveRetained(config, { project: preview.project, dir: preview.dir });
  rmSync(overridePath(config, preview.name), { force: true });
}

// Previews of one project must not share host ports or names with each other or the proxy. Every
// pinned port is republished on an ephemeral host port (unless keepPorts), and fixed container,
// volume and network names fall back to project-prefixed ones; external resources stay shared.
// With loopback, ports published on all interfaces move to 127.0.0.1, so only the proxy is
// reachable from other devices. Returns a Compose override, or undefined if nothing needs changing.
function previewOverride(base: readonly string[], env: Env, { keepPorts, loopback }: { keepPorts: boolean; loopback: boolean }): string | undefined {
  const out = compose([...base, "config", "--format", "json"], env);
  if (!out) return undefined;
  type Port = { target: number; published?: string; protocol?: string; host_ip?: string; app_protocol?: string; mode?: string };
  type Resource = { name?: string; external?: boolean };
  const config = JSON.parse(out) as {
    name: string;
    services?: Record<string, { ports?: Port[]; container_name?: string }>;
    volumes?: Record<string, Resource>;
    networks?: Record<string, Resource>;
  };
  // JSON is valid YAML. !override replaces a list instead of appending to it; !reset removes a
  // key (both Compose 2.24+).
  const key = JSON.stringify;
  const sections: string[] = [];
  const services: string[] = [];
  for (const [name, service] of Object.entries(config.services ?? {})) {
    const fields: string[] = [];
    const ports = service.ports ?? [];
    const exposed = (port: Port) => loopback && [undefined, "", "0.0.0.0", "::"].includes(port.host_ip);
    if (ports.some((port) => (!keepPorts && port.published) || exposed(port))) {
      const rewritten = ports.map(({ published, ...port }) => ({
        ...port,
        ...(keepPorts && published ? { published } : {}),
        ...(exposed(port) ? { host_ip: "127.0.0.1" } : {}),
      }));
      fields.push(`    ports: !override ${key(rewritten)}`);
    }
    if (service.container_name) fields.push("    container_name: !reset null");
    if (fields.length) services.push(`  ${key(name)}:`, ...fields);
  }
  if (services.length) sections.push("services:", ...services);
  for (const kind of ["volumes", "networks"] as const) {
    // Compose reports the computed PROJECT_KEY name too, so only other names were set explicitly.
    const named = Object.entries(config[kind] ?? {})
      .filter(([name, resource]) => !resource.external && resource.name && resource.name !== `${config.name}_${name}`);
    if (named.length) sections.push(`${kind}:`, ...named.flatMap(([name]) => [`  ${key(name)}:`, "    name: !reset null"]));
  }
  return sections.length ? `${sections.join("\n")}\n` : undefined;
}

function publishedPorts(base: readonly string[], env: Env): number[] {
  const rows = compose([...base, "ps", "--format", "json"], env);
  // Compose v2 prints one JSON object per line; some versions print a single array.
  const containers = rows.startsWith("[") ? JSON.parse(rows) : rows.split("\n").filter(Boolean).map((row) => JSON.parse(row));
  const ports = new Set<number>();
  for (const container of containers) {
    for (const publisher of (container.Publishers ?? []) as { PublishedPort: number }[]) {
      if (publisher.PublishedPort > 0) ports.add(publisher.PublishedPort);
    }
  }
  return [...ports];
}

function publishedPort(base: readonly string[], target: string, env: Env): number {
  const [service, port] = target.split(":") as [string, string];
  const hostPort = Number(/:(\d+)$/.exec(compose([...base, "port", service, port], env).split("\n")[0] ?? "")?.[1]);
  if (!hostPort) throw new Error(`service ${service} does not publish container port ${port}`);
  return hostPort;
}

// Everything Docker labels as created by a Compose project. External networks and volumes carry
// no project label, so they are never listed.
export function projectResources(project: string) {
  const filter = ["--filter", `label=com.docker.compose.project=${project}`];
  const ids = (...list: string[]) => sh("docker", [...list, ...filter]).split(/\s+/).filter(Boolean);
  return { containers: ids("ps", "-aq"), networks: ids("network", "ls", "-q"), volumes: ids("volume", "ls", "-q") };
}

// Label-based rather than `compose down`, so it covers every profile and still works after the
// worktree or its .env is gone. Images are rebuilt from the build cache by the next up.
export function removeProject(project: string, { volumes }: { volumes: boolean }): void {
  const owned = projectResources(project);
  if (owned.containers.length) {
    sh("docker", ["stop", ...owned.containers]); // Honors each service's stop signal and grace period.
    sh("docker", ["rm", ...(volumes ? ["--volumes"] : []), ...owned.containers]);
  }
  if (owned.networks.length) sh("docker", ["network", "rm", ...owned.networks]);
  if (volumes && owned.volumes.length) sh("docker", ["volume", "rm", ...owned.volumes]);
  // Images Compose built for the project, by reference: deleting a reference only untags an image
  // that another tag still uses. Best effort: another project's container may still run it.
  const images = sh("docker", ["image", "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Repository}}:{{.Tag}}"])
    .split("\n").filter((ref) => ref && !ref.includes("<none>"));
  if (images.length) sh("docker", ["rmi", ...images], { quiet: true });
}

// Every Compose project that has containers, with the directory it was started from.
export function composeProjects(): Map<string, string> {
  const rows = sh("docker", ["ps", "-a", "--filter", "label=com.docker.compose.project", "--format",
    '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}']);
  const projects = new Map<string, string>();
  for (const row of rows.split("\n").filter(Boolean)) {
    const [project, dir] = row.split("\t") as [string, string | undefined];
    if (dir) projects.set(project, dir);
  }
  return projects;
}

// Compose's default project name for a directory.
export const defaultProjectName = (dir: string) => dir.split("/").pop()!.toLowerCase().replace(/[^a-z0-9_-]/g, "");

// Untagged images and week-old build cache are never needed again.
export function pruneBuildLeftovers(): void {
  sh("docker", ["image", "prune", "-f"]);
  sh("docker", ["builder", "prune", "-f", "--filter", "until=168h"]);
}
