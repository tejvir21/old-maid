# Test Report — Old Maid

**Run date:** 2026-10-11
**Environment:** Windows, Node v24.11.0, npm 11.20.0, npm workspaces.
**Command:** `npm test` (builds `shared` + `backend`, then runs every suite).

---

## 1. Summary

| Suite | Test files | Passed | Failed | Skipped | Not run |
|---|---:|---:|---:|---:|---:|
| `@old-maid/shared` (engine, rules, AI, RBAC, **termination**) | 3 | **66** | 0 | 0 | 0 |
| `backend` (rooms, sockets, HTTP, store contract, admin security, **slots**, **shuffle**, **privacy**, **incident**) | 12 | **172** | 0 | **18** | 0 |
| `frontend` (offline, online, sync, UI, admin UI, **connectivity**, **slot order**, **skew**, **e2e order**) | 11 | **107** | 0 | 0 | 0 |
| **Total** | **26** | **345** | **0** | **18** | **0** |

### 1a. MongoDB integration

```bash
cd backend && npx tsx scripts/withMongo.ts
```

```
Tests  190 passed (190)
```

The 18 tests skipped without a database are the `MongoStore` halves of the store contract and the
production guest -> socket -> room flow. They are **skipped, never reported as passing**.

### Issue-specific coverage

| Issue | Tests |
|---|---|
| 1 - Brave / blocked requests | `frontend/tests/net.blocked.test.ts` (16): block classification, layered probe fallback, failure threshold, bounded backoff, no concurrent probe stacking, session preserved, no Shields bypass |
| 2 - Joker position tracking | `backend/tests/drawSlots.test.ts` (16) + `backend/tests/slotShuffle.test.ts` (9, permutation never repeats) + `backend/tests/privacy.slots.e2e.test.ts` (8) + `frontend/tests/ui.slotOrder.test.tsx` (8, rendered order) + `frontend/tests/e2e.slotOrder.test.ts` (3, live server -> store) |
| 3 - game termination | `shared/tests/termination.test.ts` (19): 2-7 players, every AI difficulty x25 seeds, no draw after finish, replay refused, empty hands, degenerate state, card conservation |
## 2. Build and typecheck

| Step | Command | Result |
|---|---|---|
| Shared build | `npm run build:shared` | ✅ clean |
| Backend build | `npm run build -w backend` | ✅ clean |
| Frontend build | `npm run build -w frontend` | ✅ `tsc --noEmit` + `vite build` |
| Backend typecheck | `npm run typecheck -w backend` | ✅ clean |
| Frontend typecheck | `npm run typecheck -w frontend` | ✅ clean |
| **PWA output gate** | `node scripts/verify-pwa.mjs` | ✅ `24 precached files, manifest valid, icons valid, fallback + API exclusion present (858 KiB dist)` |

The PWA gate is not decorative — it fails the build if the precache list, manifest, icons,
navigation fallback or API exclusion are missing, or if the HTML references an asset that is not
precached. See `docs/PHASE_AUDIT.md` §6 for the Windows path bug that had been preventing it from
running at all.

---

## 3. Phase 1 — engine and AI (47 tests, `shared/tests/`)

| Area | Examples |
|---|---|
| Deck | 53 cards; exactly one Joker; Joker is not a normal rank/suit |
| Shuffle | Fisher–Yates determinism with a seeded RNG; no card lost or duplicated |
| Dealing | distribution across 2–7 seats; remainder to earlier seats |
| Pairs | pairs removed; 3-of-a-kind → one pair + leftover; Joker never pairs |
| Turns | clockwise progression; empty hands skipped; dead-end detection |
| Draw validation | `UNKNOWN_PLAYER`, `NOT_YOUR_TURN`, `TARGET_IS_SELF`, `INVALID_TARGET`, `TARGET_EMPTY`, `INVALID_CARD_INDEX` |
| Stale/duplicate | `STALE_TURN` rejection |
| Game over / winner | **the Joker holder wins**; every other player loses |
| Invariants | `assertInvariants` across full simulations: no duplicate card, exactly one Joker, **53-card conservation**, no unpaired duplicate rank |
| AI | all three difficulties play legal moves only; simulations complete and always declare the Joker holder |
| RBAC contract | role→permission matrix; grants cannot widen into `SUPER_ADMIN_ONLY`; validation schemas reject weak passwords and unknown roles |

## 4. Phase 2 — backend (104 tests, `backend/tests/`)

