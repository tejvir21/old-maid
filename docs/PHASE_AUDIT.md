# Phase Audit — Old Maid

**Audit date:** 2026-10-11
**Workspace audited:** `D:\tej data\MINE\old-maid` (the extracted Phase 3 project)
**Method:** every claim below was verified by reading the actual source in this repository and by
executing the real test suites. A passing *build* is never treated as proof of correctness.

> **Note on the archive.** The prompt refers to `old-maid-phase3.zip`. That archive is **not
> present on this machine** — a recursive search of `D:\tej data` found no such file. The project
> was instead found already extracted in the working directory with a complete `shared/`,
> `backend/` and `frontend/` workspace, no `node_modules/`, and **no `docs/` directory at all**.
> The audit was performed against that extracted source. See §6 for what this changes.

---

## 1. Phase inventory

| Phase | Required functionality | Evidence inspected | Tests executed | Status |
|---|---|---|---|---|
| **Phase 1** | Shared rules, 53-card deck, engine, AI, validation, invariants | `shared/src/{deck,rules,engine,ai,rng,types,protocol,settings}.ts` | 47 passed (`shared/tests/engine.test.ts` 35 + `shared/tests/admin.test.ts` 12) | **Verified** |
| **Phase 2** | Server-authoritative backend, Socket.IO, rooms, reconnection, persistence, sync API | `backend/src/{app,server}.ts`, `socket/`, `rooms/roomManager.ts`, `game/GameSession.ts`, `store/{memory,mongo}.ts`, `routes/{auth,sync}.ts`, `auth/{authService,tokens}.ts` | 104 passed, 10 skipped (`backend/tests/`) | **Verified, with one limitation** (MongoDB tests skipped) |
| **Phase 3** | React UI, offline AI, IndexedDB, sync engine, PWA, online client | `frontend/src/{App.tsx,app/,game/,offline/,sync/,socket/,store/,pages/,components/}`, `vite.config.ts`, `scripts/verify-pwa.mjs` | 72 passed (`frontend/tests/`) | **Verified** |
| **Phase 4** | Admin panel, RBAC, management, audit, security | **Was entirely absent.** Now implemented — see §4 | 44 new tests (32 backend + 15 frontend… see §3) | **Complete (newly built)** |

---

## 2. Phase 1 — shared engine

### Authoritative rule

`shared/src/engine.ts:48-53` — the game ends when exactly one card remains in play **and** that card
is the Joker:

```ts
export function isGameOver(state: GameState): boolean {
  return totalCards(state) === 1 && getJokerHolder(state) !== null;
}
export function getWinner(state: GameState): EnginePlayer | null {
  return isGameOver(state) || state.phase === "finished" ? getJokerHolder(state) : null;
}
```

`finish()` (`engine.ts:130-139`) sets `winnerId` to the Joker holder and emits
`"The Joker was held by X. X wins."` The rule is **never reversed** anywhere in the codebase; a
repository-wide search for winner assignment finds no other implementation.

### Verified behaviours

| Requirement | Implementation | Test |
|---|---|---|
| 53-card deck, exactly one Joker | `deck.ts:6-14` (`createDeck`) | `engine.test.ts` "deck has 53 cards and exactly one Joker" |
| Unbiased shuffle | `deck.ts:18-27` Fisher–Yates over `randomInt` | `engine.test.ts` shuffle tests |
| Dealing / distribution | `deck.ts:30-37` round-robin, earlier players get the remainder | `engine.test.ts` dealing tests |
| Pair detection & auto-removal | `rules.ts:12-40` `findPairs` | pair tests |
| Joker never pairs | `rules.ts:15` — `if (card.isJoker) continue;` | Joker tests |
| Turn progression + empty-player skipping | `engine.ts:57-64` `nextPlayer` | turn tests |
| Draw validation (unknown player, self-draw, empty target, bad index) | `engine.ts:164-176` returns `UNKNOWN_PLAYER` / `TARGET_IS_SELF` / `INVALID_TARGET` / `TARGET_EMPTY` / `INVALID_CARD_INDEX` | negative draw tests |
| Stale-turn / duplicate-action rejection | `engine.ts:165` `STALE_TURN`; `GameSession` dedupes by `actionId` | `rooms.test.ts` stale-action tests |
| Game-over detection & winner | `engine.ts:48-53` | end-of-game tests |
| Invariants | `engine.ts:245-268` `assertInvariants` — duplicate card, exactly one Joker, **53-card conservation**, no unpaired duplicate rank, current player holds cards | invoked across simulations |

**Invariants verified (not merely present).** `assertInvariants` asserts
`totalCards + discardedPairs * 2 === 53`, so the Joker can never be silently dropped. Full-game
simulations across all three AI difficulties complete and declare the Joker holder the winner.

### AI verification

