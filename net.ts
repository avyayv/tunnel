import { createConnection, createServer } from "node:net";

// Ports on this machine that answer an HTTP request with anything at all, asked on 127.0.0.1
// unless a host is given. The proxy only speaks HTTP, so this decides which of an app's ports to
// route.
export async function answeringHTTP(targets: readonly (number | { port: number; host: string })[]): Promise<number[]> {
  const answers = async ({ port, host }: { port: number; host: string }) => {
    try {
      const response = await fetch(`http://${host}:${port}/`, { redirect: "manual", signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      return true;
    } catch { return false; }
  };
  const normalized = targets.map((target) => typeof target === "number" ? { port: target, host: "127.0.0.1" } : target);
  const results = await Promise.all(normalized.map(answers));
  return normalized.filter((_, i) => results[i]).map((target) => target.port);
}

// Whether anything accepts TCP connections on the port.
export function listening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("timeout", () => { socket.destroy(); done(false); });
    socket.once("error", () => done(false));
  });
}

// A port the OS considers free right now.
export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}
