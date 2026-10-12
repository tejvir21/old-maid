import type { OfflineGamePayload, StatsSummary, SyncItemResult } from "@old-maid/shared";
import type { Repo } from "../offline/db";

export class NetworkError extends Error {}
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

export interface ApiDeps {
  baseUrl: string;
  repo: Repo;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * True when a failure looks like the browser refusing the request rather than the network
 * being down. Brave Shields and common ad-blockers produce `ERR_BLOCKED_BY_CLIENT` /
 * `Failed to fetch` with no HTTP status at all; that is a *client-side block*, not a dead server.
 */
export function looksBlocked(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /blocked by client|ERR_BLOCKED_BY_CLIENT|blockedbyclient/i.test(msg);
}

interface AuthResponse { token: string; sessionId: string; user: { id: string; username: string; isGuest: boolean } }

/** Result of a connectivity probe. */
export interface ProbeOutcome { ok: boolean; blocked: boolean }

/**
 * Thin HTTP client. Identity is a guest account created on first need (online only) and re-established
 * from the stored session secret; offline play never calls this.
 */
export class ApiClient {
  private token: string | null = null;
  private authInflight: Promise<string> | null = null;

  constructor(private readonly d: ApiDeps) {}

  private get f(): typeof fetch {
    return this.d.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  private async raw<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.d.timeoutMs ?? 10_000);
    let res: Response;
    try {
      res = await this.f(`${this.d.baseUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ctl.signal,
      });
    } catch (e) {
      throw new NetworkError(e instanceof Error ? e.message : "network error");
    } finally {
      clearTimeout(t);
    }
    let json: unknown = null;
    try { json = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(err?.message ?? `HTTP ${res.status}`, res.status, err?.code);
    }
    return json as T;
  }

  async health(): Promise<boolean> {
    try {
      await this.raw<unknown>("GET", "/health");
      return true;
    } catch (e) {
      // A 503 "degraded" still means the server is reachable.
      return e instanceof ApiError;
    }
  }

  /**
   * Connectivity probe used by the NetworkMonitor.
   *
   * Tries several real endpoints in order instead of trusting `/health` alone:
   *   1. `/health`            – the cheapest liveness signal
   *   2. `/api/config`        – the endpoint the app genuinely needs
   *   3. `POST /api/auth/guest` – proves authenticated API traffic works end to end
   *
   * A 401/403/409/429 still proves the server is reachable. Only a total transport failure is
   * "not ok", and a browser block is reported separately so the UI can say so instead of
   * claiming the backend is down.
   */
  async probe(): Promise<ProbeOutcome> {
    let blocked = false;
    for (const attempt of [
      () => this.raw<unknown>("GET", "/health"),
      () => this.raw<unknown>("GET", "/api/config"),
      () => this.raw<unknown>("POST", "/api/auth/guest"),
    ]) {
      try {
        await attempt();
        return { ok: true, blocked: false };
      } catch (e) {
        if (e instanceof ApiError) {
          // The server answered. Any HTTP status (including 401/429) means it is reachable.
          return { ok: true, blocked: false };
        }
        if (looksBlocked(e)) blocked = true;
      }
    }
    return { ok: false, blocked };
  }

  /** Returns a valid access token, creating a guest account if this device has none yet. */
  async ensureToken(force = false): Promise<string> {
    if (this.token && !force) return this.token;
    if (this.authInflight) return this.authInflight;
    this.authInflight = (async () => {
      const profile = await this.d.repo.getProfile();
      let auth: AuthResponse | null = null;
      if (profile.auth?.sessionId) {
        try {
          auth = await this.raw<AuthResponse>("POST", "/api/auth/session", { sessionId: profile.auth.sessionId });
        } catch (e) {
          if (!(e instanceof ApiError) || (e.status !== 401 && e.status !== 400)) throw e;
        }
      }
      auth ??= await this.raw<AuthResponse>("POST", "/api/auth/guest");
      await this.d.repo.patchProfile({ auth: { userId: auth.user.id, sessionId: auth.sessionId } });
      this.token = auth.token;
      return auth.token;
    })().finally(() => { this.authInflight = null; });
    return this.authInflight;
  }

  /** Authenticated request; on 401 re-establishes the session once and retries. */
  async authed<T>(method: string, path: string, body?: unknown): Promise<T> {
    let token = await this.ensureToken();
    try {
      return await this.raw<T>(method, path, body, token);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        token = await this.ensureToken(true);
        return this.raw<T>(method, path, body, token);
      }
      throw e;
    }
  }

  async sync(items: { id: string; type: string; payload: unknown }[]): Promise<SyncItemResult[]> {
    const r = await this.authed<{ results: SyncItemResult[] }>("POST", "/api/sync", { items });
    return r.results;
  }
  async myStats(): Promise<{ stats: StatsSummary }> {
    return this.authed("GET", "/api/stats/me");
  }
  async config(): Promise<{ maintenance: { enabled: boolean; message: string }; features: Record<string, boolean>; game: { minPlayers: number; maxPlayers: number; allowAiFill: boolean } }> {
    return this.raw("GET", "/api/config");
  }
  currentToken(): string | null { return this.token; }
}

export type { OfflineGamePayload };
