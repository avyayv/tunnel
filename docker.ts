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

// Previews of one project must not share host ports or names with each other or the proxy. Every
// pinned port is republished on an ephemeral host port (unless keepPorts), and fixed container,
// volume and network names fall back to project-prefixed ones; external resources stay shared.
// With loopback, ports published on all interfaces move to 127.0.0.1, so only the proxy is
// reachable from other devices. Returns a Compose override, or undefined if nothing needs changing.
export function previewOverride(base: readonly string[], env: Env, { keepPorts, loopback }: { keepPorts: boolean; loopback: boolean }): string | undefined {
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
