<h1 align="center">tunnel</h1>

<p align="center">
  <b>Local previews. Named URLs. Automatic cleanup.</b><br>
  Start a Compose app, share it on your LAN or tailnet, and let it expire.
</p>

<p align="center">
  <a href="#quick-start"><img src="https://img.shields.io/badge/Quick_Start-Create_a_preview-0f9d76?style=for-the-badge" alt="Quick start — create a preview"></a>
  <a href="docs/networking.md#configure-your-network"><img src="https://img.shields.io/badge/Network_Setup-Configure_access-111111?style=for-the-badge" alt="Network setup — configure access"></a>
</p>

<p align="center">
  <a href="#branch-previews">Branch previews</a> ·
  <a href="#cleanup">Cleanup</a> ·
  <a href="skills/tunnel-preview/SKILL.md">Agent skill</a>
</p>

<p align="center">
  <img src="docs/media/tunnel-flow.svg" alt="Tunnel starts your Compose services, gives them a named URL through one shared proxy, and tears down the preview after a thirty-minute lease" width="100%">
</p>

Tunnel gives each preview a named URL and a **30-minute lease**. Extend it when you need more time; otherwise its Compose stack is torn down automatically.

> **Private network only:** URLs work only on devices that can reach your machine, such as your LAN or [Tailscale](https://tailscale.com/). Tunnel is not a public relay and provides no authentication or HTTPS. Automatic expiry requires macOS; elsewhere use `--ttl never` and tear previews down manually.

## Quick Start

Install [Bun](https://bun.sh/) and Git, and start Docker with [Compose 2.24 or later](https://docs.docker.com/compose/) (tunnel's generated override files need it). Tested on macOS with OrbStack; Linux is untested. Then install tunnel:

```sh
curl -fsSL https://raw.githubusercontent.com/avyayv/tunnel/main/install.sh | bash
```

Add the printed `~/.local/bin` PATH line to your shell if prompted, then start the included example:

```sh
tunnel up --name hello ./examples/hello
```

Open the **full URL printed by the command**, including its port (for example, `http://hello.192.168.1.10.nip.io:8000`). That's it—your first preview is running. When you're done:

```sh
tunnel down hello
```

By default, previews expire after 30 minutes. To keep one longer, run `tunnel extend hello 1h`. The installer keeps the checkout at `~/.local/share/tunnel`; rerun the install command to update it. If tunnel can't choose an address automatically, see [network setup](docs/networking.md#configure-your-network).

## Branch Previews

From any directory containing a Compose file, start a named preview:

```sh
tunnel up --name my-branch --build .
```

Tunnel starts the Compose app and reuses one shared Caddy proxy for all previews. Without `--port` or `--target`, tunnel sends one GET request to each published port (for up to 30 seconds) to find the one serving HTTP, so your app may see that request. Ports pinned in the Compose file (like `8000:8000`) are republished on free host ports, and fixed `container_name`s and volume or network names get per-preview names (external ones stay shared), so several previews of one project can run at once; when a stack publishes several ports, tunnel routes the one that answers HTTP. A `compose.override.yaml` next to the Compose file is loaded as usual. Use a different name for each worktree. Repeat `up` in the same worktree to reuse its name and renew its lease.

For an app you already started yourself:

```sh
tunnel up --local --name my-app --port 5173 .
```

This borrows the running server: expiry removes its route, **not** the server. For Compose apps with multiple ports or special setup, options like `--target`, `--service`, `--profile`, and `--url-env` are available; see `tunnel --help` and the [networking guide](docs/networking.md).

## Cleanup

| Command | What it does |
| --- | --- |
| `tunnel ls` | Show previews, URLs, and expiry |
| `tunnel extend hello 1h` | Give a preview another hour |
| `tunnel extend hello never` | Disable expiry |
| `tunnel down hello` | Tear down a preview now |
| `tunnel cleanup` | Remove expired previews; retry failures later |

On macOS, a small user launchd job checks expiry every minute, even after your terminal closes. On other platforms, use `--ttl never` and run `tunnel down` yourself. Cleanup removes containers and networks but **keeps Compose volumes by default**. For disposable data, create the preview with `--disposable`; teardown will then remove its volumes too.

## Network Setup and Troubleshooting

Tunnel selects a Tailscale IPv4 address or an unambiguous private LAN address, and uses [nip.io](https://nip.io/) for DNS. If detection is ambiguous, configure the reachable address with `tunnel setup --ip <your-reachable-IPv4>`.

- [Choose an IP, custom domain, or split DNS](docs/networking.md#configure-your-network)
- [Configuration flags and environment variables](docs/networking.md#settings)
- [502s, DNS, port conflicts, OAuth, and interrupted commands](docs/networking.md#troubleshoot-and-verify)

`tunnel doctor` checks Docker, Compose, proxy ownership, wildcard DNS, and registered HTTP targets. A successful local request doesn't prove another device can reach the URL. The proxy binds all interfaces by default: use a trusted network or configure a local bind and firewall. On macOS, Compose previews' own published ports are moved to `127.0.0.1`, so other devices reach apps only through the proxy; on Linux they keep the Compose file's interfaces. DNS names are not access control.

## Coding Agents

`tunnel --skill` prints the bundled [Tunnel Preview skill](skills/tunnel-preview/SKILL.md), which guides agents to use short-lived previews and verify links before sharing them. For Codex, install it with:

```sh
mkdir -p ~/.codex/skills/tunnel-preview
cp skills/tunnel-preview/SKILL.md ~/.codex/skills/tunnel-preview/SKILL.md
```

## Uninstall

Stop active previews first (`tunnel ls`, then `tunnel down <name>`), then remove the command link and checkout:

```sh
rm ~/.local/bin/tunnel
rm -rf ~/.local/share/tunnel
```

This leaves tunnel configuration, retained Compose volumes, and Docker images in place.

## Development

```sh
bun test
bun cli.ts --help
```

Tests use fake Docker/launchctl commands and isolated state, not real containers or scheduled jobs.
