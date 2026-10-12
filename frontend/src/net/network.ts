import type { Scheduler } from "./scheduler";

export type NetState = "online" | "offline" | "unreachable" | "blocked";

/**
 * Result of one connectivity probe.
 *
 * `blocked` means the browser (Brave Shields, an extension, a filter list) refused the request
 * before it left the machine. The server may be perfectly healthy, so this must never be
 * treated as proof that the backend is offline.
 */
export interface ProbeResult {
  ok: boolean;
  blocked?: boolean;
}

export interface NetSnapshot {
  state: NetState;
  /** True while something (e.g. an offline game) has asked the app to make no network requests. */
  suspended: boolean;
  /** Consecutive failed probes; drives the bounded backoff. */
  failures: number;
  /** When the last successful probe completed (0 = never). */
  lastOkAt: number;
}

export interface NetworkDeps {
  isBrowserOnline: () => boolean;
  /**
   * Resolves true when our own backend answers.
   *
   * Probes several endpoints in order rather than trusting `/health` alone: Brave Shields and
   * some extensions block individual paths, and a blocked health check must not be mistaken for
   * a dead server while the real API is reachable.
   */
  probe: () => Promise<ProbeResult | boolean>;
  scheduler: Scheduler;
  /** Subscribes to browser online/offline events; returns an unsubscribe fn. */
  listen?: (onUp: () => void, onDown: () => void) => () => void;
  probeIntervalMs?: number;
  /** Consecutive failures tolerated before reporting `unreachable`. */
  failureThreshold?: number;
}

export const asProbeResult = (v: ProbeResult | boolean): ProbeResult => (typeof v === "boolean" ? { ok: v } : v);

/**
 * Tracks connectivity and owns the "no network during an offline game" gate.
 * While suspended it makes NO requests of any kind (passive browser events only).
 */
export class NetworkMonitor {
  private browserOnline: boolean;
  private reachable: boolean | null = null;
  /** Last time we positively confirmed the backend; used to detect real reconnects. */
  private connected = false;
  /** Consecutive probe failures. A single failure never flips us to `unreachable`. */
  private failures = 0;
  /** True when the last failure looked like a browser block rather than a dead server. */
  private blocked = false;
  private lastOkAt = 0;
  private suspensions = new Set<string>();
  private subs = new Set<(s: NetSnapshot) => void>();
  private reconnectCbs = new Set<() => void>();
  private timer: unknown = null;
  private unlisten: (() => void) | null = null;
  private running = false;
  private inFlight = false;

  constructor(private readonly d: NetworkDeps) {
    this.browserOnline = d.isBrowserOnline();
  }

  private get threshold(): number {
    return this.d.failureThreshold ?? 2;
  }

  get snapshot(): NetSnapshot {
    // Optimistic by design: we report a problem only after the failure threshold is met, so a
    // single hiccup (or one blocked request) can never strand the app in a permanent offline state.
    const state: NetState = !this.browserOnline
      ? "offline"
      : this.connected
        ? "online"
        : this.blocked
          ? "blocked"
          : this.failures >= this.threshold
            ? "unreachable"
            : "online";
    return { state, suspended: this.suspensions.size > 0, failures: this.failures, lastOkAt: this.lastOkAt };
  }
  /** Whether the app may make a network request right now. */
  get canUseNetwork(): boolean {
    return this.browserOnline && this.suspensions.size === 0;
  }

  subscribe(fn: (s: NetSnapshot) => void): () => void {
    this.subs.add(fn);
    fn(this.snapshot);
    return () => void this.subs.delete(fn);
  }
  /** Called when we regain connectivity (and are not suspended). */
  onReconnect(fn: () => void): () => void {
    this.reconnectCbs.add(fn);
    return () => void this.reconnectCbs.delete(fn);
  }

  private publish(): void {
    const s = this.snapshot;
    for (const f of this.subs) f(s);
  }

  suspend(reason: string): void {
    this.suspensions.add(reason);
    this.publish();
  }
  resume(reason: string): void {
    if (!this.suspensions.delete(reason)) return;
    this.publish();
    if (this.canUseNetwork) void this.check();
  }

  /** Probe our own backend (skipped while offline/suspended). */
  async check(): Promise<NetState> {
    if (!this.canUseNetwork) return this.snapshot.state;
    // Never stack probes: a slow/blocked request must not queue up behind itself.
    if (this.inFlight) return this.snapshot.state;
    this.inFlight = true;
    let res: ProbeResult = { ok: false };
    try { res = asProbeResult(await this.d.probe()); } catch { res = { ok: false }; } finally { this.inFlight = false; }

    this.blocked = res.ok ? false : Boolean(res.blocked);
    if (res.ok) {
      this.failures = 0;
      this.reachable = true;
      this.lastOkAt = Date.now();
    } else {
      this.failures += 1;
      this.reachable = false;
    }
    const justReconnected = res.ok && !this.connected;
    this.connected = res.ok;
    this.publish();
    if (justReconnected) this.fireReconnect();
    return this.snapshot.state;
  }

  private fireReconnect(): void {
    for (const f of this.reconnectCbs) f();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unlisten = this.d.listen?.(
      () => {
        this.browserOnline = true;
        this.publish();
        if (this.canUseNetwork) void this.check();
      },
      () => {
        this.browserOnline = false;
        this.connected = false;
        this.publish();
      },
    ) ?? null;
    const loop = () => {
      // Bounded exponential backoff so a blocked/unreachable backend cannot be hammered:
      // 20s, 40s, 80s … capped at 5 minutes. Resets on the next success.
      const base = this.d.probeIntervalMs ?? 20_000;
      const backoff = Math.min(base * 2 ** Math.min(this.failures, 5), 300_000);
      this.timer = this.d.scheduler.setTimeout(() => {
        void this.check().finally(() => this.running && loop());
      }, this.failures === 0 ? base : backoff);
    };
    loop();
    void this.check();
  }

  stop(): void {
    this.running = false;
    if (this.timer) this.d.scheduler.clearTimeout(this.timer);
    this.timer = null;
    this.unlisten?.();
    this.unlisten = null;
  }
}
