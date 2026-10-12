# Admin Security — Old Maid

How the admin panel is protected, and how to verify each claim.

---

## 1. Trust model

Admin access is **entirely separate** from player access. The two never intersect:

| | Player | Admin |
|---|---|---|
| Identity store | `users` | `admins` |
| Session store | `sessions` (hashed) | `adminSessions` (hashed) |
| Token | JWT, `audience: old-maid:player` | Opaque 256-bit secret, `Authorization: Bearer <secret>` |
| Token issuer | `POST /api/auth/guest` etc. | `POST /api/admin/login` |
| Login throttle | 20 req/min | 10 failures / 15 min, per IP |
| Password policy | ≥ 8 chars | ≥ 12 chars, upper + lower + digit |

A valid **player** JWT is rejected by the admin API (the audiences differ and the admin path never
verifies a JWT). An admin secret is rejected by the player API. Both directions are covered by
negative tests in `backend/tests/admin.security.test.ts`.

**Frontend route guards are UX only.** `AdminGate` hides pages a role cannot use, but every admin
API call is independently authorized on the server. Deleting the guard grants nothing.

---

## 2. Sessions

- A session secret is generated with `crypto.randomBytes(32)`; only its SHA-256 hash is stored.
- **TTL: 8 hours** (`ADMIN_SESSION_TTL_MS`).
- Sessions are revoked **immediately** when the account is suspended or its password changes.
- `POST /api/admin/logout` revokes the current session.
- A suspended admin's already-issued tokens stop working on the very next request — the token is
  resolved, the account status re-checked, then rejected (`AdminAuthService.authenticate`).
- The browser keeps the token in `sessionStorage`, so closing the tab ends the session.

---

## 3. Roles and permissions

Roles are a convenience layer. **Authorization always checks a concrete permission**, so an
individual admin can be narrowed without code changes.

| Permission | SUPER_ADMIN | ADMIN | MODERATOR | SUPPORT |
|---|:--:|:--:|:--:|:--:|
| `USERS_READ` | ✅ | ✅ | ✅ | ✅ |
| `USERS_WRITE` | ✅ | ✅ | ❌ | ❌ |
| `USERS_BAN` | ✅ | ✅ | ✅ | ❌ |
| `ROOMS_READ` | ✅ | ✅ | ✅ | ✅ |
| `ROOMS_WRITE` | ✅ | ✅ | ❌ | ❌ |
| `GAMES_READ` | ✅ | ✅ | ✅ | ✅ |
| `GAMES_MANAGE` | ✅ | ✅ | ❌ | ❌ |
| `GAME_DEBUG_READ` | ✅ | ❌ | ❌ | ❌ |
| `GAME_DEBUG_WRITE` | ✅ | ❌ | ❌ | ❌ |
| `SETTINGS_READ` | ✅ | ✅ | ❌ | ❌ |
| `SETTINGS_WRITE` | ✅ | ✅ | ❌ | ❌ |
| `DATABASE_READ` | ✅ | ❌ | ❌ | ❌ |
| `DATABASE_WRITE` | ✅ | ❌ | ❌ | ❌ |
| `REPORTS_READ` | ✅ | ✅ | ✅ | ✅ |
| `REPORTS_MANAGE` | ✅ | ✅ | ✅ | ❌ |
| `AUDIT_READ` | ✅ | ✅ | ✅ | ❌ |
| `ADMINS_READ` | ✅ | ✅ | ❌ | ❌ |
| `ADMINS_WRITE` | ✅ | ❌ | ❌ | ❌ |

Grants are **additive but capped**: `effectivePermissions()` silently drops any
`SUPER_ADMIN_ONLY` permission requested by a non-SUPER_ADMIN
(`shared/src/admin.ts: effectivePermissions`). There is no request shape that can escalate.

### Privilege-escalation guards

| Attempt | Result | Enforced in |
|---|---|---|
| ADMIN creates a SUPER_ADMIN | 403 | `adminAuth.createAdmin` |
| MODERATOR creates any admin | 403 (no `ADMINS_WRITE`) | route middleware |
| ADMIN edits a SUPER_ADMIN | 403 | `adminAuth.updateAdmin` |
| ADMIN grants itself `DATABASE_WRITE` | grant is dropped (and logged) | `effectivePermissions` |
| ADMIN suspends itself | 403 | `adminAuth.updateAdmin` |
| ADMIN demotes itself | 403 | `adminAuth.updateAdmin` |
| ADMIN reads hidden card state | 403 | `requireSuperAdmin` |

---

## 4. Data protection

**Never returned by any admin endpoint** (verified by a test that scans responses from six
endpoints for `/passwordHash|sessionHash|totpSecret/i`):

- password hashes · session hashes · TOTP secrets · tokens · cookies

**Hidden game state.** An ordinary ADMIN sees, per room: player names, card **counts**, connection
status, whose turn it is, and the draw count. It never sees a hand or the Joker's location. Full
hands exist only behind `GET /api/admin/debug/game/:id`, which requires SUPER_ADMIN **and** writes a
`DEBUG_STATE_READ` audit entry on every access.

