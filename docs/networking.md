# Networking and Configuration

[← README](../README.md)

Tunnel is a local HTTP reverse proxy, not a public relay. Clients must reach the selected IPv4 address and proxy port. It provides no authentication, HTTPS, or access control. Restrict exposure with interface binds and firewall rules; DNS does not provide security.

## Configure Your Network

Tunnel prefers `tailscale ip -4`, otherwise one unambiguous private LAN IPv4 address. If detection is ambiguous, choose the machine's actual reachable address:

```sh
tunnel setup --ip 192.168.1.10
```

Default URLs use `<name>.<IP>.nip.io`. This relies on external nip.io DNS; some resolvers block private-IP answers as DNS-rebinding protection. IPv6-only networks are not supported.

Prefer a stable IP. If an automatic address changes, temporarily set `TUNNEL_PROXY_IP` to the old IP shown in `tunnel ls`, remove the affected previews, then recreate them with the new IP.

### Custom Domain

```sh
tunnel setup --domain dev.example.com --ip 192.168.1.10
```

Configure wildcard DNS `*.dev.example.com` to resolve to that IP. Tunnel saves settings; it does not edit your DNS provider.

### Split DNS

```sh
tunnel setup --domain dev.example.com --ip 100.64.0.10 --dns split
```

On first proxy bootstrap, `up` starts CoreDNS on TCP/UDP port 53 alongside Caddy. Configure a restricted nameserver (for example, in Tailscale) for this domain pointing to the chosen IP. Port 53 must be available and reachable.

An already-running compatible proxy is reused, not restarted or reconfigured. Adding split DNS to that deployment requires managing its DNS service separately.

Return to default DNS with `tunnel setup --domain auto --dns external`. Remove registered previews with their original configuration before changing domain, IP, port, bind, DNS mode, or state directory. Setup refuses changes to active routes and never shuts down shared services.

## Settings

Saved settings live in `~/.config/tunnel/config.json`. Environment values override saved settings, which override defaults. An environment override still wins after `setup`.

| Setup Flag | Environment Variable | Default |
| --- | --- | --- |
| `--domain` | `TUNNEL_DOMAIN` | `<detected-IP>.nip.io` |
| `--ip` | `TUNNEL_PROXY_IP` | Tailscale, then unambiguous private LAN IPv4 |
| `--port` | `TUNNEL_PROXY_PORT` | `8000` |
| `--bind` | `TUNNEL_PROXY_BIND` | `0.0.0.0` |
| `--dns` | `TUNNEL_DNS` | `external`; `split` enables CoreDNS bootstrap |
| `--state-dir` | `TUNNEL_STATE_DIR` | Config directory; holds routes and mappings |
| `--worktrees` | `TUNNEL_WORKTREES` | `~/.worktrees`; where `tunnel new` puts worktrees |
| — | `TUNNEL_CONFIG_DIR` | `~/.config/tunnel` |

For example, `tunnel setup --bind 100.64.0.10` restricts new proxy listeners to that local interface. On macOS, ports a Compose preview publishes on all interfaces are rebound to `127.0.0.1` (the proxy still reaches them through `host.docker.internal`), and ports bound to a specific interface are left alone. On Linux, bridge containers can't reach the host's loopback, so app ports keep the Compose file's interfaces; restrict them with firewall rules. Some VM-backed runtimes can't bind host VPN interfaces; verify the runtime's behavior and use firewall controls where necessary.

Older installations used `~/.selfbench` for state. To retain those routes, configure the old domain/IP and `--state-dir ~/.selfbench`. Nothing is migrated or deleted automatically.

## Commands and Already-Running Servers

The proxy runs in Docker and reaches apps on the host through `host.docker.internal`. Docker Desktop and OrbStack on macOS forward that to the Mac's loopback, so an app bound to `127.0.0.1` works; OrbStack also reaches apps bound only to IPv6 `::1` (common for Node dev servers, whose `localhost` resolves to `::1` on macOS). Because the proxy reaches the host by port alone, tunnel refuses a command whose port another process also listens on, on another address. On Linux, a host app bound to `127.0.0.1` generally isn't reachable from bridge containers: bind a Docker-reachable interface and restrict access with firewall rules. Framework host allowlists must allow the printed hostname.

