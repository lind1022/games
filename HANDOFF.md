# HANDOFF.md

Snapshot of where this project actually stands, for whoever (or whichever session) picks it up
next. This is a point-in-time status doc, not a spec — [CLAUDE.md](CLAUDE.md) is the durable spec,
[PLAN.md](PLAN.md) is the phased build plan. This file goes stale; trust `git log` and the code over
it if they disagree.

**As of 2026-08-16:** Phases 0-6 are committed and pushed (`447d25e`, `66b689f`, `98a9cb6`, `4b455ee`,
`f3e4edc`, `c6449b0`, `a4185cf`). Phase 5 (admin panel, plus a Reissue action and a raised chat-log
display cap added after initial review) was scripted-end-to-end-tested against throwaway server
instances rather than the product owner's real dev server, and committed on the product owner's
go-ahead to move on — it does **not** carry an explicit manual-browser-pass confirmation the way
Phases 1-4 do (see §3).

**Self-hosting is live and confirmed working by the product owner** — not just this session's own
rehearsal (§2/§4) but real usage: they stood up a Cloudflare quick tunnel, hit some real setup
friction along the way (documented in §5, all now either fixed or explained), and successfully joined
their own self-hosted game through the public tunnel URL. Two real bugs surfaced during that live
usage and are covered in §5: one is root-caused, fixed, and committed (`0692b21`); the other stopped
reproducing before its root cause was confirmed — flagged, not silently closed out, in case it
resurfaces. See §6 for what's next.

