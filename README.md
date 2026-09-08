# tunnel

Put any docker compose stack on this machine behind its own subdomain, and shut it down the
moment you are done.

```bash
cd ~/any/project          # anything with a compose.yaml / docker-compose.yml
tunnel up                 # -> http://<random>.<domain>  (auto-detects the published port)
tunnel up --build         # rebuild images first
tunnel up --name foo      # pick the subdomain yourself
tunnel ls                 # everything currently running behind the door
tunnel down               # in the same directory: kills the stack and its subdomain, instantly
tunnel down foo           # ...or by name, from anywhere
tunnel <compose args>     # anything else passes through: logs -f, ps, exec ...
```

Every stack is isolated: its own compose project, its own loopback port, its own subdomain.

## How it works

One shared door per machine, started automatically by `tunnel up`:

- **CoreDNS** answers every name under the domain with the machine's address. Point your
  devices' split DNS for the domain at the machine (e.g. a Tailscale admin console restricted
  nameserver) — nothing is published to public DNS, so nothing is reachable off the tailnet.
- **Caddy** (port 80, or `SELFBENCH_DEV_PROXY_PORT`) reads the request's `Host` header and
  proxies to the stack's port on loopback. One tiny site file per stack under
  `~/.selfbench/dev-proxy/sites`, written by `up`, deleted by `down`.

Configuration through the environment (all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `SELFBENCH_DEV_DOMAIN` | `stack.avyayv.com` | The subdomain wildcards live under. Use a dedicated subdomain so real records of the parent domain are never shadowed. |
| `SELFBENCH_DEV_PROXY_IP` | `tailscale ip -4` | The address DNS hands out; the machine's address on the network your browser uses. |
| `SELFBENCH_DEV_PROXY_PORT` | `8000` | Host port for Caddy (80 is often reserved, e.g. by OrbStack). |
| `SELFBENCH_CONFIG_DIR` | `~/.selfbench` | Where site files and mappings live. |

## GitHub sign-in (optional)

GitHub matches OAuth redirect hosts and ports exactly (except loopback), so one OAuth app per
port normally means re-editing the app for every worktree. Because every tunnel URL is a
subdomain of the same domain on the same port, one wildcard-enabled callback covers them all:

```
http://<domain>[:<port>]/auth/github/callback
```

Enable wildcard matching on that callback URL in the OAuth app's settings.
