#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseDuration, parsePort, settings, worktreeRoot, type Settings } from "./config";
import { logPath } from "./command";
import { parseTTL } from "./lease";
import { cleanup, down, expired, extend, findPreview, installReaperFor, ls, up } from "./preview";
import { prune, pruneDue, rm, scheduledPrune } from "./prune";
import { doctor, setup } from "./setup";
import { errorMessage } from "./sh";
import { acquireLock, readPreviews } from "./state";
import { createWorktree } from "./worktree";

const HELP = `tunnel: worktrees, named URLs for the apps you run in them, and cleanup of both.

Worktrees
  tunnel new BRANCH [--from REF]      create a worktree and print its path
  tunnel rm [DIR] [--force] [--keep-volumes]
                                      delete a worktree and everything started in it

Previews
  tunnel up [options] [DIR] [-- COMMAND...]
                                      run an app in DIR and give it a named URL
  tunnel ls                           list previews
  tunnel logs NAME [-f]               show a command's output
  tunnel extend NAME [30m|2h|never]   renew a lease, or remove it
  tunnel down [NAME|DIR]              stop a preview now

Maintenance
  tunnel cleanup                      remove expired previews
  tunnel prune [--dry-run]            remove what deleted directories left behind, plus
                                      untagged images and week-old build cache
  tunnel setup [--ip IPV4] [--domain DOMAIN|auto] [--port PORT] [--bind IPV4]
               [--dns external|split] [--state-dir DIR] [--worktrees DIR]
  tunnel doctor                       check Docker, the proxy, DNS and every preview
  tunnel --skill                      print the coding-agent skill

What up runs
  -- COMMAND...      Any command. Tunnel starts it in the background with PORT set to a free
                     port, routes the port it answers HTTP on, and stops it (its whole process
                     group) on down, expiry or rm. Output goes to tunnel logs NAME. A single
                     argument runs through sh, so tunnel up -- 'vite --port $PORT' works.
  (nothing)          The Compose file in DIR. Fixed host ports and container, volume and
                     network names become per-preview, so stacks never collide.
  --local --port N   An app you started yourself. Only its route is managed.
  Repeating up in DIR reruns the same thing (rebuilding or restarting it) and renews the lease.

Options for up
  --name NAME          preview name; default DIR's previous name, or a random one
  --port PORT          the port to route: the one the command listens on, a Compose host port,
                       or a local app's port
  --url-env VAR        set VAR to the preview URL before the app starts (repeatable); commands
                       also get TUNNEL_URL
  --ttl 30m|2h|never   lease length; new previews get 30m (expiry needs macOS)
  --wait 2m            how long to wait for the app to answer HTTP
  Compose only:
  --target SVC:PORT    route the host port published for a service's container port
  --service SVC        start only these services (repeatable)
  --profile PROFILE    enable a Compose profile (repeatable)
  --build              rebuild images
  --disposable         delete volumes on teardown (by default they are kept for the next up)

Requires Bun and Docker (for the shared Caddy proxy; Compose 2.24+ for Compose apps).
URLs reach devices on your LAN or tailnet only: no public relay, HTTPS or access control.`;

type FlagKind = "value" | "list" | "switch";

// Flags from `spec` anywhere in args, the rest as positional, and everything after -- as a command.
function parseFlags(args: readonly string[], spec: Record<string, FlagKind>, { maxPositional = 0, usage = "" } = {}) {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  const split = args.indexOf("--");
  const own = split === -1 ? args : args.slice(0, split);
  for (let i = 0; i < own.length; i++) {
    const arg = own[i]!;
    const kind = spec[arg];
    if (!kind) {
      if (arg.startsWith("-")) throw new Error(`unexpected argument: ${arg}${usage ? `\nusage: ${usage}` : ""}`);
      positional.push(arg);
    } else if (kind === "switch") {
      flags.set(arg, []);
    } else {
      const value = own[++i];
      if (value === undefined || value.startsWith("-")) throw new Error(`${arg} requires a value`);
      if (kind === "value" && flags.has(arg)) throw new Error(`${arg} given twice`);
      flags.set(arg, [...(flags.get(arg) ?? []), value]);
    }
  }
  if (positional.length > maxPositional) throw new Error(`unexpected argument: ${positional[maxPositional]}${usage ? `\nusage: ${usage}` : ""}`);
  return {
    positional,
    command: split === -1 ? undefined : args.slice(split + 1),
    has: (flag: string) => flags.has(flag),
    value: (flag: string): string | undefined => flags.get(flag)?.[0],
    list: (flag: string): string[] => flags.get(flag) ?? [],
  };
}

async function upCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args, {
    "--name": "value", "--port": "value", "--target": "value", "--ttl": "value", "--wait": "value",
    "--build": "switch", "--local": "switch", "--disposable": "switch",
    "--service": "list", "--profile": "list", "--url-env": "list",
  }, { maxPositional: 1 });
  if (flags.command?.length === 0) throw new Error("missing command after --");
  const port = flags.value("--port");
  const target = flags.value("--target");
  if (port && target) throw new Error("use either --port or --target, not both");
  if (target) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*:\d+$/.test(target)) throw new Error("--target must be SERVICE:CONTAINER_PORT");
    parsePort(target.split(":")[1]!, "--target port");
  }
  if (flags.command && flags.has("--local")) throw new Error("--local routes an app that is already running; it cannot take a command");
  const ttl = flags.value("--ttl");
  const wait = flags.value("--wait");
  const options = {
    dir: resolve(flags.positional[0] ?? process.cwd()),
    name: flags.value("--name"),
    command: flags.command,
    local: flags.has("--local"),
    port: port ? parsePort(port) : undefined,
    target,
    ttl: ttl === undefined ? undefined : parseTTL(ttl),
    waitMs: wait === undefined ? 120_000 : parseDuration(wait, "--wait", { min: 0 }),
    build: flags.has("--build"),
    disposable: flags.has("--disposable"),
    services: flags.list("--service"),
    profiles: flags.list("--profile"),
    urlEnv: flags.list("--url-env"),
  };
  await locked(() => up(settings(), options));
}