Phase 6 (deploy, durability, backups — `a4185cf`) and the self-hosting pivot on top of it
(`cca9685`, `28c1b08`) are both committed. The product owner decided to **self-host for now instead
of deploying to Railway** (their own machine, exposed via a public tunnel, reachable only while
they're actively hosting a session — not always-on), with Railway explicitly kept as the path to
switch back to once the game is more mature. The dirty-chunk-flush optimization is also being
**deliberately skipped**, per the product owner's explicit call. Everything achievable without a real
Railway account is done and locally verified: boot-time writability assertion, `GET /health`,
explicit `0.0.0.0` bind, a real `PRAGMA user_version` migration runner, a local `VACUUM INTO` backup
mechanism with a rehearsed restore, and — the biggest find in Phase 6 itself — **a working production
run path that didn't exist before** (the server's old `dist/index.js` start command pointed at a
build that was never actually produced; production now runs `tsx` directly like dev does, and the
server now serves the client's `vite build` output itself, realizing "one same-origin path works in
dev and prod" from Phase 0's own stated intent, which had never been wired up). This same production
path is exactly what self-hosting needs, so the pivot required almost no new code — just a small
`ALLOWED_ORIGIN` improvement (comma-separated list) and two new docs:
**[SELF_HOSTING.md](SELF_HOSTING.md)** (current, primary path, tunnel-based — LAN hosting was
explicitly removed per product-owner request, see below) and **[DEPLOY.md](DEPLOY.md)** (Railway,
paused but complete and ready). CLAUDE.md §1/§3/§9 were updated to reflect self-hosting as the current
mode without losing the Railway path or the long-term always-on intent. See §6.

---

## 1. Quick start

```sh
nvm use          # or just check node --version matches .nvmrc (24.18.0)
npm install
npm run dev       # runs server (tsx watch) + client (vite) concurrently
```

Open **http://localhost:5173**. The server listens on **:8787**; Vite proxies `/ws` to it. World
data lands in `/data/world.db` (gitignored) — delete that file for a truly clean slate.

Other commands:
- `npm run typecheck` — `tsc -b` across all four workspace packages
- No test suite exists yet (no framework chosen) — verification so far has been scripted
  smoke tests run ad hoc and discarded (see §4)

---

## 2. What's done

### Phase 0 — scaffolding & shared contracts (committed, pushed: `447d25e`)
npm workspaces (`shared/server/client/tools`) wired via TS project references; `/shared` locks the
contracts from PLAN.md §1 — block-type table (`blocks.ts`), chunk/coordinate math (`world.ts`), the
RLE chunk codec (`rle.ts`), zod-validated WS protocol schemas (`protocol.ts`). `school map.png` was
untracked from git per decision D3 (still present in earlier history — see §5).

### Phase 1 — vertical slice (committed, pushed: `66b689f`)
Real server authority + persistence loop on a flat 5×5-chunk test world:

- **`server/src/`** — `db.ts` (SQLite via better-sqlite3: WAL pragmas, chunk load/save, `block_changes`
  with pre-image, pure write-through per PLAN.md C6), `world.ts` (flat-grass generation, load-or-generate
  on boot), `rateLimit.ts` (token bucket, 20 cap / 15 per sec refill), `index.ts` (WS wiring: dev-stub
  join → world-state → validate/persist/broadcast block updates).
- **`client/src/`** — `mesh.ts` (a real **greedy mesher**, per PLAN.md C3 — not naive-then-rewrite),
  `chunkRenderer.ts` (Three.js geometry per chunk), `world.ts` (client-side decoded chunk store),
  `controls.ts` (pointer lock, WASD, gravity, hand-rolled AABB collision resolved X→Z→Y),
  `raycast.ts` (Amanatides–Woo voxel DDA for block targeting), `net.ts` (schema-validated WS client),
  `main.ts` (orchestration — click sends intent only, **no local write**; world only changes on the
  server's broadcast).

**Deliberate scope cut, made explicitly (not an oversight):** server-side reach-distance validation
was deferred to Phase 2 in this phase. Bounds and known-block-id validation **were** enforced
server-side already. Phase 2 below closes this gap.

### Phase 2 — multiplayer sync
Broadcast join/leave/move, remote players rendered, and the reach-distance check Phase 1 deferred:

- **`shared/src/world.ts`** — added `PLAYER_EYE_HEIGHT` and `REACH_DISTANCE` as shared constants
  (previously each lived as a local duplicate in `client/src/controls.ts` and `client/src/raycast.ts`)
  so the client's raycast reach and the server's new reach-distance check can never drift apart.
- **`server/src/index.ts`** — each `Connection` now tracks `position`/`yaw`/`pitch`/`lastMoveAt`.
  On join: existing players are announced to the new client (`player-join` + `player-state` per
  peer) and the new player is announced to everyone else. `player-move` messages are rate-limited
  (reusing `TokenBucket`), sanity-checked (position within a margin of world bounds; horizontal
  speed within a generous multiple of the client's actual max speed given elapsed time), and
  **dropped silently** (not trusted, not rebroadcast, player **not** kicked) if they fail — a wifi
  hiccup and a speed-hack attempt look identical from the server's side, and this is a creative game
  for children, not a competitive one, so the response to both is "ignore this one packet," never
  "punish the child." `block-update-intent` now also checks the click target is within
  `REACH_DISTANCE` (+ tolerance, since `conn.position` is only as fresh as the last `player-move`
  tick) of the player's tracked eye position. Added an unauthenticated `GET /players` JSON endpoint
  (display names are already visible in-game to every connected player, so this adds no new exposure)
  — the "online players list" PLAN.md flags as near-free plumbing once connections are tracked;
  Phase 5's admin panel will build real UI/auth around it later.
- **`client/src/mesh.worker.ts`** (new) — thin message-passing wrapper around the existing pure
  `meshChunk` function, run in a Web Worker so remeshing never blocks a frame. Typed against a
  narrow local interface cast from `self` rather than pulling in the full `"webworker"` TS lib,
  since this file's tsconfig also compiles main-thread DOM code and the two lib sets disagree on
  `postMessage`'s signature.
- **`client/src/chunkRenderer.ts`** — rewritten to post to that worker instead of calling `meshChunk`
  directly. Each chunk key tracks a `latestVersion`; a worker result for a superseded version (a
  newer edit arrived before the older remesh finished) is discarded rather than applied out of order.
  Transfers a **copy** of the chunk's block data to the worker, not the original buffer — transferring
  detaches the buffer from the sender, and the original is `ClientWorld`'s live collision/raycasting
  data, which must stay intact.
- **`client/src/remotePlayers.ts`** (new) — remote players as a capsule (`THREE.CapsuleGeometry`,
  colour hashed from player id so each is visually distinct) + a canvas-texture name-label sprite.
  Renders on a **~100ms interpolation delay**: each player keeps its two most recent network
  snapshots, and every frame renders the position/yaw interpolated between them at "now minus the
  buffer" (shortest-path angle interpolation for yaw, so a player doesn't visibly spin the long way
  around when crossing the yaw wrap). No client-side prediction — PLAN.md Phase 2 explicitly rejects
  it as solving a fairness problem this game doesn't have.
- **`client/src/net.ts`** / **`client/src/main.ts`** — added `onPlayerJoin`/`onPlayerLeave`/
  `onPlayerState` handlers; `main.ts` sends `player-move` at ~12 Hz (within PLAN's 10–15 Hz target)
  once the initial `world-state` has been received, and calls `remotePlayers.tick()` every frame.

### Phase 3 — chat, with its safety layer (committed, pushed: `4b455ee`)
Free-text chat meeting CLAUDE.md §7 — masking, rate limiting, PII-heuristic flagging, and full
logging, built in from the start rather than bolted on:

- **`server/src/chatFilter.ts`** (new) — pure function `filterChatMessage(rawText)`. Uses
  **`obscenity`** (`RegExpMatcher` + `englishDataset` + `englishRecommendedTransformers`) as the core
  matcher, masking with `asteriskCensorStrategy()`. One deliberate deviation from the library's own
  recommended preset: **`skipNonAlphabeticTransformer()` is added back in**, even though upstream
  disables it by default (their issues #23/#46 — it can over-match across word boundaries). Verified
  empirically before adopting: without it, spaced-out evasion (`"f u c k"`, `"f.u.c.k"`) sailed
  straight through unmasked, which is exactly the evasion PLAN.md named as a reason to pick this
  library over a simpler substring one; with it enabled, that evasion is caught and a battery of
  cross-word-boundary phrases (`"class assignment"`, `"the assassin game"`, `"grass stains"`, `"glass
  door"`, …) still came back clean — this is a mask-don't-block system, so the cost of an occasional
  false positive (a few extra asterisks) is low, while the cost of a false negative (a slur reaching
  a child) is exactly the harm this whole layer exists to prevent. Text is NFKC-normalized and
  control-chars stripped before matching (catches unicode-lookalike evasion like fullwidth `ｆｕｃｋ`
  too) — and it's the *normalized* text that gets broadcast for clean messages too, so nobody sees
  ambient unicode weirdness. A separate, independent set of PII-ish regex heuristics (7+ digit runs,
  "meet me", "your real name", address-ish words) only sets a log flag/reason — they never alter the
  broadcast text, since PLAN.md is explicit these false-positive too easily (e.g. "meet me at spawn")
  to justify blocking. `WHITELIST` is empty for now (no real names exist yet, Phases 1-3 dev-stub
  identity) — PLAN.md flags seeding it with every child's display name and school vocabulary as a
  **critical pre-launch step** before Phase 4 ships real names; the Scunthorpe problem bites hardest
  on exactly names and places.
- **`server/src/db.ts`** — added `chat_log` (raw `message` always preserved, `filtered_message` is
  what was actually broadcast, `flagged`/`flag_reason` for admin review later). Like `block_changes`,
  deliberately omits the `code_hash` FK to `join_codes` — that table doesn't exist until Phase 4.
- **`server/src/rateLimit.ts`** — `TokenBucket` is now constructor-configurable (capacity, refill
  rate) instead of hardcoded, so chat (burst 5, refill 1 per 2s) and block placement (burst 20, refill
  15/s) can have genuinely different budgets from the same class.
- **`server/src/index.ts`** — handles `chat-message`: mute check → rate limit → trim/empty check →
  filter → log to `chat_log` → broadcast to **everyone including the sender** (so they see the same,
  possibly-masked text everyone else does). **No auto-mute on a single flagged message** — only a
  burst of 5+ flags within a 10-minute rolling window earns a 60s cooldown, and even then it's a mute
  (chat rejected with a friendly error), never a kick or a ban. A single flag is very often a false
  positive; repeated flags are a much stronger signal.
- **`client/index.html`** — added `#chat-log` (scrolling message list, bottom-left, `pointer-events:
  none` so it never blocks clicks) and `#chat-input` (hidden until chat is open).
- **`client/src/controls.ts`** — added `setInputEnabled(enabled)`. While chat is open, movement key
  events are ignored entirely (and any currently-held keys are cleared) so typing "wasd" into a chat
  message doesn't also walk the player around.
- **`client/src/main.ts`** — **Enter** opens chat (releases pointer lock, shows/focuses the input,
  disables movement input); **Enter** again sends (if non-empty) and closes; **Escape** cancels
  without sending. Closing either way re-enables movement and re-requests pointer lock. Incoming
  `chat-message` broadcasts append to `#chat-log`, capped at the last 50 lines. Server `error`
  messages (rate limit, chat mute, reach/bounds rejections, …) now also render as a system line in
  the chat log (styled distinctly via `.system`), not just `console.error` — added after the product
  owner's browser pass, see §3.

### Phase 4 — join codes & sessions
Replaces the dev-stub join with real identity, per PLAN.md and the C5 session-takeover resolution:

- **`shared/src/protocol.ts`** — `PROTOCOL_VERSION` bumped 1→2 (contract #8: a breaking shape change).
  The `join` message's `code` is now optional and `name` is gone entirely — a client no longer
  supplies its own display name, ever; it's always resolved server-side from whichever of `code` /
  new `sessionToken` field is present. `world-state` gained a `sessionToken` field: the client stores
  it (e.g. `localStorage`) and sends it back on the next join to resume without re-entering a code.
- **`server/src/auth.ts`** (new) — `hashWithPepper` (HMAC-SHA256; `JOIN_CODE_PEPPER` env var, with an
  insecure dev fallback that prints a loud warning if unset — same pattern as `DATA_DIR`'s dev
  fallback); `generateJoinCode` (6 chars from `23456789BCDFGHJKMNPQRSTVWXYZ` — digits 2-9 plus
  consonants only, excluding `0/O`, `1/I/L`, and all vowels per PLAN.md, so a code is never
  ambiguous-to-type or accidentally spells a word); `generateSessionToken` (256-bit, base64url);
  `SESSION_EXPIRY_MS` (60 days — the middle of PLAN's proposed 30-90 day range, §8 open question #5).
- **`server/src/db.ts`** — added `join_codes` and `sessions` tables (schema per PLAN.md §6, including
  the partial unique index `WHERE revoked = 0` that backs up the one-active-session-per-code invariant
  at the DB level regardless of application logic). `createJoinCode`/`lookupJoinCode`; `createSession`
  (in one transaction: revoke any existing active session for the code as `'superseded'`, **then**
  insert the new one — this is C5's DB-side half) /`lookupSession` (checks `revoked = 0` **and**
  sliding-expiry) /`touchSession`. Plaintext code/token are only ever returned once, at creation.
- **`server/src/createCode.ts`** (new CLI) — `npm run create-code -w server -- "Jack"` prints a
  plaintext code once. Predates the Phase 5 admin panel below, which now does this too, with a UI.
- **`server/src/index.ts`** — `verifyClient` validates the WS upgrade's `Origin` header against an
  allowlist (env-configurable, defaults to the local dev origins) — explicitly framed as
  defense-in-depth, not the primary guard, since the whole reason the session token lives in
  `localStorage` rather than a cookie is to avoid the ambient-auth problem Origin-checking usually
  exists to stop. Join resolves identity via `sessionToken` (touch + reuse) or `code` (rate-limited
  5/15min **per IP**, resume attempts don't count against this budget); every failure path closes the
  socket rather than leaving a half-joined connection around for a retry. Session takeover (C5) at the
  live-connection level: a fresh join for a code that already has a live connection sends that old
  connection a friendly "You joined from another device" error, closes it, and broadcasts its
  `player-leave` to everyone else — **the new join always wins, the incoming connection is never
  rejected**, so a flaky-wifi reconnect can never lock a child out. `connectionsByCodeHash` tracks this
  with a defensive check on cleanup (only clear the map entry if it still points at *this* connection,
  in case a takeover already replaced it before a stale socket's `close` event arrives).
- **`client/index.html`** / **`client/src/main.ts`** — new `#join-screen` overlay (full-viewport,
  blocks canvas interaction while visible, so nothing needs separate gating for "haven't joined yet").
  Boot logic: a stored `sessionToken` attempts a silent resume first; otherwise (or if that resume
  fails — the token is stale/revoked/expired) the join-code form is shown. A failed **fresh code**
  entry re-shows the form with the server's error message and lets the child retry (subject to the
  server's rate limit); a failed **resume** silently drops the stale token and falls back to the code
  form instead of looping forever. On success the token is stored and the join screen hides.
- **`client/src/net.ts`** — `Net`'s constructor now takes a `JoinPayload` (`{ code }` or
  `{ sessionToken }`) instead of a display name; the display name was always dev-stub-only, and now
  there's nothing for the client to supply.

### Phase 5 — admin panel
Code management and moderation without shell access, per PLAN.md — real login, create/list/revoke
codes, live online-players list, chat log review, and the four named moderation actions:

- **`server/src/adminAuth.ts`** (new) — single-admin auth: no user table, since this project has
  exactly one admin role. The password hash lives in `ADMIN_PASSWORD_HASH` (an env var, produced by
  the new `hashAdminPassword.ts` CLI), which sidesteps "how do you create the first admin account"
  entirely — confirmed `argon2` (the native addon, same install pattern as `better-sqlite3`) builds
  and verifies correctly in this environment before committing to it over PLAN.md's alternative
  suggestion of a plain `scrypt` fallback. Sessions are **in-memory only, never persisted to the
  DB** — losing them on a restart just means logging in again, a fine trade for not writing admin
  session material to disk.
- **`server/src/adminApi.ts`** (new) — hand-rolled routing over `/admin/api/*` (no framework; a
  handful of routes doesn't need one). Every route except `/login` and `/session` requires a valid
  session cookie. Login is rate-limited 5/15min per IP (PLAN.md: "an unauthenticated admin panel is
  worse than none"). Takes an `AdminDeps` interface rather than reaching into `index.ts`'s state
  directly, so the routing/HTTP-plumbing logic stays testable independent of the live connection
  maps.
- **`server/src/db.ts`** — added `join_codes.muted` (moderation mute lives on the *code*, not the
  session, so it survives reconnects — not in PLAN.md §6's original sketch, but "mute" is one of the
  four named actions and has to be stored somewhere durable); `listJoinCodes`, `isMuted`,
  `setCodeMuted`; `revokeJoinCode` (disables the code **and** revokes its active session in one
  transaction — the DB-persistence half of "revoking a code both blocks reuse and kills the live
  session"); `getChatLog` (flagged-only / per-player filters); `getRecentBlockChanges` (a player's
  edits in the last N minutes, most-recent-first — feeds rollback).
- **`server/src/index.ts`** — the `AdminDeps` implementation lives here (not in `adminApi.ts`)
  because it needs direct access to the same in-memory `connections`/`connectionsByCodeHash` state
  the WS handlers use. `kickPlayer` sends a friendly notice then closes the socket (code stays
  valid — they can rejoin). `mutePlayerByCode` sets the DB flag and, if the player is currently
  connected, tells them live. `revokeCode` calls the DB revoke, then also kicks any live connection
  for that code (the live-connection half revoke needs, mirroring Phase 4's takeover kick).
  `reissueCode` (added after the product owner noticed there's no way to recover a lost code, since
  plaintext codes are never stored — see below) shares that same revoke-and-kick step via a small
  `revokeCodeAndKick` helper, then creates a fresh code for the same display name in one action.
  `rollbackPlayer` walks a player's `block_changes` rows in reverse-chronological order, calling
  `world.setBlock` with each row's `old_block_id` and broadcasting the restore live — processing
  **every** row in the window (not just the latest per coordinate) is what correctly unwinds a
  sequence of edits back to the state before any of them happened. The chat-message handler now
  checks `db.isMuted` — **after** logging the message (PLAN.md's "done when" is explicit: a muted
  child's messages "stop reaching others but still log," not that they vanish entirely) and before
  broadcasting; the sender is always told, never silently dropped.
- **`server/public/admin.html`** (new) — a single self-contained HTML+CSS+plain-JS page (no build
  step, no TypeScript — deliberately, since this is an internal tool and adding a second bundler
  target for it isn't worth it), served directly by the Node server at `/admin`. Login form; codes
  table with create/mute/unmute/**reissue**/revoke; online-players table with kick, polled every 3s;
  a chat log viewer (flagged-only checkbox, player-name filter, fetches up to 500 rows — matching
  `adminApi.ts`'s own hard ceiling on the `limit` query param — this is a **display** cap only, not
  retention: `chat_log` itself is never pruned, keeping CLAUDE.md §7's "full chat logging for review"
  intact); a rollback form. All state changes go through `fetch()` against `/admin/api/*` with
  `credentials: 'same-origin'`.
- **Why reissue exists:** since join codes are hashed at rest and never stored in recoverable form
  (by design — see Phase 4), there was no way to recover a lost code short of Revoke-then-Create as
  two separate steps. Reissue does both atomically from one button, for the same display name.
- **`server/src/hashAdminPassword.ts`** (new CLI) — `npm run hash-admin-password -w server --
  "<password>"` prints an `ADMIN_PASSWORD_HASH` value to set as an env var. The plaintext password
  is never stored anywhere.

### Phase 6 — deploy, durability, backups (committed, pushed: `a4185cf`)
Hosting: **Railway, confirmed** (product owner's call — see updated CLAUDE.md §9). Everything below
is locally verified against throwaway server instances and throwaway data directories (never the real
dev DB), since actually deploying needs the product owner's Railway account — see the new
[DEPLOY.md](DEPLOY.md) for that part and §6 below.

- **`server/src/index.ts`** — `assertDataDirWritable` runs at boot: writes and deletes a canary file
  in `DATA_DIR`, and calls `process.exit(1)` with a loud error if that fails. PLAN.md's risk table
  calls a silently-unmounted volume "the single most dangerous Railway+SQLite footgun" — refusing to
  start with no world is far better than starting and quietly not persisting one. Verified against a
  chmod'd-read-only directory: fails loudly, does not start. Added `GET /health` (checks real DB
  connectivity via `db.healthCheck()`, not just that the HTTP server accepts sockets — feeds a host's
  restart-on-failure policy). `httpServer.listen` now binds `0.0.0.0` explicitly rather than relying
  on the default. A `setInterval` triggers `db.backup()` every 6h.
- **Found and fixed a real gap while wiring this up: there was no working production run path at
  all.** `tsc -b` is configured `emitDeclarationOnly: true` (types only, project-reference support for
  `npm run typecheck` — never emitted real `.js`), so `server`'s old `"start": "node dist/index.js"`
  pointed at a `dist/index.js` that was never actually produced by anything. Fixed by having
  production run the server the same way dev does — directly off TypeScript source via `tsx` — rather
  than standing up a second, separate build pipeline just for this; `tsx` moved from `devDependencies`
  to `dependencies` since it's now needed at runtime. Separately, there was no mechanism for the
  client to be reachable in production at all: Vite's dev server (which serves it locally) doesn't
  run in prod. Added `serveClientStatic` in `index.ts`, which serves `client/dist` (the `vite build`
  output) when present, falling back to `index.html` for any unmatched path (no client-side routing to
  worry about) — and does nothing (returns false) when no build exists, which is the normal dev case,
  so this doesn't change dev behavior at all. This realizes PLAN.md Phase 0's stated intent — "one
  same-origin path works in dev and prod" — which had never actually been wired up for prod. Verified
  the *entire* flow end-to-end against a throwaway build + throwaway server instance: `vite build` →
  production-mode server serves the built client, `GET /health` responds, a real WebSocket join +
  chat round-trip both work, all from one process on one port.
- **`server/src/db.ts`** — replaced the ad hoc, unconditional `ensureColumn` call Phase 5 shipped
  with a real migration runner on `PRAGMA user_version`: a `migrations` array of `{ version, apply }`
  entries, applied in order past the DB's current `user_version`, which is then bumped so a migration
  never reruns. Verified idempotent (opening the same DB twice doesn't reapply or error) and correct
  against both a fresh DB and an older one missing a column. `backup(dir)` uses `VACUUM INTO` (never
  a raw file copy, which under WAL can miss the `-wal` sidecar and produce an inconsistent snapshot)
  to write a timestamped snapshot; verified it succeeds even with the live server holding the same DB
  file open concurrently, and rehearsed a full restore — opened the backup file standalone, confirmed
  the data matched and `healthCheck()` passed. `healthCheck()` is a trivial `SELECT 1`, feeding
  `GET /health`.
- **`railway.json`** (new) — Nixpacks build (`npm install && npm run build`), start command
  (`npm start`), health check path/timeout, `restartPolicyType: ALWAYS`. Unverified against a real
  Railway account — the schema is per Railway's public docs, not something this session could test.
- **`package.json` / `client`** — added root `build` (delegates to `client`'s `vite build`) and
  `start` (delegates to `server`'s `tsx`-based start) scripts, so Railway's default
  `npm install && npm run build` / `npm start` flow works without needing custom commands configured
  in the dashboard (though `railway.json` sets them explicitly anyway, as a config-as-code belt to
  the dashboard's suspenders).
- **`CLAUDE.md`** — filled in §8's commands (previously a placeholder since scaffolding), confirmed
  the Railway hosting decision and the one-session-per-code decision in §9, per this file's own
  instruction to fold decisions back in as they're made.
- **`DEPLOY.md`** (new) — durable (not point-in-time, unlike this file) step-by-step: Railway account
  setup, volume mount, required env vars (`DATA_DIR`, `JOIN_CODE_PEPPER`, `ADMIN_PASSWORD_HASH`,
  `ALLOWED_ORIGIN`), a post-deploy verification checklist matching PLAN.md's actual Phase 6 "done
  when" criteria (redeploy-preserves-data canary check, WSS through Railway's proxy, mid-session kill
  losing nothing), and the current state of backups/known gaps.

**Deliberately not done — needs the product owner directly, see §6 and DEPLOY.md:** the actual
Railway deployment (account/project/volume/env vars all need the product owner's Railway access, not
something this session can do); shipping backups off-box to R2/S3 (needs cloud storage credentials);
the dirty-chunk-flush + crash-recovery-replay optimization (PLAN.md C6) — **the product owner
confirmed skipping this**, matching the recommendation above (write-through is already durable, and
this project's scale doesn't need the optimization it trades away simplicity for).

### Self-hosting pivot (**uncommitted**, on top of Phase 6)
After Phase 6 shipped, the product owner asked how much work it'd be to self-host instead of deploying
to Railway — "joinable only when the owner is playing" — with the explicit intent to switch to Railway
later once the game is more mature. Answer, confirmed by how little changed: almost none, because the
Phase 6 production path (single process, single port, server serves the built client itself) already
*is* the right shape for self-hosting — the only gap was that `ALLOWED_ORIGIN` only accepted one value.

**Revised after the first pass**: the initial version of this documented same-WiFi (LAN) hosting as
the default, with a public tunnel as an optional "beyond your own WiFi" extra. The product owner asked
for the opposite — LAN removed entirely, tunnel-based public-URL exposure as *the* documented path —
since that's what's actually wanted (kids joining aren't necessarily on the same network).
`SELF_HOSTING.md` was rewritten around Cloudflare Tunnel (`cloudflared`) as the primary flow.

This was **rehearsed for real**, not just documented from knowledge: downloaded the actual
`cloudflared` binary, ran a real quick tunnel against a throwaway local server instance, and confirmed
over the genuine public `https://*.trycloudflare.com` URL — not a simulated one — that a WSS
connection opens, `join` succeeds, and a chat message round-trips, all through the tunnel. This also
caught a real mistake worth flagging: the first attempt to create a test join code for this rehearsal
omitted `DATA_DIR`, so `createCode.ts` fell back to its default path and wrote a `TunnelTestKid` row
into the **product owner's actual dev database** instead of the throwaway one. Caught immediately by
checking the database directly, deleted the one stray row precisely by its `code_hash` (confirmed the
three pre-existing real codes — `TestKid1`, `TestKid2`, and `Eddie`, the last of which the product
owner created themselves at some point outside this session — were untouched before and after), then
re-ran the rehearsal correctly against the throwaway `DATA_DIR`. Noting this here in the interest of
the same transparency this file has applied to test mistakes throughout the session (e.g. the Phase 2
"unrealistic teleport test" and Phase 3 "rate-limit test didn't account for prior consumption" notes).

- **`server/src/index.ts`** — `ALLOWED_ORIGIN` now accepts a comma-separated list. Verified with a
  real (non-`ws`-library, actual `Origin`-header-setting) WebSocket client against all three cases:
  a `localhost` origin in the list connects, a second (non-localhost) origin in the list connects, and
  an origin not in the list is rejected with 403 — proving the allowlist logic (already correct from
  Phase 4) generalizes to multiple values correctly, not just that it compiles.
- **`SELF_HOSTING.md`** (rewritten) — the current primary how-to, tunnel-only: install `cloudflared`;
  start the tunnel first (`cloudflared tunnel --url http://localhost:8787`) to get the public URL,
  *then* start the server with `ALLOWED_ORIGIN` set to that URL (order matters — env vars are fixed
  at process launch); still set real `JOIN_CODE_PEPPER`/`ADMIN_PASSWORD_HASH` (self-hosting doesn't
  relax those); a note on getting a stable URL (a named tunnel + a domain) instead of a fresh random
  one every session.
- **`DEPLOY.md`** — status line updated to "paused," pointing at SELF_HOSTING.md, explicit that
  nothing in it needs to change and nothing about self-hosting needs undoing to pick it back up later.
- **`CLAUDE.md`** — this is the second time hosting has changed since the file's original "final pick
  pending" state, so updated more thoroughly than a one-line decision flip: §1's vision and design
  principle #3, §2's "Admin-independent" bullet, §3's stack table + hosting-decision prose, and §9's
  decision list all now distinguish the *long-term* always-on goal from the *current* self-hosted
  choice, rather than overwriting one with the other — the top-of-file Status line (stale since
  before Phase 0, still saying "Greenfield / pre-code") was also fixed while touching this file.

---

## 3. Browser verification

### Phase 1 — done
No browser automation tool was available in the session that originally wrote Phase 1, so the first
pass was automated-only (§4). The product owner then ran `npm run dev` and tested it directly:
pointer-lock mouse-look, WASD movement, jump/gravity, left-click break / right-click place, walking
into a placed block, and the server-authority/persistence behavior. Verdict: confirmed working and
feels good, after fixing two real bugs the manual pass caught that the automated checks couldn't:

- **A/D were swapped.** The `right` movement vector in `client/src/controls.ts` had the wrong sign
  (`(forward.z, 0, -forward.x)` instead of the correct `cross(forward, up)` = `(-forward.z, 0,
  forward.x)`) — a transcription error between the derivation and the code. Fixed and re-verified
  numerically at four different yaw angles, not just the one that was visibly broken.
- **Mouse look sensitivity was tuned up** through a few iterations to `0.01` (from an initial
  `0.0022`), per direct feedback during testing. It's the `sensitivity` constant at the top of
  `onMouseMove` in `client/src/controls.ts` if it ever needs revisiting again.

A four-tower landmark set (colored 3×3 pillars, one per cardinal direction, ~10 blocks from spawn —
see `testLandmarks()` in `server/src/world.ts`) was added specifically to make motion and rotation
visually legible against the flat green-floor/blue-sky world; it's a testing aid, not phase content.
Kept as-is in the Phase 1 commit (product owner's call) — still useful in Phase 2 as a shared visual
reference point for multiple players in the same spot.

### Phase 2 — done
No browser automation tool was available in this session either, so as with Phase 1 the first pass
was automated-only (§4). The product owner then tested it directly with two browser tabs per the
checklist this file suggested (remote-player capsule + name label rendering, interpolated motion,
turning, block break/place syncing across tabs, reach-distance feel, prompt avatar removal on
disconnect, no hitching from the Web Worker meshing). Verdict: confirmed working, no bugs reported
this round.

### Phase 3 — done
No browser automation tool was available in this session either, so as with Phases 1-2 the first pass
was automated-only (§4). The product owner then tested it directly in two tabs — chat opening/typing/
sending/canceling, masking, movement not leaking through while typing — and confirmed it all works.

One real finding, not a bug but a UX gap: rapid-fire messaging through the UI never visibly triggered
the rate limiter. This *is* expected — burst 5 / refill 1-per-2s (PLAN.md's exact numbers) is tuned to
stop a scripted spam client, not a human who has to re-press Enter and type for every message, and the
server-side limiter was already proven correct at exactly those numbers by the Phase 3 scripted test
(§4: a fresh connection's burst of 10 delivered exactly 5). But it surfaced a real gap: when the
limiter (or the flag-escalation mute) *did* reject something, nothing appeared in the chat UI —
only `console.error`. That's the silent-failure default CLAUDE.md §7 explicitly calls out as wrong
for this audience. Fixed: server `error` messages now also render as a `⚠`-prefixed system line in
the chat log (`main.ts`'s `appendSystemMessage`, styled via `.system` in `index.html`) — covers rate
limit, chat mute, and the existing reach/bounds rejections for block placement too, all from the one
already-generic `error` message type.

### Phase 4 — done
No browser automation tool was available in this session either. Server-side identity resolution,
takeover, rate limiting, and DB persistence were scripted-E2E-verified first (§4); the product owner
then tested the join screen itself directly (invalid code, valid code, reload-to-resume, second-tab
takeover) and confirmed it all works.

### Phase 5 — committed on the product owner's go-ahead
No browser automation tool was available in this session. Every admin action was verified end-to-end
via `fetch`/`WebSocket` against **throwaway server instances** on separate ports with temporary
`DATA_DIR`s (§4) — specifically so the product owner's actual running dev server, with its real test
data, was never touched by this testing. The product owner reviewed the work and directed moving on
to Phase 6 without walking the manual checklist step-by-step in this session — unlike Phases 1-4, this
one does **not** carry an explicit "tried it in a browser, works" confirmation. If anything about the
admin page itself (as opposed to the actions it drives, which are scripted-verified) turns out to be
off, that's the first place to look.

The checklist below is preserved for whenever that manual pass does happen. To try it, the
*currently-running* `npm run dev` doesn't have `ADMIN_PASSWORD_HASH` set (env vars are fixed at
process launch), so either stop it and restart with the var set, or run a second instance on a spare
port:

```sh
npm run hash-admin-password -w server -- "<pick a password>"
# copy the printed ADMIN_PASSWORD_HASH= line, then:
ADMIN_PASSWORD_HASH='<paste the hash>' npm run dev
```

Then visit **http://localhost:5173/../admin** — i.e. **http://localhost:8787/admin** directly (the
admin page is served by the game server, not through Vite's dev proxy, so it's on port 8787 not 5173).
Suggested checklist:
- Log in with the wrong password (see an error), then the right one (see the dashboard).
- Create a code for a test name; the plaintext code banner appears once. Join in a separate browser
  tab with that code (see the join-code screen from Phase 4) and confirm the player appears in the
  admin page's "Online now" list within ~3s (it polls).
- Mute that player from the admin page; in their game tab, try sending a chat message and confirm they
  see a "muted" notice in their chat log rather than the message just vanishing. Unmute and confirm
  chat works again.
- Kick that player; confirm their game tab disconnects within a couple seconds.
- Have them rejoin (code still valid after a kick), place a couple of blocks, then use the rollback
  form for their name over a few minutes; confirm the blocks disappear live in their game tab.
- Click **Reissue** for that player instead of Revoke: confirm a new-code banner appears, their game
  tab disconnects, the old code no longer works, and the new code joins them back in under the same
  display name.
- Revoke a (different) code; confirm the game tab disconnects **and** that code can no longer be used
  to join at all (not even a fresh connection).
- Check the chat log viewer renders sensibly with the flagged-only filter and a player-name filter.

---

## 4. Automated verification (before the browser pass)

Everything short of "does it look/feel right" was checked before any manual testing happened:

- `tsc -b` clean across all packages.
- **Mesher correctness**, checked numerically against synthetic chunks (not just read): an isolated
  voxel produces exactly a 6-quad cube at the right coordinates; a flat 16×16 floor collapses to
  **6 merged quads** (proving the greedy-merge actually collapses large flat regions, the whole point
  of C3); triangle winding matches vertex normals on every face across three shapes including an
  irregular staircase.
- **Full server authority/persistence loop**, scripted end-to-end via a throwaway Node script (not
  checked in): join → world-state (25 chunks, correct spawn) → place a block → broadcast has correct
  fields → out-of-bounds and unknown-block-id intents rejected → burst of 30 placements trips the
  rate limiter → `block_changes` row has correct who/what/when/before/after → **server killed,
  restarted, reconnected, edit still there.**
- Fetched every client module through Vite's live dev server to confirm the whole import graph
  (including `@game/shared` and `three`) resolves and transforms without error.

None of this used a real GPU/display — that gap was closed by §3's Phase 1 manual pass.

**Phase 2 additions** (also via a throwaway Node script using `ws`, not checked in):
- Two simulated clients join in sequence; the second correctly receives `player-join` + `player-state`
  for the first (already-connected) player, and the first receives `player-join` for the second as it
  connects.
- A realistic `player-move` (sent after a real elapsed delay, matching how the client actually paces
  updates) is correctly rebroadcast to the other client as `player-state`.
- An unrealistic instant large-displacement "teleport" sent with ~0 elapsed time is **correctly
  dropped** — no `player-state` reaches the other client for it. (This also caught a flaw in the test
  itself, not the server: an initial version of the test sent a 2m jump immediately after join with
  no elapsed time and got correctly rejected by the same speed clamp — the test was unrealistic, not
  the server buggy; fixed by adding a realistic delay before that assertion.)
- `block-update-intent` **beyond `REACH_DISTANCE`** (but still safely inside world bounds, to isolate
  the reach check from the pre-existing bounds check) is rejected with `"block out of reach"`; the
  same intent aimed at a nearby block succeeds and broadcasts normally.
- Closing a socket correctly broadcasts `player-leave` to the remaining client.
- `GET /players` returns the expected JSON.
- Confirmed via Vite's live dev server (module fetch **and** the transformed output) that
  `new Worker(new URL('./mesh.worker.ts', import.meta.url), { type: 'module' })` in
  `chunkRenderer.ts` is correctly recognized and rewritten by Vite's worker plugin
  (`?worker_file&type=module`), and that `mesh.worker.ts` and `remotePlayers.ts` resolve cleanly.
- `tsc -b` clean across all packages, including `mesh.worker.ts`'s cast-based typing approach.

**Phase 3 additions:**
- `chatFilter.ts` exercised standalone (not checked in) against a battery of inputs before it was
  ever wired into the server: clean messages pass through unflagged; profanity gets masked and
  flagged; spaced-out (`"f u c k"`), punctuated (`"f.u.c.k"`), and fullwidth-unicode (`"ｆｕｃｋ"`)
  evasion are all caught (this is what led to adding `skipNonAlphabeticTransformer()` — the first
  pass without it let spaced-out evasion straight through); a battery of legitimate phrases sharing
  substrings with blacklisted words across word boundaries stayed clean; all four PII heuristics
  (digit run, "meet me", "your real name", address-ish) fire correctly and independently of the
  profanity check.
- Full chat flow scripted end-to-end via `ws` (not checked in): a clean message broadcasts to
  **everyone including the sender**; a profane message arrives masked at every client; a
  whitespace-only message is silently dropped (and correctly still consumes a rate-limit token,
  which the test initially got wrong before isolating it on a fresh connection — same "test was
  unrealistic, not the server" pattern as Phase 2's teleport check); a burst of 10 messages on a
  **fresh** connection delivers exactly 5 (the configured burst capacity) before the rate limiter
  kicks in with a "slow down" error; 5 flagged messages in a row correctly trigger a mute, and the
  6th message is rejected with a "muted" error rather than delivered.
- Queried `data/world.db` directly after the above: `chat_log` rows have the **raw, unmasked**
  `message` preserved alongside the `filtered_message` that was actually broadcast, correct
  `flagged`/`flag_reason`, and the muted 6th message (never delivered) correctly does **not** appear
  as a row — only messages that were actually sent get logged.
- `tsc -b` clean across all packages.

**Phase 4 additions** (scripted via `ws`, not checked in, using two real codes issued through the new
`npm run create-code` CLI):
- Fresh join with a valid code succeeds and returns a `sessionToken`; an invalid code is rejected and
  the socket closes; joining with neither `code` nor `sessionToken` is rejected with a clear message;
  a stale protocol version is rejected with the existing "please refresh" message.
- Resuming via the returned `sessionToken` (no code) succeeds, returns the display name, and reuses
  the **same** token rather than issuing a new one.
- **Takeover**: joining again with the same code from a second connection succeeds with a **different**
  token, and the connection that had been using the previous token receives a "You joined from another
  device" error and its socket closes. Re-attempting to resume with that now-superseded token
  correctly fails ("session expired") rather than silently succeeding.
- A **third, unrelated** connection (joined with a completely different code) correctly receives the
  `player-leave` broadcast for the superseded connection's id — takeover visibility isn't limited to
  the two directly-involved connections.
- Code-entry rate limiting: hammering invalid codes from one IP is capped at exactly 5 before "Too
  many attempts" kicks in (verified fresh after restarting the dev server to reset in-memory state,
  since the limiter's Map persists across separate test-script runs within the same server process —
  confirmed the *cumulative, per-IP, cross-code* counting is correct, not per-code).
- Queried `data/world.db` directly: `join_codes.code_hash` and `sessions.token_hash` are HMAC digests,
  never plaintext; exactly one `sessions` row per `code_hash` has `revoked = 0` at any time, with
  superseded rows correctly marked `revoke_reason = 'superseded'`.
- `tsc -b` clean across all packages (surfaced, and fixed, an unrelated pre-existing pattern: TS's
  narrowing of a `document.getElementById(...)` null-check doesn't reliably persist into closures
  defined later in the same file for `statusEl`/`chatLogEl`/`chatInputEl`/the new join-screen
  elements — worked around throughout `main.ts` by rebinding to a definitely-non-null `const` right
  after each guard, the standard idiom for this TS limitation).

**Phase 5 additions** (via `fetch`/`WebSocket` against a throwaway server instance on a separate port
with a temporary `DATA_DIR` — never the product owner's real running dev server or its data):
- Auth: unauthenticated requests to any protected route get `401`; a wrong password gets `401` and no
  cookie; the right password sets a session cookie and `/session` reports `authenticated: true`;
  `/logout` invalidates the session immediately (a subsequent request is `401` again); hammering
  `/login` with wrong passwords trips the same 5/15min-per-IP rate limiter Phase 4's code-entry uses.
- Full moderation loop against a **real WebSocket connection**, not just direct DB calls: create a
  code via the admin API → join with it (real client join, not a DB shortcut) → confirm the player
  shows up in `/admin/api/players` → **mute** → confirm the muted player is notified live *and* that
  their next chat attempt is rejected (told, not silently dropped) *and* still lands in `chat_log` per
  PLAN's exact "done when" wording → **unmute** → confirm chat works again → **kick** → confirm the
  socket actually closes → rejoin (code still valid) → place a block → **rollback** → confirm the
  block is restored **and** the restore is broadcast live to the still-connected player → **revoke** →
  confirm the live connection is disconnected *and* the same code can no longer be used to join at all.
- Confirmed the admin HTML page itself is served correctly at `GET /admin` (200, real HTML content).
- `tsc -b` clean across all packages.

**Still not covered by anything automated:** actual rendering correctness (§3 Phase 2), the chat UI's
interactive behavior (§3 Phase 3), the join screen (§3 Phase 4), and the admin page's actual UI
(§3 Phase 5) — every admin *action* above was driven directly, not by clicking through the real page.

---

## 5. Live self-hosting session — bugs found, setup friction, housekeeping

The product owner actually stood up self-hosting for real after Phase 6/the pivot: installed
`cloudflared`, ran a real quick tunnel, and worked through getting `npm start` configured correctly.
This surfaced real issues no amount of this session's own scripted testing would have caught, since
none of it involves a human typing shell commands from documentation for the first time.

### Bugs found during live usage

- **Fixed, committed (`0692b21`): join form gets stuck disabled with no explanation on a
  transport-level connection failure.** Reported as "nothing happens after I click Join." Root cause:
  `net.ts` never listened for the WebSocket's native `error` event, and `main.ts`'s `onClose` handler
  did nothing when the connection closed before a successful join — it only handled failures the
  server explicitly reported via a JSON error message. If the socket fails at the transport level
  instead (server not running, tunnel down, a network hiccup mid-handshake), `close` fires with no
  prior server message, and the join button/input were left disabled with zero feedback. Fixed by
  having `onClose` reset the form with a generic "Could not connect" message — but **only** when a
  server-sent error hasn't already explained and reset it moments earlier (a `failureHandled` flag),
  since the server always closes the socket shortly after sending a real error like "Invalid code,"
  and without that guard the specific message would get overwritten by the generic one. Verified by
  full code-path tracing (all four scenarios: successful join, server-rejected join, transport
  failure, and mid-game disconnect) — **not** verified in an actual browser, since no browser
  automation was available this session; the product owner's report that they could then join
  successfully is the only real-world confirmation this has had.
- **Reported, investigated, not conclusively root-caused: a "pure blue world, no blocks visible" on
  first login, resolved by closing and reopening in a new tab.** Investigated via full code review of
  the chunk-loading/meshing pipeline (`main.ts`'s `onWorldState`, `chunkRenderer.ts`'s Web Worker
  dispatch, `mesh.worker.ts`) — found nothing definitively wrong there, but did notice the first
  login goes through the **fresh join-code path** while reopening goes through the **stored-session-
  token resume path**, which pointed toward the connection-close bug above as a plausible (unconfirmed)
  explanation: a failed reconnect during heavy debugging/restarting could plausibly have looked like
  "the game loaded but nothing rendered" from the outside. The product owner later reported no longer
  seeing this, without confirming which hypothesis (if either) was actually the cause — **flagging
  this as unresolved, not closing it out**, since "stopped reproducing" isn't the same as "explained."
  If it recurs, the diagnostic steps to ask for are: browser DevTools console errors at the time, and
  whether an in-tab reload (not a new tab) also fixes it.

### Real setup friction (now reflected in SELF_HOSTING.md, or just worth knowing about)

- **Shell quoting**: argon2 hashes (`ADMIN_PASSWORD_HASH`) are full of literal `$` characters
  (`$argon2id$v=19$...`). Set unquoted or double-quoted, the shell tries to expand each `$...` as a
  variable, silently mangling the value (or producing a confusing "command not found" error from the
  mangled leftovers). Must be single-quoted. This bit the product owner in practice; worth remembering
  if guiding anyone else through this.
- **`export` in the wrong terminal tab**: env vars set via `export` only apply to that shell session
  and its children — a common mistake is exporting in one terminal tab/window and running `npm start`
  in a different one, where the exports never happened. The most bulletproof pattern is inlining all
  three vars directly before `npm start` on one line, which sidesteps session-scoping entirely (this
  is what SELF_HOSTING.md now shows).
- **Admin login rate limiting during setup debugging**: 5 attempts/15min per IP is easy to burn
  through while debugging *why* a password isn't working (see shell-quoting above) rather than actual
  brute-forcing. The limiter is in-memory, so restarting the server clears it instantly — no code
  change needed, just worth knowing the reset mechanism when it happens.
- **Quick tunnel URLs are single-use per `cloudflared` process**: restarting the tunnel assigns a
  *new* random URL. Easy to end up debugging "why won't it connect" when the real issue is a stale
  URL from a previous tunnel run. Worth checking early when something that worked stops working.

### Other housekeeping (not blocking, flagged not fixed)

- **`school map.png` and `.DS_Store`** are still present in git history from before this session
  (an earlier commit added them before PLAN.md's decision D3 said to keep the map out of git). The
  map was `git rm --cached` in the Phase-0 commit, so it's gone from the current tree, but it's still
  recoverable from history. Scrubbing it fully needs a history rewrite + force-push — not done, since
  that's disruptive to a shared remote and wasn't asked for.
- **`allow-scripts` warnings** on `npm install` (esbuild, fsevents, better-sqlite3 postinstall
  scripts) are advisory-only in this environment — verified the actual native binaries build and load
  correctly (`better-sqlite3` opens/queries fine, `esbuild`/Vite run fine). Don't spend time chasing
  these unless something actually breaks.
- **`lin_notes.md`** exists in the repo root — the product owner's own working notes, appears to
  include at least one real join code. Added to `.gitignore` this session (it wasn't before) so it
  can't get swept into a commit by an unrelated `git add -A`-style mistake. Its contents are still
  left alone deliberately; not something to ever read/stage/commit beyond that gitignore entry
  without being asked.

---

## 6. Next up

Hosting mode is **self-hosted, deliberately**, and **confirmed working end-to-end by the product
owner themselves** — real `cloudflared` tunnel, real browser, real successful join, not just this
session's scripted rehearsal. The dirty-chunk-flush optimization (PLAN.md C6) is being **skipped**
deliberately too (pure write-through already makes every change durable immediately, satisfying
Phase 6's actual correctness "done when" criterion, and this project's ≤5-player scale is unlikely to
need the write-amplification optimization that buffer would trade simplicity away for).

**Watch for recurrence of the unresolved "blank blue world" bug** (§5) — it stopped reproducing but
was never conclusively root-caused. If it comes back, get browser console errors and whether an
in-tab reload (not a new tab) also fixes it; that'll narrow it down fast.

Two things worth doing before real kids ever get a code:
- **Seed `chatFilter.ts`'s `WHITELIST`** with real children's names and school-specific vocabulary
  once real codes exist — it's still empty; PLAN.md flags this as a critical pre-launch step.
- **Confirm `JOIN_CODE_PEPPER` and `ADMIN_PASSWORD_HASH` are real, distinct secrets** (not left over
  from any of this session's testing/debugging) before any child actually gets a code — every
  environment falls back to a hardcoded insecure pepper if unset, and the admin panel is simply
  unreachable without the password hash set.

Also still open from Phase 5: the admin **page** itself (as opposed to the actions it drives, which
are scripted-verified) hasn't had an explicit manual-browser confirmation — §3's checklist is there
whenever that happens.

Whenever always-on hosting is wanted again: [DEPLOY.md](DEPLOY.md) is complete and ready, and its own
post-deploy checklist is where PLAN.md's Railway-specific "done when" criteria (redeploy-preserves-
data canary, WSS through Railway's proxy) would finally get checked for the first time against a real
deployment — nothing currently verifies those specifically, since self-hosting doesn't need Railway's
redeploy/proxy behavior at all.
