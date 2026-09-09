# tunnel

Give local apps named URLs, without buying a domain. Tunnel routes HTTP requests through a shared Caddy proxy to a Docker Compose stack or an already-running development server.

```sh
tunnel up --name hello ./examples/hello
# http://hello.<your-IP>.nip.io:8000

tunnel ls
tunnel down hello
```

This is a local reverse proxy, **not a public relay**. A link works only on devices that can reach your machine's selected IP and proxy port (for example, devices on the same LAN or Tailscale network).

## Install and Try It

Requires [Bun](https://bun.sh), Git, and **running Docker with Docker Compose v2**. Tailscale is optional; use it when sharing across a tailnet. Setup does not install these dependencies.

Install from source (repository access is required):

```sh
git clone https://github.com/avyayv/tunnel.git
cd tunnel
mkdir -p ~/.local/bin
ln -s "$PWD/cli.ts" ~/.local/bin/tunnel
export PATH="$HOME/.local/bin:$PATH"
tunnel --help
```

Keep the clone in place: the executable loads supporting files from it. If `~/.local/bin/tunnel` already exists, inspect it before replacing it. Add the PATH setting to your shell configuration if needed. Update with `git pull --ff-only` in the clone.

Then, from the clone:

```sh
tunnel up --name hello ./examples/hello
tunnel ls
tunnel doctor
# Open the complete URL printed by up, including the port.
tunnel down hello
```

The example launches nginx on a dynamically assigned host port. `down` stops that Compose project and removes its route. The shared proxy stays running for other apps. Applications and Docker network forwarding may need a moment to become ready after `up`; verify with `doctor` or an HTTP request before sharing.

**Network exposure:** the proxy and the example's application port bind all interfaces by default. Use only on a trusted network, or configure a local interface bind and firewall rules before starting. Tunnel provides no authentication, HTTPS, or access control. A private DNS name does not make a service private.

## Route Your App

### Docker Compose

```sh
tunnel up --name my-app --build /path/to/worktree
# If several host ports are published, select the web service's port:
tunnel up --name my-app --port 5173 /path/to/worktree
```

Each name gets its own Compose project. Tunnel reads your Compose file; it does **not** allocate or rewrite its ports. Two services cannot claim the same host IP/port. For a Compose port mapping `5173:80`, select `--port 5173` (the host side), not `80` (the container side). `--build` rebuilds images; registering a URL alone does not refresh old image-built source.

Repeat `up` in the same directory to reuse a registered name. Use an explicit name if several previews share a directory. Names cannot be silently moved to another worktree or switched between Compose and local mode.

### Already-Running Server

```sh
tunnel up --local --name my-app --port 5173 /path/to/worktree
```

`--local` bypasses a Compose file. The directory is optional (defaults to the current directory); it records which source checkout owns the preview, not how to launch it. Without a Compose file, supplying `--port` also selects local mode. Tunnel does not start, supervise, or stop this server: keep it running with your service manager. `tunnel down my-app` removes only its route.

The app must accept requests from Docker via `host.docker.internal`. On Linux, a host app bound only to `127.0.0.1` generally cannot be reached from a bridge container. Bind to a Docker-reachable interface and restrict access with firewall rules; do not assume loopback bindings work on every Docker runtime. Frameworks with host allowlists must allow the printed hostname.

## Configure Your Network

No setup is needed when Tunnel can identify an address: it prefers `tailscale ip -4`, otherwise a single private LAN IPv4 address. If detection is ambiguous, select one:

```sh
tunnel setup --ip 192.168.1.10
# Replace the example IP with this machine's actual reachable address.
```

Default URLs use `<name>.<IP>.nip.io`, so no custom DNS or CoreDNS service is required. This depends on the external `nip.io` DNS service. Some resolvers block private-IP answers as DNS-rebinding protection; use a custom domain/split DNS if yours does. IPv6-only networks are not supported. Automatic addresses are detected each invocation; if an address changes, temporarily set `TUNNEL_PROXY_IP` to the old IP shown in `tunnel ls`, run `tunnel down <name>` for each affected route, then recreate them with the new IP. Prefer a stable IP in setup.

### Optional Custom Domain

For a domain you control:

```sh
tunnel setup --domain dev.example.com --ip 192.168.1.10
```

Configure wildcard DNS `*.dev.example.com` to resolve to that IP. The command saves configuration; it does not edit your DNS provider.

Alternatively, for private split DNS:

```sh
tunnel setup --domain dev.example.com --ip 100.64.0.10 --dns split
```

On first proxy bootstrap, `up` starts CoreDNS on TCP/UDP port 53 as well as Caddy. Configure your network resolver (for example, a Tailscale restricted nameserver) to send queries for `dev.example.com` to that IP. Port 53 must be available and reachable by those clients. An already-running compatible proxy is reused, not restarted or reconfigured; adding DNS to such a deployment requires managing its DNS service separately.

Return to default DNS with `tunnel setup --domain auto --dns external`. Run `tunnel down <name>` for every registered app before changing domain, IP, proxy port, bind, DNS mode, or state directory. This stops Compose apps, so plan for interruption. Setup refuses changes to active routes and never shuts down shared services.

### Settings

Settings are stored in `~/.config/tunnel/config.json`. Environment values override saved settings, which override defaults. `setup` changes saved values; an environment override still wins for the current invocation.

| Setup Flag | Environment Variable | Default |
| --- | --- | --- |
| `--domain` | `TUNNEL_DOMAIN` | `<detected-IP>.nip.io` |
| `--ip` | `TUNNEL_PROXY_IP` | Tailscale, then unambiguous private LAN IPv4 |
| `--port` | `TUNNEL_PROXY_PORT` | `8000` |
| `--bind` | `TUNNEL_PROXY_BIND` | `0.0.0.0` (all interfaces) |
| `--dns` | `TUNNEL_DNS` | `external`; `split` enables CoreDNS bootstrap |
| `--state-dir` | `TUNNEL_STATE_DIR` | Same as config directory; holds route files and app mappings |
| — | `TUNNEL_CONFIG_DIR` | `~/.config/tunnel` |

For example, `tunnel setup --bind 100.64.0.10` restricts new proxy listeners to that **local interface**; it does not restrict your app's own published ports. Use an IP actually assigned to the Docker host/runtime. Some VM-backed Docker runtimes cannot bind a host VPN interface: verify the runtime's behavior and use firewall controls where necessary.

Older installs used `~/.selfbench` for state. To retain existing routes, explicitly configure the old domain/IP and `--state-dir ~/.selfbench` before using the new CLI. Nothing is migrated or deleted automatically.

## Troubleshoot and Verify

```sh
tunnel ls
tunnel doctor
```

`ls` lists registered mappings, not guaranteed live apps. `doctor` checks Docker/Compose, proxy ownership, wildcard DNS, site targets, and HTTP responses for registered apps. It exits nonzero on failures. Authenticated apps may need a manual check; HTTP 4xx is reported as a failure.

- **Port conflict / wrong proxy:** A compatible proxy is a running Caddy container publishing the configured port and mounting this installation's `dev-proxy/sites` directory (the route files). This is what the ownership check verifies. A mismatch produces an explicit error; inspect `docker ps` and `docker inspect <container>` rather than overwriting another proxy.
- **502 response:** confirm the app is running and Docker can reach its host port.
- **DNS failure:** verify the IP, resolver policy, and split-DNS configuration. `curl --resolve` can test routing separately, but does not prove normal DNS works.
- **Links fail on another device:** check its network route, tailnet permissions, and firewalls. A successful local request does not prove remote reachability.
- **OAuth:** configure your provider's exact allowed callback URLs and follow its wildcard rules. Tunnel does not provision OAuth apps or guarantee wildcard callback support.

## Coding Agents

```sh
tunnel --skill
```

This prints the bundled [Tunnel Preview skill](skills/tunnel-preview/SKILL.md), a reusable Markdown instruction file for coding assistants: stable names, Compose/local lifecycle, configuration, safety, and verification before sharing links. Install the same file in your agent's skill directory, for example:

```sh
mkdir -p ~/.codex/skills/tunnel-preview
cp skills/tunnel-preview/SKILL.md ~/.codex/skills/tunnel-preview/SKILL.md
```

Refresh that copy after updating Tunnel, or use `tunnel --skill` to read the current instructions directly.

## Development

```sh
bun test
bun cli.ts --help
```

The tests use fake Docker commands and isolated temporary state; they do not start or stop real containers.
