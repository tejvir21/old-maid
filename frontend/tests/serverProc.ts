import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttp, request as httpRequest, type Server } from "node:http";
import { createServer as createNet } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_ENTRY = resolve(here, "../../backend/dist/server.js");

export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createNet();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
}

export interface RunningServer { url: string; port: number; proc: ChildProcess; stop(): Promise<void> }

/** Boots the REAL compiled backend (in-memory store) as a child process. */
export async function startBackend(env: Record<string, string> = {}): Promise<RunningServer> {
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(port), NODE_ENV: "development", LOG_LEVEL: "silent", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  proc.stderr?.on("data", (d) => (stderr += String(d)));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (proc.exitCode !== null) throw new Error(`backend exited: ${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
    if (i === 99) throw new Error("backend did not start: " + stderr);
  }
  return {
    url, port, proc,
    stop: () => new Promise<void>((res) => { proc.once("exit", () => res()); proc.kill("SIGTERM"); setTimeout(() => proc.kill("SIGKILL"), 3000).unref(); }),
  };
}

export interface Proxy { url: string; setDown(down: boolean): void; hits: number; close(): Promise<void> }

/** A pass-through proxy that can be switched off to simulate losing the connection. */
export async function startProxy(targetPort: number): Promise<Proxy> {
  let down = false;
  const state = { hits: 0 };
  const server: Server = createHttp((req, res) => {
    state.hits++;
    if (down) { req.socket.destroy(); return; }
    const up = httpRequest({ host: "127.0.0.1", port: targetPort, path: req.url, method: req.method, headers: req.headers }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    up.on("error", () => { res.statusCode = 502; res.end(); });
    req.pipe(up);
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${port}`,
    setDown: (d) => { down = d; },
    get hits() { return state.hits; },
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
