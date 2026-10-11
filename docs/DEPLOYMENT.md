# Deployment — Old Maid

## 1. Target topology

```
                 Vercel (frontend)                 Render / Railway (backend)
                 static PWA bundle                 single long-lived Node process
                 ─────────────────                 ─────────────────────────────────
   browser ───▶  index.html + assets       ───▶    Express  :10000  (HTTP API)
                 service worker (precache)  ───▶    Socket.IO (WebSocket + polling)
                                                        │
                                                        ▼
                                                 MongoDB Atlas
                                      users, admins, sessions, rooms, games,
                                      gamePlayers, gameEvents, chatMessages,
                                      syncRecords, settings, reports, auditLogs
```

### The one hard rule

**The Socket.IO backend must be a persistent Node process.** A standard Vercel serverless function
cannot hold WebSocket connections: the instance is frozen between invocations and torn down after
each response. Deploy `frontend/` to Vercel as a **static build** and `backend/` to Render or
Railway as a **long-running Node service**. Never point `VITE_SOCKET_URL` at a Vercel function.

---

## 2. Build and start commands

| Component | Install | Build | Start | Health check |
|---|---|---|---|---|
| `frontend/` (Vercel) | `npm install` | `npm run build -w frontend` | static output in `frontend/dist` | — |
| `backend/` (Render/Railway) | `npm install` | `npm run build -w backend` | `npm start -w backend` | `GET /health` |

These run from the **repository root** (npm workspaces). The backend must also build `shared` first;
`npm run build` does all three in order, or use `npm run build:shared && npm run build -w backend`.

`npm run build -w frontend` runs `tsc --noEmit && vite build && node scripts/verify-pwa.mjs` — the
PWA gate is part of the build and fails it if the offline shell is incomplete.

---

## 3. Environment variables

Full annotated template: `backend/.env.example` and `frontend/.env.example`.

### Backend (secret)

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | – | `production` in production |
| `PORT` | – | default `10000` |
| `CLIENT_URL` | **prod** | your Vercel URL, e.g. `https://old-maid.vercel.app` |
| `ALLOWED_ORIGINS` | – | extra comma-separated origins; `*` is rejected |
| `MONGODB_URI` | **prod** | MongoDB Atlas connection string |
| `JWT_ACCESS_SECRET` | **prod** | ≥ 32 chars |
| `JWT_REFRESH_SECRET` | – | defaults to the access secret |
| `LOG_LEVEL` | – | `info` default |
| `ADMIN_BOOTSTRAP_PASSWORD` | bootstrap only | first admin's password; unset after use |

`loadEnv()` (`backend/src/config/env.ts`) validates all of this at start-up and refuses to boot with
an incomplete production configuration.

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Frontend (public)

| Variable | Notes |
|---|---|
| `VITE_API_URL` | `https://<your-backend>` |
| `VITE_SOCKET_URL` | `https://<your-backend>` (same host) |

These are **baked into the public bundle**. Never put an admin token, database URL or any other
secret here.

---

## 4. CORS

The backend allow-lists browser origins. Add every origin that will serve the frontend:

```
CLIENT_URL=https://old-maid.vercel.app
ALLOWED_ORIGINS=https://old-maid-staging.vercel.app
```

A request with an unlisted `Origin` is refused at the CORS layer. Requests with **no** `Origin`
(health checks, `curl`) are allowed, because they are not browsers and cannot be the target of a
cross-site attack.

If you later add a preview-deployment domain, allow-list it explicitly. `*` is explicitly
forbidden and will fail start-up validation.

---

## 5. Creating the first SUPER_ADMIN (secure bootstrap)

**There are no default administrator credentials anywhere in this repository.**

The bootstrap script refuses to run once any admin account exists, reads the password from the
environment (never from a command-line argument, which would leak into shell history and the process
list), and enforces the stronger admin password policy.

```bash
# 1. Point at your production database
export MONGODB_URI="mongodb+srv://…/oldmaid"

# 2. Choose the password in a secret manager (>= 12 chars, upper + lower + digit)
export ADMIN_BOOTSTRAP_PASSWORD='<generate a strong one>'

# 3. Create the account
npm run create-admin -w backend -- --email you@example.com --username root --role SUPER_ADMIN

# 4. Remove it from your shell / CI environment immediately
unset ADMIN_BOOTSTRAP_PASSWORD
```

The script prints the new admin's id and id/role. Afterwards, create every further admin from the
admin panel (**Admins → New admin**) so the action is audit-logged with a reason.

Never use `--role SUPER_ADMIN` for a day-to-day account. Create a scoped `ADMIN` instead.

---

## 6. MongoDB Atlas