**Audit payloads are redacted.** `redact()` (`adminAuth.ts`) drops any key matching
`/password|secret|token|hash|authorization|cookie/i` before an entry is written, so a before/after
diff can never capture a credential.

---

## 5. Database console safety

The console is a **controlled interface**, not a database client:

1. **Allow-listed collections only** — `users, rooms, games, gamePlayers, gameEvents, chatMessages,
   syncRecords, settings, reports, auditLogs`. Any other name is a 400. `admins`, `adminSessions`,
   `sessions` and `bans` are deliberately *not* reachable here.
2. **Arbitrary queries impossible** — the client supplies only `q`, `limit`, `offset`. Filters are
   built server-side and every search term is escaped before being embedded in a RegExp.
3. **Arbitrary updates impossible** — each collection has a fixed editable-field list; any other
   field is 403. Keys beginning with `$` are rejected outright, so no MongoDB operator injection.
4. **Soft delete by default.** `DELETE` sets `isDeleted`/`status`. Permanent deletion is a separate
   `…/purge` route requiring SUPER_ADMIN, and it refuses the protected collections `auditLogs` and
   `settings`.
5. **Player invariants untouched.** Editing a `user` can only change `username`, `avatar`, `status`.
   No admin path can write a hand, a winner, or the Joker's position.

---

## 6. Audit log

Every privileged modification writes a record with
`adminId, adminUsername, adminRole, action, resource, resourceId, before, after, reason, ip,
userAgent, createdAt`.

Audited actions include: admin login/login-failure/logout, admin create/update/suspend/restore and
session revocation, user ban/unban/suspend/restore/update, room close/expire/lock/unlock,
game terminate/pause/resume, settings and feature-flag changes, maintenance-mode changes, database
edit/delete/export, report status/assignment, chat deletion, and hidden-state diagnostics.

The audit log is **append-only**: it has no edit route, and its `purge` is refused even for a
SUPER_ADMIN.

---

## 7. Game-rule integrity

- **Admins never fabricate a winner.** `adminTerminateGame` records the match as `abandoned` with
  `endedByAdmin: { adminId, reason }` and broadcasts `winnerId: null`. An administratively ended
  match is a distinct outcome from a naturally completed one, and the UI labels it
  *(by admin)*.
- **The Joker rule is untouchable.** `shared/src/cardSettingsSchema` pins `jokerCount: 1` and
  `deckType: "standard52"`; no admin setting can alter the deck or the win condition.
- **Maintenance mode never blocks offline play.** `offlineMode` is an independent flag, and offline
  games run entirely client-side.

---

## 7a. Card-identity privacy (opaque draw slots)

Online draws do **not** name a card. The client sends an opaque, single-turn **slot id**; the
server resolves it to a real hand index in private.

| Property | How it is enforced |
|---|---|
| No index on the wire | `requestDrawSchema` is `.strict()`: `cardIndex` is rejected outright |
| No stable card id | Slot ids are 128 bits from `crypto.randomBytes`, base64url; nothing is derived from rank, suit or position |
| Randomised per turn | Fisher–Yates over the target's real indices, re-minted on every turn change |
| Scoped | Slot table is keyed by `(room, viewer, turnId)` and maps target → slot → index |
| Single use | `consumeSlot` removes it after resolution; the table is nulled on turn change |
| Cross-player rejected | `resolveSlot` compares `table.viewerId` to the caller |
| Cross-target rejected | The slot must exist in that target's map |
| Stale turn rejected | `table.turnId` must equal the request's `turnId` |
| Out of turn rejected | Checked before slot resolution, so nothing about slot validity leaks |
| Cleared at game over | `room.slots = null` in `finishGame`, `finishAbandoned`, rematch and close |
| `draw_public` carries no index | The field was removed from the public event payload |

The UI keys face-down choices by slot id (not index, not card id), and `framer-motion` animates
the reshuffle so a card visibly moves between turns.

Covered by `backend/tests/drawSlots.test.ts` (16) and
`backend/tests/privacy.slots.e2e.test.ts` (8, asserting against real serialised socket payloads).

**Offline play is unaffected**: it is single-device, so the local engine resolves positions
directly and there is nothing to protect.

---

## 8. Verifying this yourself

```bash
# 32 backend admin security tests (negative tests included)
npm run test -w backend

# 15 frontend admin UI/RBAC tests
npm run test -w frontend

# RBAC matrix contract, mirrored on the frontend
npx vitest run tests/admin.test.ts -w @old-maid/shared
```

Key negative tests to look for in `backend/tests/admin.security.test.ts`:

- `rejects every privileged route without a token`
- `rejects a forged / player-audience / garbage token`
- `an ADMIN cannot create or modify a SUPER_ADMIN`
- `an ADMIN cannot grant itself super-admin-only permissions`
- `a suspended admin's existing sessions stop working immediately`
- `never returns password hashes or session material to any admin endpoint`
- `does not expose another player's hand or the Joker location to an ordinary admin`
- `refuses MongoDB update operators entirely`
- `only SUPER_ADMIN can permanently delete, and never audit logs or settings`
- `never stores password/secret material inside an audit record`

---

## 9. Reporting a vulnerability

Do not open a public issue. Contact the operator of the deployment directly with the reproduction
steps and the affected endpoint.