| File | Tests | Covers |
|---|---:|---|
| `rooms.test.ts` | 26 | create/join/leave, capacity 2–7, host transfer, AI fill, rematch, expiry, disconnect-pauses, reconnection, turn timeout → `TIMEOUT_AUTO_DRAW`, mid-game AI takeover, chat/emote toggles |
| `sockets.test.ts` | 10 | token auth, a complete 3-human game, **hidden-information audit over every byte received**, client attempts to dictate state are ignored |
| `http.test.ts` | 23 | health (+503 when DB down), config, error shape, auth, register/login, sync idempotency, plausibility, settings sync, **admin API rejects anonymous callers** |
| `store.contract.test.ts` | 13 + 10 skipped | one contract run against both stores |
| `admin.security.test.ts` | **32** | see §6 |

## 5. Phase 3 — frontend (72 tests, `frontend/tests/`)

| File | Covers |
|---|---|
| `offline.test.ts` | offline engine, pair removal, Joker rule, persistence across a simulated restart |
| `online.test.ts` | online controller, **privacy audit over every view the browser ever held** |
| `sync.test.ts` | queue persistence, backoff, duplicate prevention, permanent rejection, retry-safety against the real backend |
| `scenario.test.ts` | **end-to-end against the real compiled backend**: online → connection lost → complete offline AI game (with `fetch` trapped *and* a counting proxy) → reconnect → synced → lobby restored |
| `ui.offline.test.tsx` | full offline game through the real UI; reload mid-game restores from IndexedDB |
| `ui.online.test.tsx` | online table renders only the server's `PlayerView` |
| `admin.ui.test.tsx` | **15** — see §6 |

## 6. Phase 4 — admin (59 tests, all new)

### Backend — `backend/tests/admin.security.test.ts` (32)

Negative tests deliberately attempt unauthorized actions and assert they fail:

- unauthenticated access to all 12 admin routes → 401
- forged / garbage / **player-audience** token → 401
- login does not reveal whether an email exists (identical message)
- login response contains no hash or session material
- documented role matrix enforced (`MODERATOR` → 403 on `database/*`, `debug/*`)
- `SUPPORT` blocked from every write endpoint
- `ADMIN` cannot create/modify a `SUPER_ADMIN`
- `ADMIN` cannot grant itself `DATABASE_WRITE`
- admin cannot suspend or demote itself
- suspension revokes live sessions immediately
- **login throttling** (repeated failures eventually 429)
- password hashes / session hashes / TOTP secrets absent from six endpoints
- user detail omits the hash
- **ordinary ADMIN sees no hand and no Joker location**
- ordinary `ADMIN` blocked from the SUPER_ADMIN debug endpoint
- ban/unban revokes sessions and writes audit records; a reason is mandatory
- settings validated server-side (invalid values → 400)
- maintenance mode blocks new online games but leaves `offlineMode` on
- unknown collection → 400 (allow-list)
- non-editable field → 403; `$set` operator → 403
- permanent delete: SUPER_ADMIN only, and refused for `auditLogs` / `settings`
- audit log contains `ADMIN_LOGIN` with `adminId`, `ip`, `createdAt`
- audit records contain no credential material
- `AUDIT_READ` required (SUPPORT → 403)
- malformed JSON → 400; weak admin password → 400

### Frontend — `frontend/tests/admin.ui.test.tsx` (15)

- bearer token attached; admin token never sent outside `/api/admin/`
- **401 clears the session** so stale privileges cannot persist
- server error code/message surfaced
- route guard blocks a role lacking the permission and allows one that has it
- dashboard renders real server values
- users page hides destructive actions without `USERS_BAN`
- destructive action requires a typed reason before the confirm button enables
- database console renders `[redacted]` for credential-shaped fields and never prints the value
- protected collections marked
- settings inputs disabled for a read-only role

---

## 7. What is **not** verified

| Item | Why |
|---|---|
| 10 MongoDB contract tests | No `MONGODB_TEST_URI` / no reachable MongoDB in this environment |
| `MongoStore` admin collections | Consequence of the above — new code, type-checked but not executed |
| Service-worker install + "launch with no network" | Requires a real browser; only the **build output** was verified |
| Real-device layout, touch, safe-area, iOS audio | Requires real devices |
| Vercel / Render / Atlas deployment | Requires accounts and network egress |
| Redis live-state recovery | **Not implemented** — a backend restart ends active matches |

No result in this document is inferred from a build alone, and no skipped test is reported as passing.