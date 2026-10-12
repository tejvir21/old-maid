# Old Maid

A multiplayer Old Maid card game — playable **fully offline** against AI, **online** with friends, and
manageable through a production-quality **admin panel**.

> **The rule:** the player holding the Joker when the last pair disappears **wins**. Everyone else
> loses. This is never reversed anywhere in the codebase.

---

## 1. Architecture

```
┌──────────────────────────────── shared/ ────────────────────────────────┐
│  pure rules, zero I/O:  53-card deck · pairing · turn order · AI       │
│  invariants · Zod schemas · RBAC matrix                               │
└───────────┬──────────────────────────────────────────┬─────────────────┘
            │ compiled to ESM                         │ (same package)
┌───────────▼──────────────────────┐   ┌───────────────▼──────────────────┐
│ backend/  (server-authoritative) │   │ frontend/  (React PWA)           │
│                                   │   │                                   │
│ GameSession ─ authoritative state │   │ OfflineSession ── IndexedDB ─┐    │
│      ↓                            │   │   (client-authoritative,     │    │
│ RoomManager ─ lobby, turns,       │   │    NO network during play)  │    │
│   timers, reconnect, host         │   │            ↓                 │    │
│      ↓                            │   │      SyncEngine (queue,      │    │
│ SocketRegistry ─ transport        │   │      backoff, idempotent)    │    │
│      ↓                            │   │            ↓                 │    │
│ Express ─ auth · sync · admin     │   │   POST /api/sync             │    │
│      ↓                            │   └──────────────────────────────┼────┘
│ MongoDB Atlas / in-memory         │                                  │
└───────────────────────────────────┘                                  │
                                                       POST /api/admin ─┘
                                                       (AdminProvider,
                                                        AdminGate, 12 routes)
```

**Two independent authorities.** Online play is decided by `GameSession` on the server — the client
sends requests and renders what it is told. Offline play is decided locally and syncs its result
upwards as *unverified*. The two are never merged.

---

## 2. Prerequisites

- **Node.js 20 or newer** (developed on v24)
- **npm 10+** (the repo uses npm workspaces)
- **MongoDB** — optional locally (an in-memory store is used), **required in production**

---

## 3. Repository structure

```
shared/          rules, deck, engine, AI, zod schemas, RBAC contracts — no I/O
  src/           deck.ts rules.ts engine.ts ai.ts rng.ts types.ts protocol.ts settings.ts admin.ts
  tests/         engine.test.ts  admin.test.ts  termination.test.ts
backend/         authoritative game server
  src/auth/      authService.ts (players) · adminAuth.ts (admins) · tokens.ts
  src/game/      GameSession.ts        — authoritative state for one match
  src/rooms/     roomManager.ts        — lobby, turns, timers, reconnect, admin hooks
  src/socket/    registry.ts socket.ts — transport
  src/routes/    auth.ts sync.ts admin.ts adminAuth.ts middleware.ts
  src/store/     types.ts memory.ts mongo.ts
  src/config/    env.ts                — zod-validated environment
  src/scripts/   createAdmin.ts        — secure first-SUPER_ADMIN bootstrap
  tests/         rooms sockets http store.contract admin.security drawSlots privacy.slots
frontend/        React + TypeScript PWA
  src/admin/     AdminProvider AdminLayout adminApi pages/ (12 admin routes)
  src/game/      offlineGame.ts offlineSession.ts tableVm.ts
  src/offline/   db.ts types.ts        — IndexedDB
  src/sync/      api.ts syncEngine.ts
  src/socket/    onlineClient.ts
  scripts/       verify-pwa.mjs        — build-output gate
  tests/         offline online sync scenario ui.* admin.ui net.blocked
docs/            PHASE_AUDIT.md ADMIN_SECURITY.md TEST_REPORT.md DEPLOYMENT.md
```

---

## 4. Getting started

```bash
npm install
npm run build:shared          # shared must be compiled before backend/frontend typecheck
```

Copy the environment templates:

```bash
cp backend/.env.example  backend/.env
cp frontend/.env.example frontend/.env
```