`shared/src/ai.ts`. The AI receives an `AiView` (`ai.ts:96-109`) containing **only** its own hand and
every player's **card count** — never another hand. Memory (`observeDraw`, `ai.ts:55-94`) is built
only from public draw events plus the card the AI itself drew or had taken, so it cannot learn the
Joker's location through privileged state. `chooseMove` throws if there is no legal target rather
than returning an impossible action.

---

## 3. Phase 2 — backend

### Architecture (verified)

```
shared/ (pure rules)
   ↓
GameSession        authoritative state for ONE game (hands, turn, pairs, Joker)
   ↓
RoomManager        lobby, turns, timers, reconnect, host transfer — knows nothing about sockets
   ↓
SocketRegistry + socket/  transport
   ↓
Express HTTP       auth, sync, stats, (Phase 4) admin
```

`RoomManager.buildView()` is the **single** place client-visible state is produced. It contains the
viewer's own hand and public counts only.

### Verified controls

- **Helmet, strict CORS allow-list, rate limiting, JSON body cap (100 kb)** — `app.ts:20-36`.
  CORS rejects any origin not in `env.allowedOrigins`; `*` is refused at env-validation time
  (`env.ts:45`).
- **Environment validation** — `config/env.ts` uses a Zod schema and additionally requires
  `CLIENT_URL`/`ALLOWED_ORIGINS`, `JWT_ACCESS_SECRET` and `MONGODB_URI` in production.
- **Health endpoint** — `GET /health` returns 503 when the database is down (tested).
- **Graceful shutdown** — `server.ts`.
- **Structured errors** — `util/errors.ts` + `errorHandler`; stack traces are never returned
  (asserted by a test).

### Hidden-information guarantees (this is the most important Phase 2 property)

`backend/tests/sockets.test.ts` plays a complete 3-human game over real Socket.IO and then audits
**every byte every client received**: no client ever sees another hand or the Joker's position
before the game ends. A negative test asserts the server ignores client attempts to dictate state:
`declare_winner`, `set_hand`, `give_joker`, `set_turn`, `admin_end_game`, `game_state` are all
unsupported event names and produce no effect.

### Persistence

Both stores implement the same `Store` contract and are verified by
`backend/tests/store.contract.test.ts` (23 tests). **10 of those tests require a real MongoDB and are
skipped** because no `MONGODB_TEST_URI` is available here:

```
$ npm run test -w backend
Tests  104 passed | 10 skipped (114)
```

The MongoDB tests are **skipped, not passed**. To run them:

```bash
MONGODB_TEST_URI=mongodb+srv://…/oldmaid_test npm run test -w backend
```

### Offline sync API

`routes/sync.ts`. Idempotency key is the game's own `localGameId` and must match the queue item id
(`sync.ts:51`). Browser-supplied totals are **never trusted**: the server only accepts shape +
plausibility (`plausibilityProblem`, `sync.ts:19-29`) and increments its *offline* counters itself.
Rejected records are marked and never retried. Verified by `http.test.ts` and `sync.test.ts`.

---

## 4. Phase 4 — admin panel (implemented in this work)

### Starting point