const SETUP_FLAGS: Record<string, keyof Settings> = {
  "--ip": "ip", "--domain": "domain", "--port": "port", "--bind": "bind", "--dns": "dns", "--state-dir": "stateDir", "--worktrees": "worktrees",
};

async function main([command, ...args]: string[]): Promise<void> {
  const noArgs = () => { if (args.length) throw new Error(`${command} takes no arguments`); };
  switch (command) {
    case undefined: case "help": case "--help": case "-h":
      return console.log(HELP);
    case "--skill":
      return console.log(readFileSync(join(import.meta.dir, "skills/tunnel-preview/SKILL.md"), "utf8"));
    case "up":
      return upCommand(args);
    case "down": {
      const flags = parseFlags(args, {}, { maxPositional: 1, usage: "tunnel down [NAME|DIR]" });
      const target = flags.positional[0] ?? process.cwd();
      return locked(() => { const config = settings(); return down(config, findPreview(config, target, resolve(target))); });
    }
    case "extend": {
      const flags = parseFlags(args, {}, { maxPositional: 2, usage: "tunnel extend NAME [30m|2h|never]" });
      if (!flags.positional[0]) throw new Error("usage: tunnel extend NAME [30m|2h|never]");
      const ttl = parseTTL(flags.positional[1] ?? "30m");
      return locked(() => extend(settings(), flags.positional[0]!, ttl));
    }
    case "ls":
      noArgs();
      return ls(settings());
    case "logs": {
      const flags = parseFlags(args, { "-f": "switch" }, { maxPositional: 1, usage: "tunnel logs NAME [-f]" });
      const config = settings();
      const preview = findPreview(config, flags.positional[0] ?? process.cwd(), resolve(flags.positional[0] ?? process.cwd()));
      if (preview.mode !== "command") throw new Error(`${preview.name} runs no command of tunnel's; its output is wherever it was started`);
      const tail = Bun.spawn(["tail", "-n", "200", ...(flags.has("-f") ? ["-f"] : []), logPath(config, preview.name)], { stdio: ["inherit", "inherit", "inherit"] });
      process.exitCode = await tail.exited;
      return;
    }
    case "doctor":
      noArgs();
      return doctor(settings());
    case "cleanup": {
      // The launchd job runs `cleanup --scheduled`: it only locks when something is due, and it
      // skips (with a log line) a tick while another command runs.
      const scheduled = args[0] === "--scheduled";
      if (args.length > (scheduled ? 1 : 0)) throw new Error("cleanup takes no arguments");
      if (scheduled && !readPreviews(settings()).some(expired) && !pruneDue(settings())) return;
      return locked(async () => {
        const config = settings();
        await cleanup(config);
        if (scheduled && pruneDue(config)) await scheduledPrune(config);
      }, { wait: !scheduled });
    }
    case "new": {
      const flags = parseFlags(args, { "--from": "value" }, { maxPositional: 1 });
      if (!flags.positional[0]) throw new Error("usage: tunnel new BRANCH [--from REF]");
      return locked(() => {
        const path = createWorktree(process.cwd(), worktreeRoot(), flags.positional[0]!, flags.value("--from"));
        // Worktrees get cleaned up after even when no preview ever ran.
        if (process.platform === "darwin") {
          try { const config = settings(); installReaperFor(config, readPreviews(config)); }
          catch (error) { console.error(`tunnel: worktree created, but automatic pruning is not installed: ${errorMessage(error)}`); }
        }
        console.log(path);
      });
    }
    case "rm": {
      const flags = parseFlags(args, { "--force": "switch", "--keep-volumes": "switch" }, { maxPositional: 1, usage: "tunnel rm [DIR] [--force] [--keep-volumes]" });
      const dir = resolve(flags.positional[0] ?? process.cwd());
      return locked(async () => console.log(await rm(settings(), dir, { force: flags.has("--force"), keepVolumes: flags.has("--keep-volumes") })));
    }
    case "prune": {
      const flags = parseFlags(args, { "--dry-run": "switch" }, { usage: "tunnel prune [--dry-run]" });
      return locked(() => prune(settings(), { dryRun: flags.has("--dry-run") }));
    }
    case "setup": {
      const flags = parseFlags(args, Object.fromEntries(Object.keys(SETUP_FLAGS).map((flag) => [flag, "value" as const])));
      const changes: Settings = {};
      for (const [flag, key] of Object.entries(SETUP_FLAGS)) {
        const value = flags.value(flag);
        if (value === undefined) continue;
        Object.assign(changes, { [key]: key === "domain" && value === "auto" ? undefined : key === "stateDir" || key === "worktrees" ? resolve(value) : value });
      }
      return locked(() => setup(changes));
    }
    default:
      throw new Error(`unknown command: ${command}\n\n${HELP}`);
  }
}

// Commands that change previews or settings run one at a time. Settings are read under the lock,
// so a concurrent setup cannot leave a command using stale ones.
async function locked(fn: () => unknown, { wait = true } = {}): Promise<void> {
  const release = acquireLock({ wait });
  if (!release) return;
  try { await fn(); } finally { release(); }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`tunnel: ${errorMessage(error)}`);
  process.exitCode = 1;
}