### Run the game

```bash
npm run dev:backend           # terminal 1 → http://localhost:10000
npm run dev:frontend          # terminal 2 → http://localhost:5173
```

The Vite dev server proxies `/api`, `/health` and `/socket.io` to the backend, so leave
`VITE_API_URL` / `VITE_SOCKET_URL` empty locally.

### Run the tests

```bash
npm test                      # builds shared + backend, then ALL suites (304 tests)
npm run test -w @old-maid/shared
npm run test -w backend
npm run test -w frontend
npm run typecheck             # backend + frontend
npm run build                 # all three, incl. the PWA verification gate
```

To include the 10 MongoDB contract tests, point at a **disposable** database:

```bash
MONGODB_TEST_URI=mongodb://127.0.0.1:27017/oldmaid_test npm run test -w backend
```

---

## 5. Screens

`/` menu · `/rules` · `/offline` setup · `/offline/play` table · `/online` menu ·
`/online/room` lobby & table · `/stats` · `/settings` · connection & sync status in the status bar.

## 6. Offline mode

- Installs as a PWA; the whole shell (HTML, JS, CSS, fonts, icons) is precached — 24 files, ~840 KiB.
- `/api`, `/socket.io` and `/health` are **denylisted** from the navigation fallback and there is
  **no runtime caching**, so private game data is never served from a cache.
- During an offline game the app *suspends* the network monitor and closes its sockets. No probes,
  no sync, no auth calls — enforced by tests that trap `fetch` and count requests at a proxy sitting
  in front of the real backend.
- Saving a finished game is a **single IndexedDB transaction**: record + events + statistics +
  achievements + sync-queue item + active-game removal.
- An unfinished offline game survives closing the browser.

## 7. Online rooms

Create or join with a 5-character room code, 2–7 players, optional AI fill. The server is
authoritative: `RoomManager.buildView()` is the only place client-visible state is produced, and it
contains your own hand plus public counts — never another hand, and never the Joker's position.

If the **current** player disconnects, the game **pauses** and resumes on reconnect; a disconnected
player is never silently auto-played. A connected player who idles past the timeout gets a
server-chosen random valid draw, recorded as `TIMEOUT_AUTO_DRAW`.

## 8. Offline synchronisation

`SyncEngine` uploads a persistent IndexedDB queue with exponential backoff and jitter. The server is
idempotent per `(user, localGameId)`, and its per-item verdict is applied exactly: `synced` /
`duplicate` / `stale` → done, `rejected` → failed and **never retried**, network error → retried.
Browser-supplied totals are never trusted; the server validates plausibility and computes its own
**offline** counters, which stay separate from verified online statistics.

---

## 9. Admin panel

Twelve routes, all backed by real APIs and persistent data:

`/admin/login` · `/admin` · `/admin/users` · `/admin/rooms` · `/admin/games` · `/admin/reports` ·
`/admin/statistics` · `/admin/settings` · `/admin/database` · `/admin/audit-logs` · `/admin/admins` ·
`/admin/system-health`

### Roles and permissions

| Permission | SUPER_ADMIN | ADMIN | MODERATOR | SUPPORT |
|---|:--:|:--:|:--:|:--:|
| `USERS_READ` / `USERS_WRITE` / `USERS_BAN` | ✅ | ✅ | read, ban | read |
| `ROOMS_READ` / `ROOMS_WRITE` | ✅ | ✅ | read | read |
| `GAMES_READ` / `GAMES_MANAGE` | ✅ | ✅ | read | read |
| `GAME_DEBUG_READ` / `GAME_DEBUG_WRITE` | ✅ | ❌ | ❌ | ❌ |
| `SETTINGS_READ` / `SETTINGS_WRITE` | ✅ | ✅ | ❌ | ❌ |
| `DATABASE_READ` / `DATABASE_WRITE` | ✅ | ❌ | ❌ | ❌ |
| `REPORTS_READ` / `REPORTS_MANAGE` | ✅ | ✅ | ✅ | read |
| `AUDIT_READ` | ✅ | ✅ | ✅ | ❌ |
| `ADMINS_READ` / `ADMINS_WRITE` | ✅ | read | ❌ | ❌ |

