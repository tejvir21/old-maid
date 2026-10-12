# Deployment alignment — read this before assuming a frontend bug

## The situation

The frontend (Vercel) and backend (Render) deploy **independently**. Nothing stops the browser
from holding a build from a different release than the server is running.

That is exactly what happened. Investigation of the `Invalid draw request.` incident found:

| | Production backend (Render) | Production frontend (Vercel) |
|---|---|---|
| Wire protocol | **v2** — opaque `slotId`, emits `draw_slots` | **v1** — sends positional `cardIndex` |
| Opponent cards | server-issued shuffled slots | `Array.from({length: cardCount})`, `key={i}` |

The result: a static card layout (the v1 client renders by position) and `Invalid draw request.`
(the v2 server rejects `cardIndex` because `requestDrawSchema` is `.strict()`). Both symptoms,
one cause. Full evidence: `docs/incident-2026-10-12-frontend-protocol-skew.md`.

A second, separate problem was found at the same time: **the deployed Vercel site is not built
from this repository at all.**

| | Served by Vercel | What this repo builds |
|---|---|---|
| `index.html` title | `Old Maid Online` | `Old Maid` |
| Script path | `/old-maid/static/js/main.<hash>.js` (CRA) | `/assets/index-<hash>.js` (Vite) |
| Base path | `/old-maid/` | `/` |

`git log -S` confirms **neither the title `Old Maid Online` nor the base path `/old-maid/` has
ever existed in any commit of this repository**. In addition, every asset URL returns the 349-byte
`index.html` instead of a file, because the SPA catch-all rewrite is shadowing real assets.

## Required action: point Vercel at this repository

1. **Vercel project settings → Git**
   - Confirm the repository is `tejvir21/old-maid`.
   - Confirm the production branch is `main`.
   - If the project is still linked to a different repo (or a fork), relink it.

2. **Vercel project settings → Build & Development**
   - Root Directory: **`.`** (repository root, **not** `frontend`)
   - Install Command: `npm ci --include=dev`
   - Build Command: `npm run build -w @old-maid/shared && npm run build -w frontend`
   - Output Directory: `frontend/dist`

   The root `vercel.json` already encodes the install command, build command and output
   directory, so these can be left blank **provided the Root Directory is `.`**.

3. **Redeploy** (not just a preview — Production).

4. **Verify the served `index.html`.** It must reference `/assets/…`, not `/old-maid/static/…`:

   ```bash
   curl -s https://<your-vercel-domain>/ | grep -o 'src="[^"]*"'
   ```

   Seeing `Old Maid Online` or `/old-maid/static/` means the deployment is still wrong.

5. **Verify the assets resolve to JavaScript, not HTML:**

   ```bash
   curl -s -o /dev/null -w '%{content_type}\n' https://<your-vercel-domain>/assets/<hashed>.js
   ```

   Must be `application/javascript`. If it returns `text/html`, the SPA rewrite is shadowing
   assets — check that `vercel.json` `rewrites` does not match asset paths, and that
   `outputDirectory` is correct.

## Backend environment

| Variable | Value |
|---|---|
| `CLIENT_URL` | the production Vercel URL (must match exactly, including scheme) |
| `ALLOWED_ORIGINS` | any additional origins, comma-separated. **Never `*`.** |
| `VITE_API_URL` (Vercel) | `https://<render-host>` |
| `VITE_SOCKET_URL` (Vercel) | the same Render host |

## Debugging opponent-card ordering

Six stages decide whether a reshuffle is visible. Each is logged with **opaque slot ids, counts and
turn numbers only** — never a card identity, rank, suit or hand index.

Backend:

```bash
SLOT_DEBUG=1 npm start -w backend
```

Browser console, then reload:

```js
localStorage.setItem("SLOT_DEBUG", "1")
```

| Stage | Where | Log |
|---|---|---|
| 1 server generates a permutation | `roomManager.issueDrawSlots` | `[slots] built` |
| 2 server sends it to that viewer only | `roomManager.issueDrawSlots` | `[slots] built` (includes viewer) |
| 3 client receives the event | `onlineStore` `drawSlots` handler | `[slots] recv` |
| 4 client state updated | `onlineStore` `drawSlots` handler | `[slots] store` |
| 5 React renders that order | `GameTable.choicesFor` | `[slots] render` |
| 6 clicking sends that slot | `onlineStore.draw` | `[slots] send` |

`order` is the comma-joined short form of the opaque slot ids **in render order**.

- `recv`/`store`/`render` agree but the order never changes between turns → the shuffle is
  repeating a permutation.
- `render` changes but the cards do not move → a stale bundle is being served; check the
  deployment steps above.

Clear with `localStorage.removeItem("SLOT_DEBUG")`.

## Post-deploy smoke test

Frontend and backend must be on the **same** protocol version:

```bash
curl -s https://<render-host>/api/config | grep protocolVersion
```

This returns the server's `PROTOCOL_VERSION`. It must match the constant in
`shared/src/protocol.ts` for the frontend build you deployed.

Then, in a browser:

1. Open the game, create a room, join a second player.
2. Take a turn — the opponent's face-down cards must appear, and drawing one must succeed.
3. On the next turn, the opponent's cards must be in a **different arrangement**.

If the client is out of date it now refuses to connect and shows **"This app is out of date with
the server"** with a Reload button, instead of silently rendering a positional layout and failing
every draw. That is the mitigation for version skew; it is not a substitute for aligning the
deployments.