1. Create a free/shared cluster.
2. **Database Access** → add a user with *Read and write to any database* (or scope it to your DB).
3. **Network Access** → allow your Render/Railway egress IPs (or `0.0.0.0/0` for a start-up-only
   deployment — prefer a restricted list).
4. Copy the connection string into `MONGODB_URI`. Indexes are created automatically by Mongoose on
   first connect.

Collections created on first boot: `users`, `sessions`, `bans`, `rooms`, `games`, `gamePlayers`,
`gameEvents`, `chatMessages`, `syncRecords`, `offlineGames`, `statistics`, `settings`, `admins`,
`adminSessions`, `auditLogs`, `reports`.

### Running the skipped MongoDB tests

```bash
MONGODB_TEST_URI="mongodb+srv://…/oldmaid_test" npm run test -w backend
```

Use a **disposable** database — the contract tests write and delete data.

---

## 7. Render

`render.yaml` is not required; configure in the dashboard:

| Setting | Value |
|---|---|
| Root directory | repository root |
| Build command | `npm ci && npm run build:shared && npm run build -w backend` |
| Start command | `npm start -w backend` |
| Health check path | `/health` |
| Instance type | must support **WebSockets** (Starter or above; free instances idle-time out) |

Set the environment variables from §3 in the dashboard's *Environment* tab.

## 8. Railway

| Setting | Value |
|---|---|
| Build | `npm ci && npm run build:shared && npm run build -w backend` |
| Start | `npm start -w backend` |
| Healthcheck | `/health` |

Railway provides a single public hostname for HTTP and WebSocket — use it for both `VITE_API_URL`
and `VITE_SOCKET_URL`.

## 9. Vercel

| Setting | Value |
|---|---|
| Root directory | `frontend` |
| Framework preset | Vite |
| Build command | `npm run build` |
| Output directory | `dist` |

Because `frontend` is a workspace member, install from the **repository root** (`cd ..` → set the
root directory accordingly, or let Vercel use the repo root with the `frontend` framework preset).

`frontend/vercel.json` rewrites every non-asset path to `/index.html` so client-side routes —
including all `/admin/*` routes — resolve on a hard refresh, while `sw.js`, the manifest and hashed
assets are served untouched. `sw.js` is sent `Cache-Control: no-cache` and
`Service-Worker-Allowed: /`.

---

## 10. Health checks and shutdown

- `GET /health` → `200 {"status":"ok"}`, or `503 {"status":"degraded"}` when MongoDB is unreachable.
  Point your platform's health check here.
- `SIGTERM` triggers a graceful shutdown: the Socket.IO server closes, in-flight requests drain, then
  MongoDB disconnects. Render/Railway send `SIGTERM` on deploy, so in-flight matches are not killed
  mid-request.

---

## 11. Production gates before going live

1. **MongoDB is configured and tested.** Run the store contract suite against a throwaway database
   (`MONGODB_TEST_URI=… npm run test -w backend`) and confirm 0 skipped.
2. **Create the first SUPER_ADMIN** using the bootstrap procedure in §5. Confirm it can sign in at
   `/admin/login` and that `/admin/database` and `/admin/audit-logs` work.
3. **CORS origins** list your real frontend host and nothing else.
4. **`JWT_ACCESS_SECRET`** is ≥ 32 random characters and is *not* the development default.
5. **Accept that restarts end active matches.** See §12.
6. **Verify the PWA in a real browser**: install it, then enable airplane mode and confirm the app
   launches and a full offline game is playable. Only the *build output* is verified by CI.

---

## 12. Known limitation — live state is in-memory

Active game state (hands, current turn, timers) lives in the backend process's memory. MongoDB
receives lifecycle records, results, public events and statistics — **not** the live state.

**Consequence: a backend restart, redeploy or scale event terminates every match in progress.
Active games do not survive a server restart.** This is not currently recoverable.

The seam for a fix already exists: `ActiveStateStore` (`backend/src/store/types.ts`) with
`MemoryActiveStateStore` as the current implementation, and `RoomManager` already writes snapshots.
A Redis adapter implementing that interface plus restore-on-boot would close the gap. Until then:

- keep a single backend instance (do not enable multiple replicas);
- expect matches to end on deploy;
- treat maintenance windows as match-ending, and use **maintenance mode** to stop new games first.

---

## 13. What has and has not been verified locally

| Verified locally | Requires a real environment |
|---|---|
| All 223 unit/integration tests | MongoDB contract tests (`MONGODB_TEST_URI`) |
| Both TypeScript builds and typechecks | Vercel / Render / Atlas deployment |
| PWA **build output** (precache, manifest, icons, fallback, API exclusion) | Service-worker install + airplane-mode launch |
| Admin authorization end-to-end over HTTP | Visual/admin-UX review on real screens |
| Offline play with a trapped `fetch` and a counting proxy | Cross-origin socket connection to a deployed backend |