Authorization always checks a **granular permission**, never a role name, so an individual admin can
be narrowed without code changes. Frontend route guards are UX only — every privileged API is
independently authorized on the server.

Full detail, including the escalation guards: **[docs/ADMIN_SECURITY.md](docs/ADMIN_SECURITY.md)**.

### Creating the first SUPER_ADMIN

There are **no default credentials** in this repository. Use the bootstrap command (password comes
from the environment, never from the command line):

```bash
export MONGODB_URI="mongodb+srv://…/oldmaid"
export ADMIN_BOOTSTRAP_PASSWORD='<≥12 chars, upper + lower + digit>'
npm run create-admin -w backend -- --email you@example.com --username root --role SUPER_ADMIN
unset ADMIN_BOOTSTRAP_PASSWORD
```

The script refuses to run once any admin exists. Afterwards, create further admins from
**Admins → New admin** so every change is audit-logged with a reason.

---

## 10. Deployment

Frontend → **Vercel** (static). Backend → **Render / Railway** (persistent Node). Database →
**MongoDB Atlas**.

> The backend **must** be a long-lived Node process. A Vercel serverless function cannot hold
> WebSocket connections, so `VITE_SOCKET_URL` must never point at one.

Full instructions, environment variables, health checks and the pre-launch checklist:
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

---

## 11. Security considerations

- **Online play is server-authoritative.** A client cannot dictate its hand, another hand, the
  Joker's location, the current turn or the winner. Unsupported state-setting socket events are
  ignored, and a test asserts that no client ever receives a byte of another player's hand.
- **Admin access is a separate identity boundary** — separate store, separate sessions, separate
  token format, separate login throttle. A player token is never accepted as an admin token.
- **Hidden state stays hidden.** Hands and the Joker's location require SUPER_ADMIN *and* generate
  an audit entry on every read.
- **Passwords** use bcrypt (cost 12 for admins). **Sessions** store only a SHA-256 hash; admin
  sessions last 8 h and are revoked on suspension or password change. **Optional TOTP 2FA** is
  supported. Repeated admin login failures are rate limited per IP.
- **The database console is a controlled interface**, not a DB client: allow-listed collections,
  allow-listed editable fields, no MongoDB operators, no arbitrary queries, soft delete by default,
  permanent delete SUPER_ADMIN-only and refused for audit logs and settings.
- **Every privileged modification is audited** with actor, target, before/after and a mandatory
  reason. Audit payloads are redacted so credentials can never be captured.
- **Admins never fabricate a winner.** An administratively ended match is recorded as `abandoned`
  with the admin id and reason — a distinct outcome from a naturally completed game.

---

## 12. Verification status

223 automated tests pass (47 shared · 104 backend · 72 frontend); 10 MongoDB tests are **skipped**
because no database was reachable, not passed. The PWA build-output gate passes.

**Not verified here** — do before release:

- MongoDB contract tests against a real Atlas test database
- Service-worker install and "launch with no network" in a real browser (only the build output is checked)
- Visual layout, touch behaviour and audio on real devices
- Deployment to Vercel/Render/Atlas
- **Live state is in-memory** — a backend restart ends active matches; a Redis-backed
  `ActiveStateStore` is not implemented

Full numbers and limitations: **[docs/TEST_REPORT.md](docs/TEST_REPORT.md)**.

---

## 13. Documentation

| Document | Contents |
|---|---|
| [docs/PHASE_AUDIT.md](docs/PHASE_AUDIT.md) | What was inspected, what was found, what was fixed, what is still unverified |
| [docs/ADMIN_SECURITY.md](docs/ADMIN_SECURITY.md) | Trust model, sessions, RBAC matrix, escalation guards, database-console rules, audit log |
| [docs/TEST_REPORT.md](docs/TEST_REPORT.md) | Actual test counts per suite, build results, and what was not run |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Topology, env vars, CORS, bootstrap, Render/Railway/Vercel, production gates |