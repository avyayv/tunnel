---
name: tunnel-preview
description: Use tunnel to create and verify persistent local web previews from Compose stacks or existing local apps. Use whenever starting or sharing a development preview; do not assume a particular domain, IP, or port.
---

# Tunnel Preview

Use the installed `tunnel` command instead of creating another proxy. Run `tunnel --help` and `tunnel --skill` to confirm the installed version's workflow.

## Required Workflow

1. Identify the exact source directory and service. Preserve unrelated changes and existing routes. Inspect `tunnel ls` before registering a name.
2. Choose a stable name per worktree. For a Compose app:
   ```sh
   tunnel up --name <repo-or-task> --build <worktree>
   ```
   If the stack publishes multiple ports, select the intended service's host port with `--port <port>`. Tunnel does not allocate ports or rewrite Compose files.
3. For an already-running local app:
   ```sh
   tunnel up --local --name <repo-or-task> --port <port> <worktree>
   ```
   Tunnel only registers its route. Start the app with the machine's persistent service mechanism and verify it survives the launching shell. It must be reachable from Docker via `host.docker.internal`. On Linux, loopback-only listeners usually cannot be reached from bridge containers; choose a Docker-reachable bind and protect it with a firewall. Do not weaken network isolation silently.
4. Use the complete URL from `tunnel ls` / `tunnel up`, including its port. No domain or IP is universal. Defaults use a detected Tailscale IPv4 address, or one unambiguous private LAN IPv4 address, under `nip.io`. Setup can select a custom domain. Never substitute a guessed localhost link.
5. Before sharing, verify:
   - the mapping names the intended worktree and port;
   - the service responds on the intended application route;
   - the served source contains the distinctive expected change;
   - the full tunnel URL returns the expected content;
   - `tunnel doctor` reports the proxy and DNS state. Authentication may require a manual HTTP check.
6. If hostname resolution fails, `curl --resolve <hostname>:<proxy-port>:<machine-IP> <full-URL>` can diagnose proxy routing. It does **not** prove native DNS or reachability from another device. Report those limits explicitly.

## Setup and Recovery

- Requires Bun and running Docker with Compose. `tunnel up` bootstraps Caddy, not these dependencies.
- `tunnel setup --ip <reachable-IP>` resolves ambiguous address detection. Use a tailnet address for tailnet clients or a LAN address for devices on that LAN. Do not choose a public address or broaden exposure without permission.
- `tunnel setup --domain <dedicated-domain>` uses externally managed wildcard DNS. `--dns split` also starts CoreDNS on first proxy bootstrap; the user must configure a restricted nameserver on their network. `--domain auto --dns external` returns to nip.io.
- DNS is not access control. The default proxy binds all interfaces. Restrict with `--bind <local-interface-IP>` and firewall rules. No public relay, TLS, or authentication is provided.
- Do not change setup with live previews, overwrite unmanaged site files, retarget another worktree's name, or restart another proxy. Inspect ownership conflicts and ask before disrupting other services.
- `tunnel down <exact-name>` stops a managed Compose project; for local apps it removes only the route and leaves the app running. Never remove unrelated mappings.
- Rebuild Compose apps after source changes. Route registration alone does not update an image.
- Do not output credentials or `.env` values.

## Reporting

Report the exact preview URL, source/worktree state, and what was verified. Distinguish app HTTP, proxy routing, DNS resolution, and user-network reachability. Never claim remote reachability from a local-only check.
