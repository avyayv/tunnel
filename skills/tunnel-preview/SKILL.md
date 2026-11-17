---
name: tunnel-preview
description: Use tunnel to run and share persistent local web previews (any dev-server command, a Compose stack, or an already-running app) and to create and delete worktrees with everything they started. Use whenever starting or sharing a development preview; do not assume a particular domain, IP, or port.
---

# Tunnel Preview

When asked to run, preview, or share a branch, use the installed `tunnel` command instead of starting a server in the background yourself or creating another proxy. Run `tunnel --help` to confirm the installed version's workflow.

## Required Workflow

1. Identify the exact source directory. Preserve unrelated changes and existing routes. Inspect `tunnel ls` before registering a name.
2. Choose a stable name per worktree, and let tunnel own the app's lifecycle so expiry and `tunnel rm` clean it up:
   - **Any app (dev server, API, static server):** give its normal start command after `--`.
     ```sh
     tunnel up --name <repo>-<task> <worktree> -- npm run dev
     tunnel up --name <repo>-<task> <worktree> -- 'uvicorn app:app --port $PORT'
     ```
     Tunnel runs it detached in its own process group, with `PORT` set to a free port and `TUNNEL_URL` set to the preview URL, and routes the port the command answers HTTP on (it also finds ports the app picked itself, like Vite's 5173). Pass `--port` if the app serves a known port or several HTTP ports. A single argument runs through `sh`, so quote it to use `$PORT`, `&&` or pipes. Do not wrap it in `nohup`, `&`, or a background shell: tunnel already keeps it running after your shell exits.
   - **Compose stack:** with no command, tunnel starts the directory's Compose file.
     ```sh
     tunnel up --name <repo>-<task> --build <worktree>
     ```
     Start only required services with repeatable `--service` and `--profile`. For several published ports, select `--target <service>:<container-port>`. Volumes are kept by default; use `--disposable` only for explicitly throwaway data.
   - Load the repository's env/secrets through its normal configuration. Set its public/OAuth origin before boot with repeatable `--url-env <VARIABLE>`, using the variable names the repo actually consumes. Tunnel injects the final URL; it does not configure OAuth providers.
   - New previews expire after 30 minutes on macOS via launchd, and expiry stops the command or stack. Use `tunnel extend <name> 1h` for more time. Do not opt out with `--ttl never` unless requested. Other platforms require `--ttl never`; report that teardown is manual.
   - Rerun the same `tunnel up` (no need to repeat the command) after code changes that need a restart or rebuild.
3. If `up` fails, read its error: it includes the command's last output. `tunnel logs <name>` (`-f` to follow) shows the full output of a command preview. Fix the cause rather than retrying blindly; raise `--wait` (default 2m) only for slow first builds.
4. Only for a server something else must keep running: `tunnel up --local --name <name> --port <port> <worktree>`. Tunnel then only routes it; expiry does not stop it. Prefer a command preview.
5. If `up` warns that the app answers 400/403 for the preview hostname, the app checks the Host header: allow it (Vite/SvelteKit `server.allowedHosts`, Astro `--allowed-hosts`, Django `ALLOWED_HOSTS`, Jupyter `--ServerApp.allow_remote_access=True`) in the worktree, with the user's agreement if it is a committed config change. If `up` refuses because another process listens on the app's port, give the app `$PORT` (Vite: `npm run dev -- --port $PORT --strictPort`); never stop the other process. On Linux, loopback-only listeners usually cannot be reached from the Docker proxy; choose a Docker-reachable bind and protect it with a firewall. Do not weaken network isolation silently.
6. Use the complete URL from `tunnel up` / `tunnel ls`, including its port. No domain or IP is universal. Never substitute a guessed localhost link.
7. Before sharing, verify:
   - the preview names the intended worktree, and `tunnel ls` does not show its command as `exited`;
   - the served content contains the distinctive expected change;
   - the full tunnel URL returns the expected content;
   - `tunnel doctor` reports the proxy, DNS and preview state. Authentication may require a manual HTTP check.
8. If hostname resolution fails, `curl --resolve <hostname>:<proxy-port>:<machine-IP> <full-URL>` can diagnose proxy routing. It does **not** prove native DNS or reachability from another device. Report those limits explicitly.

## Worktrees

- Create worktrees with `tunnel new <branch>` (prints the path; `cd "$(tunnel new <branch>)"`), not a bare `git worktree add`, so `.env*` files and `node_modules` are linked in.
- Delete them with `tunnel rm <worktree>`: it stops every preview started there (commands and Compose stacks) and removes Compose stacks started there by hand, with their volumes and images. It refuses uncommitted or untracked work; pass `--force` only when the user confirms that work can go, and `--keep-volumes` when they want the data.
- `tunnel prune --dry-run` lists what deleted directories left behind; run `tunnel prune` when disk is short or the user asks.

## Setup and Recovery

- Requires Bun and running Docker (for the shared Caddy proxy); Compose apps need Compose 2.24+. `tunnel up` bootstraps the proxy, not these dependencies.
- `tunnel setup --ip <reachable-IP>` resolves ambiguous address detection. Use a tailnet address for tailnet clients or a LAN address for devices on that LAN. Do not choose a public address or broaden exposure without permission.
- `tunnel setup --domain <dedicated-domain>` uses externally managed wildcard DNS. `--dns split` also starts CoreDNS on first proxy bootstrap; the user must configure a restricted nameserver on their network. `--domain auto --dns external` returns to nip.io.
- DNS is not access control. The default proxy binds all interfaces. Restrict with `--bind <local-interface-IP>` and firewall rules. No public relay, TLS, or authentication is provided.
- Do not change setup with live previews, overwrite unmanaged site files, retarget another worktree's name, or restart another proxy. Inspect ownership conflicts and ask before disrupting other services.
- `tunnel down <exact-name>` stops a command preview's whole process group or a Compose project; for `--local` apps it removes only the route. Never remove unrelated previews.
- Do not output credentials or `.env` values.

## Reporting

Report the exact preview URL, what it runs, source/worktree state, expiry, volume-retention policy (Compose), and what was verified. Distinguish app HTTP, proxy routing, DNS resolution, and user-network reachability. Never claim remote reachability from a local-only check.
