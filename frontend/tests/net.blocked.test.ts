// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { NetworkMonitor, asProbeResult, type ProbeResult } from "../src/net/network";
import { ManualScheduler } from "./helpers";
import { ApiClient, looksBlocked, NetworkError } from "../src/sync/api";

const never = () => new Promise<never>(() => undefined);

function monitor(probe: () => Promise<ProbeResult | boolean>, sched = new ManualScheduler(), online = () => true) {
  return new NetworkMonitor({ isBrowserOnline: online, probe, scheduler: sched, failureThreshold: 2 });
}

describe("blocked requests are not treated as a dead server", () => {
  it("classifies ERR_BLOCKED_BY_CLIENT as blocked, not unreachable", async () => {
    expect(looksBlocked(new NetworkError("Failed to fetch: ERR_BLOCKED_BY_CLIENT"))).toBe(true);
    expect(looksBlocked(new Error("net::ERR_BLOCKED_BY_CLIENT"))).toBe(true);
    expect(looksBlocked(new TypeError("Failed to fetch"))).toBe(false);
    expect(looksBlocked(new NetworkError("connection refused"))).toBe(false);
  });

  it("reports the blocked state instead of SERVER UNREACHABLE", async () => {
    const m = monitor(async () => ({ ok: false, blocked: true }));
    expect(await m.check()).toBe("blocked");
    expect(m.snapshot.state).toBe("blocked");
  });

  it("a single failure never flips to unreachable (no permanent offline state)", async () => {
    let calls = 0;
    const m = monitor(async () => {
      calls++;
      return calls <= 1 ? { ok: false, blocked: true } : { ok: true };
    });
    expect(await m.check()).not.toBe("unreachable"); // first failure tolerated
    expect(await m.check()).toBe("online"); // recovers on the next probe
    expect(m.snapshot.failures).toBe(0);
  });

  it("only reports unreachable after the failure threshold", async () => {
    const m = monitor(async () => ({ ok: false, blocked: false }));
    expect(await m.check()).not.toBe("unreachable");
    expect(await m.check()).toBe("unreachable");
    expect(m.snapshot.failures).toBe(2);
  });

  it("stays offline while the browser itself is offline, regardless of probes", async () => {
    const m = monitor(async () => ({ ok: true }), new ManualScheduler(), () => false);
    expect(await m.check()).toBe("offline");
    expect(m.canUseNetwork).toBe(false);
  });
});

describe("bounded retries", () => {
  it("backs off exponentially and caps at five minutes", async () => {
    const sched = new ManualScheduler();
    const m = new NetworkMonitor({
      isBrowserOnline: () => true, probe: async () => ({ ok: false }), scheduler: sched,
      probeIntervalMs: 20_000, failureThreshold: 2,
    });
    const delays: number[] = [];
    m.start();                       // schedules the first probe immediately + a timer
    await m.check();                  // one failure
    for (let i = 0; i < 7; i++) {
      delays.push(sched.lastDelay);
      sched.advance(600_000);         // let the timer fire
      await Promise.resolve();
    }
    expect(delays[0]).toBe(20_000); // first retry still uses the base interval
    expect(Math.max(...delays)).toBeLessThanOrEqual(300_000); // capped
    expect(delays[delays.length - 1]).toBeGreaterThan(delays[0]!); // grows under sustained failure
    m.stop();
  });

  it("never stacks concurrent probes", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const m = monitor(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await Promise.resolve();
      inFlight--;
      return { ok: true };
    });
    await Promise.all([m.check(), m.check(), m.check()]);
    expect(maxConcurrent).toBeLessThanOrEqual(1);
  });

  it("a blocked server does not clear the stored session", async () => {
    // Regression: repeated probe failures must not reset auth or discard the session secret.
    const patch = vi.fn().mockResolvedValue(undefined);
    const repo = {
      getProfile: async () => ({ key: "me", localPlayerId: "p", displayName: "P", avatar: "a1", updatedAt: 0,
        auth: { userId: "u", sessionId: "keep-me" } }),
      patchProfile: patch,
      queueCounts: async () => ({ pending: 0, syncing: 0, failed: 0, synced: 0 }),
      resetStuckSyncing: async () => 0, pruneSynced: async () => undefined,
    } as never;
    const api = new ApiClient({ baseUrl: "https://x.test", repo, fetchImpl: (() => Promise.reject(new NetworkError("ERR_BLOCKED_BY_CLIENT"))) as never });
    const out = await api.probe();
    expect(out).toEqual({ ok: false, blocked: true });
    expect(patch).not.toHaveBeenCalled(); // the stored session survives a block
  });
});