A command preview (`tunnel up -- COMMAND`) finds its port by asking every TCP port its process group listens on (per `lsof`), plus `PORT`, for an HTTP response, on the loopback address it listens on. Without `lsof`, only `PORT` or `--port` is checked. Commands run without coding-agent environment markers (`CLAUDECODE`, `AI_AGENT`, `CODEX_THREAD_ID`, `GEMINI_CLI` and similar), so tools don't detach into the background, out of reach of teardown. Its output goes to `<state-dir>/dev-proxy/logs/<name>.log`, which `tunnel logs` prints; teardown deletes it.

```sh
tunnel up --local --name my-app --port 5173 /path/to/worktree
```

routes a server something else started instead. The directory defaults to the current working directory and records source ownership, not a launch command. Without a Compose file, supplying `--port` alone also selects local mode. The server is never started, supervised, or stopped by tunnel; expiry or `down` removes only its route.

## Troubleshoot and Verify

```sh
tunnel ls
tunnel doctor
```

`ls` lists registrations, not guaranteed live apps. `doctor` checks Docker/Compose, proxy ownership, wildcard DNS, site targets, and HTTP responses. It exits nonzero on failures. HTTP 4xx is a failure; authenticated apps may need a manual check.

- **Port conflict / wrong proxy:** a compatible Caddy publishes the configured proxy port and mounts this installation's `dev-proxy/sites`. Ownership mismatches fail explicitly. Inspect containers instead of overwriting another proxy.
- **502:** confirm the app runs and Docker can reach its host port. For a command preview, `tunnel ls` shows `exited` when its process group is gone; `tunnel logs NAME` shows why.
- **DNS failure:** check IP, resolver policy, and split-DNS configuration. `curl --resolve <hostname>:<proxy-port>:<machine-IP> <full-URL>` diagnoses proxy routing, not normal DNS or remote reachability.
- **Another device can't open the link:** check routes, tailnet permissions, and firewall rules. Local HTTP success doesn't prove remote reachability.
- **OAuth:** configure the exact callback origin with your provider and follow its wildcard rules. Tunnel does not provision OAuth apps. Use `--url-env` with the variable your app actually consumes before starting it.
- **Multiple published ports:** without `--port` or `--target`, tunnel probes each published port with a GET (up to `--wait`, default 2 minutes) and routes the only one answering HTTP; select `--target <service>:<container-port>` to choose explicitly, or `--port` for a known host port. Without `--port`, tunnel writes a generated override under the state directory that republishes fixed host ports on ephemeral ones and removes fixed `container_name`s and non-external volume and network names, so previews of one project don't collide. `--port` keeps the Compose file's fixed host ports, which can conflict across previews.
- **Old image-built code:** use `--build`; registering a URL does not rebuild images. Repeating `up` for a command preview restarts the command.
- **Command never became ready:** `up` waits up to `--wait` (default 2m) for an HTTP answer and then stops the command and shows its last output. Raise `--wait` for slow first builds; pass `--port` if the app serves several HTTP ports.
- **Interrupted command / stale lock:** lifecycle changes are serialized. If a command is killed, a lock under the config directory can remain; tunnel reports its path and owner PID. A reused PID may make it look busy instead; scheduled cleanup logs skipped checks. Confirm no tunnel operation is still running before removing that exact lock directory. Then run `tunnel down <name>` to finish a recorded partial startup. Automatic expiry is blocked until the stale lock is cleared.
- **Cleanup diagnostics:** the macOS user job writes to `<state-dir>/cleanup.log`; its plist lives under `~/Library/LaunchAgents/dev.tunnel.cleanup.<state-hash>.plist`. It stays installed when no previews remain. A content-addressed copy of the cleanup runtime lives under `<state-dir>/runtime`, independent of the source checkout. To uninstall, identify the exact label in that plist, run `launchctl bootout gui/$(id -u)/<label>`, then remove that exact plist. Don't remove another state directory's job.
