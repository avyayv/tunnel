export type Env = Record<string, string>;

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

export function compose(args: readonly string[], env?: Env): string {
  return sh("docker", ["compose", ...args], { env });
}

// `base` selects the project, file, and profiles.
export function publishedPorts(base: readonly string[], env: Env): string[] {
  const rows = compose([...base, "ps", "--format", "json"], env);
  // Compose v2 prints one JSON object per line; some versions print a single array.
  const containers = rows.startsWith("[") ? JSON.parse(rows) : rows.split("\n").filter(Boolean).map((row) => JSON.parse(row));
  const ports = new Set<string>();
  for (const container of containers) {
    for (const publisher of (container.Publishers ?? []) as { PublishedPort: number }[]) {
      if (publisher.PublishedPort > 0) ports.add(String(publisher.PublishedPort));
    }
  }
  return [...ports];
}

// Fixed host ports collide with the shared proxy and with other previews, so republish every
// pinned port on an ephemeral host port. Returns a Compose override, or undefined if none is pinned.
export function unpinnedPorts(base: readonly string[], env: Env): string | undefined {
  const out = compose([...base, "config", "--format", "json"], env);
  if (!out) return undefined;
  type Port = { target: number; published?: string; protocol?: string; host_ip?: string; app_protocol?: string; mode?: string };
  const services = (JSON.parse(out).services ?? {}) as Record<string, { ports?: Port[] }>;
  const lines: string[] = [];
  for (const [name, service] of Object.entries(services)) {
    const ports = service.ports ?? [];
    if (!ports.some((port) => port.published)) continue;
    const ephemeral = ports.map(({ published: _, ...port }) => port);
    // JSON is valid YAML; !override replaces the list instead of appending to it (Compose 2.24+).
    lines.push(`  ${JSON.stringify(name)}:`, `    ports: !override ${JSON.stringify(ephemeral)}`);
  }
  return lines.length ? `services:\n${lines.join("\n")}\n` : undefined;
}

export function publishedPort(base: readonly string[], target: string, env: Env): string {
  const [service, port] = target.split(":") as [string, string];
  const out = compose([...base, "port", service, port], env);
  const hostPort = /:(\d+)$/.exec(out.split("\n")[0] ?? "")?.[1];
  if (!hostPort || hostPort === "0") throw new Error(`service ${service} does not publish container port ${port}`);
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
// worktree or its .env is gone.
export function removeProject(project: string, { volumes }: { volumes: boolean }): void {
  const owned = projectResources(project);
  if (owned.containers.length) {
    sh("docker", ["stop", ...owned.containers]); // Honors each service's stop signal and grace period.
    sh("docker", ["rm", ...(volumes ? ["--volumes"] : []), ...owned.containers]);
  }
  if (owned.networks.length) sh("docker", ["network", "rm", ...owned.networks]);
  if (volumes && owned.volumes.length) sh("docker", ["volume", "rm", ...owned.volumes]);
}
