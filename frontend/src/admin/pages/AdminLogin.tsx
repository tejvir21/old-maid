import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAdminApi } from "../context";

export function AdminLogin() {
  const api = useAdminApi();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.login(email, password, totp || undefined);
      nav("/admin", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="room flex min-h-full items-center justify-center px-4">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-sm border border-bone/20 p-6">
        <p className="text-xs uppercase tracking-[0.3em] text-dim">Old Maid</p>
        <h1 className="title-display mb-6 text-2xl">Admin sign in</h1>

        {error && <p className="mb-4 border border-blood/50 px-3 py-2 text-sm text-blood">{error}</p>}

        <label className="mb-3 block text-xs uppercase tracking-[0.15em] text-dim">
          Email
          <input type="email" autoComplete="username" required value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full border border-bone/25 bg-transparent p-2 text-sm normal-case tracking-normal text-bone" />
        </label>
        <label className="mb-3 block text-xs uppercase tracking-[0.15em] text-dim">
          Password
          <input type="password" autoComplete="current-password" required value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full border border-bone/25 bg-transparent p-2 text-sm normal-case tracking-normal text-bone" />
        </label>
        <label className="mb-4 block text-xs uppercase tracking-[0.15em] text-dim">
          Authenticator code (if enabled)
          <input type="text" inputMode="numeric" autoComplete="one-time-code" value={totp}
            onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="mt-1 w-full border border-bone/25 bg-transparent p-2 text-sm normal-case tracking-normal text-bone" />
        </label>

        <button type="submit" disabled={busy}
          className="min-h-[48px] w-full border border-ember bg-blood/40 text-sm uppercase tracking-[0.2em] disabled:opacity-50">
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="mt-4 text-xs text-dim">
          Sessions expire after 8 hours and are revoked immediately on suspension. Repeated failures are rate limited.
        </p>
      </form>
    </div>
  );
}