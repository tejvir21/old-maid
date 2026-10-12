# Root cause — `Invalid draw request.` in production

**Date:** investigation of `https://old-maid-p3iq.onrender.com` + `https://old-maid.vercel.app`
**Commit at time of investigation:** `8f4f566` (the slot implementation)

## Verdict

The server is **not** broken. The deployed **frontend** is a different application that is not
being built from this repository.

## Evidence

### 1. The backend correctly implements the slot protocol

Direct socket probe against production (`backend/scripts/probeProdProtocol.ts`):

```
[probe] 2-human room 3BDFY started, turnId=1
[probe] turn 1 (A) slots=8 valid_draw=OK revealed=2clubs slot0_id=h2XIP1iCgI… reuse=rejected(STALE_TURN)
```

- `draw_slots` is emitted to the acting player only (the idle player receives none).
- A server-issued `slotId` draw **succeeds** on production.
- Re-using the same `slotId` is **rejected** (`STALE_TURN`).
- A legacy `{ cardIndex: 0 }` payload is rejected with **exactly** `Invalid draw request.`

That last point matches the reported error string character for character.

### 2. The deployed frontend is not this repo's build

| | Deployed on Vercel | What this repo builds |
|---|---|---|
| `index.html` title | `Old Maid Online` | `Old Maid` |
| Script path | `/old-maid/static/js/main.<hash>.js` (CRA layout) | `/assets/index-<hash>.js` (Vite) |
| Base path | `/old-maid/` | `/` |

- `git log -S "Old Maid Online"` → **no commit in this repo ever contained that title.**
- `git log -S "/old-maid/"` → **no commit in this repo ever used that base path.**
- The repo has 5 commits total and has always been a Vite project.

### 3. The deployed bundle is unreachable

Every asset URL returns the same **349-byte `index.html`** with `Content-Type: text/html`:

```
/assets/index-DuD5hrVT.js              -> 200|text/html; charset=utf-8   (our real asset)
/old-maid/static/js/main.8a492a61.js   -> 200|text/html; charset=utf-8   (its own asset)
/sw.js                                  -> 200|text/html; charset=utf-8
```

The SPA catch-all rewrite in `vercel.json` (`"source": "/(.*)" -> "/index.html"`) is matching
every path and shadowing the real assets. The result is that the app is being served an HTML
document where JavaScript is expected.

## Why the reported symptoms follow

The stale client speaks the **old protocol**. It:

1. renders opponent cards with `Array.from({ length: seat.cardCount }, (_, i) => …)` and
   `key={i}` — **positional**, which is exactly the "same visual arrangement every turn" symptom;
2. sends `{ targetPlayerId, cardIndex, turnId, actionId }`.

The new server rejects `cardIndex` because `requestDrawSchema` is `.strict()` and requires
`slotId`. The result is the literal message **`Invalid draw request.`**

So both reported symptoms — static card layout *and* the error — are one cause: **frontend and
backend are running different protocol versions**.

## What is NOT the cause

- Not the slot implementation (verified working in production).
- Not a stale service worker (the SW cannot load either — its URL also 404s to HTML).
- Not a turn-validation or slot-invalidation bug.
- Not `sanitizeFilter` / auth (that was `bd4a6ae` and is unrelated).

## The fix

The repository code is already correct for the deployed backend. What is required is a **deployment
alignment**, plus a real robustness gap that this incident exposed and which is worth fixing in
code:

> A version-skewed client currently gets an opaque `Invalid draw request.` and a card layout that
> silently leaks position. The client should detect skew, say so, and refuse to draw rather than
> present a stale positional UI.

See `PROTOCOL_VERSION.md` and the accompanying code changes for the mitigation.