describe("layered probe", () => {
  it("falls back to /api/config when /health is blocked", async () => {
    const seen: string[] = [];
    const api = new ApiClient({
      baseUrl: "https://x.test",
      repo: {} as never,
      fetchImpl: (async (u: string) => {
        seen.push(u);
        if (u.endsWith("/health")) throw new NetworkError("ERR_BLOCKED_BY_CLIENT");
        return { ok: true, status: 200, json: async () => ({ success: true }), text: async () => "" } as unknown as Response;
      }) as never,
    });
    const out = await api.probe();
    expect(out.ok).toBe(true);
    expect(seen[0]).toContain("/health");
    expect(seen[1]).toContain("/api/config");
  });

  it("treats ANY http status as reachable (401/429 still prove a live server)", async () => {
    const api = new ApiClient({
      baseUrl: "https://x.test", repo: {} as never,
      fetchImpl: (async () => ({ ok: false, status: 429, json: async () => ({ error: { code: "RATE_LIMITED" } }), text: async () => "{}" }) as unknown as Response) as never,
    });
    expect(await api.probe()).toEqual({ ok: true, blocked: false });
  });

  it("falls back to guest auth when health and config both fail", async () => {
    const seen: string[] = [];
    const api = new ApiClient({
      baseUrl: "https://x.test", repo: {} as never,
      fetchImpl: (async (u: string, init?: RequestInit) => {
        seen.push(`${init?.method ?? "GET"} ${new URL(u).pathname}`);
        if (u.endsWith("/api/auth/guest")) {
          return { ok: true, status: 201, json: async () => ({ token: "t", sessionId: "s", user: { id: "u" } }), text: async () => "" } as unknown as Response;
        }
        throw new NetworkError("Failed to fetch");
      }) as never,
    });
    expect((await api.probe()).ok).toBe(true);
    expect(seen).toContain("POST /api/auth/guest");
  });

  it("reports blocked only when every endpoint was refused client-side", async () => {
    const api = new ApiClient({
      baseUrl: "https://x.test", repo: {} as never,
      fetchImpl: (() => Promise.reject(new NetworkError("ERR_BLOCKED_BY_CLIENT"))) as never,
    });
    expect(await api.probe()).toEqual({ ok: false, blocked: true });
  });

  it("never bypasses Shields: it only reports and stops", async () => {
    let calls = 0;
    const api = new ApiClient({
      baseUrl: "https://x.test", repo: {} as never,
      fetchImpl: (() => { calls++; return Promise.reject(new NetworkError("ERR_BLOCKED_BY_CLIENT")); }) as never,
    });
    await api.probe();
    // Exactly the three documented endpoints - no hidden proxying, no retries in one probe.
    expect(calls).toBe(3);
  });
});

describe("asProbeResult", () => {
  it("normalises the legacy boolean form", () => {
    expect(asProbeResult(true)).toEqual({ ok: true });
    expect(asProbeResult(false)).toEqual({ ok: false });
    expect(asProbeResult({ ok: true, blocked: false })).toEqual({ ok: true, blocked: false });
  });

  it("is backward compatible with a simple boolean probe", async () => {
    const m = monitor(async () => true);
    expect(await m.check()).toBe("online");
    expect(m.snapshot.state).toBe("online");
  });

  it("a probe that never settles does not wedge the monitor", async () => {
    const m = monitor(never as never);
    void m.check();
    expect(m.snapshot.state).toBe("online"); // in-flight probe is ignored, not a failure
  });
});