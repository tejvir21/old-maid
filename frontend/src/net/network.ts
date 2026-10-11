import type { Scheduler } from "./scheduler";

export type NetState = "online" | "offline" | "unreachable";

export interface NetSnapshot {
  state: NetState;
  /** True while something (e.g. an offline game) has asked the app to make no network requests. */
  suspended: boolean;
}

export interface NetworkDeps {
  isBrowserOnline: () => boolean;
  /** Resolves true when our own backend answers /health. */
  probe: () => Promise<boolean>;
  scheduler: Scheduler;
  /** Subscribes to browser online/offline events; returns an unsubscribe fn. */
  listen?: (onUp: () => void, onDown: () => void) => () => void;
  probeIntervalMs?: number;
}

/**
 * Tracks connectivity and owns the "no network during an offline game" gate.
 * While suspended it makes NO requests of any kind (passive browser events only).
 */
export class NetworkMonitor {
  private browserOnline: boolean;
  private reachable: boolean | null = null;
  /** Last time we positively confirmed the backend; used to detect real reconnects. */
  private connected = false;
  private suspensions = new Set<string>();
  private subs = new Set<(s: NetSnapshot) => void>();
  private reconnectCbs = new Set<() => void>();
  private timer: unknown = null;
  private unlisten: (() => void) | null = null;
  private running = false;

  constructor(private readonly d: NetworkDeps) {
    this.browserOnline = d.isBrowserOnline();
  }

  get snapshot(): NetSnapshot {
    const state: NetState = !this.browserOnline ? "offline" : this.reachable === false ? "unreachable" : "online";
    return { state, suspended: this.suspensions.size > 0 };
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
    let ok = false;
    try { ok = await this.d.probe(); } catch { ok = false; }
    this.reachable = ok;
    const justReconnected = ok && !this.connected;
    this.connected = ok;
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
      this.timer = this.d.scheduler.setTimeout(() => {
        void this.check().finally(() => this.running && loop());
      }, this.d.probeIntervalMs ?? 20_000);
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