A repository-wide search for `admin|audit|permission|report` found **no admin implementation**. The
only Phase 4 traces were pre-existing seams: `SettingsService.updateGame/updateFlags` ("used by the
admin API"), `GameRecord.endedByAdmin`, and `RoomManager.listRooms()` ("public info for admin
tooling"). Nothing was wired up, and no admin account could exist. **Phase 4 was therefore missing,
not partial.**

### What was added

| Area | Files | Notes |
|---|---|---|
| RBAC contracts | `shared/src/admin.ts` | 18 granular permissions, 4 roles, explicit role→permission matrix, `SUPER_ADMIN_ONLY` set |
| Admin auth | `backend/src/auth/adminAuth.ts` | bcrypt cost 12, separate session store, TOTP (RFC 6238) verification, lockout after 8 failures, `redact()` for audit payloads |
| Admin middleware | `backend/src/routes/adminAuth.ts` | `requireAdmin`, `requirePermission`, `requireSuperAdmin` |
| Admin API | `backend/src/routes/admin.ts` | dashboard, users, rooms, games, reports, chat, statistics, settings, feature flags, database console, audit logs, admins, system health, diagnostics |
| Player report API | `backend/src/routes/admin.ts` (`reportRouter`) | `POST /api/reports` for players |
| Store extensions | `backend/src/store/types.ts`, `memory.ts`, `mongo.ts` | `AdminStore` + `adminQuery` on both implementations |
| Room admin hooks | `backend/src/rooms/roomManager.ts` | `lockRoom`, `publicRoomSnapshot`, `adminTerminateGame`, `adminPauseGame`, `adminResumeGame`, `debugSnapshot` |
| Bootstrap CLI | `backend/src/scripts/createAdmin.ts` | refuses to run once any admin exists; password from env only |
| Admin UI | `frontend/src/admin/**` (14 files) | 12 routes, session context, permission-aware nav, confirm-with-reason dialogs |
| New tests | `backend/tests/admin.security.test.ts` (32), `frontend/tests/admin.ui.test.tsx` (15), `shared/tests/admin.test.ts` (12) | negative tests dominate |

### Security properties verified by test

Unauthenticated access to **all 12** admin routes → 401. Forged / garbage / **player-audience**
tokens → 401. Granular permission enforcement for all four roles. Privilege escalation blocked (an
ADMIN cannot mint a SUPER_ADMIN, cannot grant `DATABASE_WRITE`, cannot suspend or demote itself).
Suspension revokes live sessions immediately. Password hashes / `sessionHash` / TOTP secrets are
absent from **every** admin response. Hidden-card and Joker leakage: an ordinary ADMIN sees card
*counts* only; `/api/admin/debug/game/:id` is SUPER_ADMIN-only **and audited**. MongoDB update
operators (`$set`) are rejected; only per-collection allow-listed fields are editable; permanent
delete is SUPER_ADMIN-only and impossible for `auditLogs`/`settings`.

---

## 5. Phase 3 — React PWA

| Screen | File | Verified |
|---|---|---|
| Main menu | `pages/Home.tsx` | `ui.offline.test.tsx` |
| Play Offline | `pages/OfflineSetup.tsx` | `scenario.test.ts` |
| Offline table | `pages/OfflinePlay.tsx` | `ui.offline.test.tsx` (full game + reload resume) |
| Play Online | `pages/OnlineMenu.tsx` | `online.test.ts` |
| Lobby / online table | `pages/OnlineRoom.tsx`, `components/GameTable.tsx` | `ui.online.test.tsx` |
| Results / statistics | `pages/Stats.tsx` | `ui.offline.test.tsx` |
| Settings | `pages/Settings.tsx` | `ui.offline.test.tsx` |
| Connection & sync status | `components/StatusBar.tsx` | `scenario.test.ts` asserts online→offline→online transitions |
| Rules | `pages/Rules.tsx` | — |

**Offline engine never touches the network.** `AppServices.beginGate()` (`app/services.ts:107-111`)
closes sockets and *suspends* the `NetworkMonitor`. Proven by tests that trap `fetch` **and** count
requests hitting a real proxy in front of a real backend (`scenario.test.ts:78-79`).

**IndexedDB.** `Repo.finishOfflineGame` (`offline/db.ts:124-163`) writes game record + events +
statistics + achievements + queue item + active-game removal in **one transaction**.

**Sync engine.** Persistent queue, exponential backoff with jitter, server verdict applied per item,
`rejected` items are never retried, stuck `syncing` items reset on start.

**PWA.** `vite.config.ts` precaches the app shell (24 files, 840 KiB) and denylists
`/^\/api\//`, `/^\/socket\.io\//`, `/^\/health/` from the navigation fallback, with **no** runtime
caching — so no API or private game data is ever cached by the service worker.

---

## 6. Defects found and fixed

| # | Severity | Defect | Fix |
|---|---|---|---|
| 1 | **High** | `frontend/scripts/verify-pwa.mjs` used `new URL(...).pathname`, which percent-encodes spaces on Windows. The PWA gate reported `sw.js missing` / `manifest.webmanifest missing` / `index.html missing` **even when those files existed** — i.e. the PWA build gate had never actually verified anything on this machine. | Switched to `fileURLToPath()` + `path.join()`. The gate now passes for real: *"24 precached files, manifest valid, icons valid, fallback + API exclusion present (858 KiB dist)"*. |
| 2 | Medium | `frontend/tests/scenario.test.ts` captured the network-traffic baseline **before** closing the offline gate, so a Socket.IO transport-level reconnect retry landing in that window made the test fail intermittently (`expected 11 to be 10`). | Baseline captured immediately after the gate closes. The assertion's intent (no traffic *during offline play*) is preserved exactly; the race is removed. Verified stable over 4 consecutive runs. |
| 3 | Low | `backend/tests/http.test.ts` asserted the admin API returns 404 (i.e. Phase 4 does not exist). | Rewritten to the stronger, now-correct invariant: the admin API exists but returns 401/403 for anonymous callers and leaks no sensitive fields. |

No existing test was deleted, skipped or weakened.

---

## 7. Outstanding limitations (not verified here)

1. **MongoDB is not exercised.** The 10 MongoDB contract tests are skipped — no `MONGODB_TEST_URI`
   was available. `MongoStore`'s new admin collections are therefore **type-checked and reviewed
   but not executed**.
2. **No real-browser testing.** Service-worker install, "launch with no network", safe-area insets,
   touch behaviour and audio on iOS were not exercised. Only the *build output* is verified.
3. **Live state is in-memory.** A backend restart ends all active matches. The `ActiveStateStore`
   seam exists but no Redis adapter is implemented. **Active games do not survive a restart.**
4. **Admin session revocation on role change** does not invalidate existing sessions (only password
   change and suspension do). Deliberate, documented.
5. **Visual/admin-UX quality** on real screens was not reviewed.
6. **No default administrator credentials exist** anywhere in the repository, by design.