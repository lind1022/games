# HANDOFF.md

Snapshot of where this project actually stands, for whoever (or whichever session) picks it up
next. This is a point-in-time status doc, not a spec — [CLAUDE.md](CLAUDE.md) is the durable spec,
[PLAN.md](PLAN.md) is the phased build plan. This file goes stale; trust `git log` and the code over
it if they disagree.

**As of 2026-08-19:** Phases 0-7 are committed, plus one Phase 8 task (`447d25e`, `66b689f`, `98a9cb6`,
`4b455ee`, `f3e4edc`, `c6449b0`, `a4185cf`, `19eaa72`, `6b08610`). **Phase 7 is the headline change**:
the flat 5x5 test world is gone — the server now loads and spawns into the real, imported Pinehurst
campus (`19eaa72`; see its own section under §2 and the commit message for the full engineering story).
**Real block textures landed right after** (`6b08610`, also under §2) — flat vertex colors are gone,
replaced by a `DataArrayTexture` built from a texture sheet the product owner supplied. Both confirmed
working by the product owner directly in a browser, not just this session's own scripted verification —
this session has no WebGL rendering capability of its own to check either with.

**Since then: the rest of Phase 8 is built but UNCOMMITTED, and there's an active, unresolved bug —
read this before anything else.** `git status` shows real, working-tree-only changes across 9 files
(`client/index.html`, `client/src/blockMaterial.ts`, `client/src/chunkRenderer.ts`,
`client/src/controls.ts`, `client/src/hotbar.ts` (new), `client/src/main.ts`, `client/src/mesh.ts`,
`client/src/mesh.worker.ts`, `shared/src/blocks.ts`) — nothing here has a commit hash yet. Full detail
is in §2's new "Phase 8 (continued, UNCOMMITTED)" section, but the two things that matter most:

1. **The "pure blue world" bug (§5's original unresolved report) recurred live in this session**, and
   is still not conclusively root-caused. Two real, previously-100%-silent failure-visibility gaps were
   found and fixed (a worker with no error handler at all; a render loop a single throw could
   permanently freeze) — both genuine improvements, neither confirmed as *the* cause. The product owner
   is now specifically reproducing it in **Safari**, which is a real new lead this session couldn't
   pursue further itself (no browser access) — the recent shader work uses WebGL2 features (GLSL3
   `RawShaderMaterial`, `DataArrayTexture`) Safari has historically supported less reliably than
   Chrome/Firefox. **Get the Safari console output before doing anything else with this codebase.**
2. **None of Phase 8's remaining work has an explicit "confirmed working in a browser" sign-off yet**
   except the transparency pass (water visibility + glass, before glass was reverted to opaque) and the
   texture-atlas work from `6b08610`. The hotbar and the UV-orientation fix (§2) were built and verified
   only by direct code-level testing (numerically checked outside the browser) — not yet seen on screen
   by anyone.

Phase 5 (admin panel, plus a Reissue action and a raised chat-log display cap added after initial
review) was originally scripted-end-to-end-tested against throwaway server instances only, and
committed on the product owner's go-ahead to move on without the explicit manual-browser-pass
confirmation Phases 1-4 carry — **that gap is now closed too** (see §3): the product owner walked the
full checklist against another throwaway instance and confirmed everything works, no issues found.

Two more things landed since: `chatFilter.ts`'s `WHITELIST` is seeded with real names/school
vocabulary and `JOIN_CODE_PEPPER`/`ADMIN_PASSWORD_HASH` were verified as real, never-leaked secrets
(`462a5a0`, `992c56c` — see §6 for detail); and a real bug in the chat filter itself was found and
fixed (`2988df0`): the Phase 3 `skipNonAlphabeticTransformer()` addition, adopted to catch spaced-out
evasion like "f u c k", turned out to silently defeat detection of ~20 core blacklisted words
(including "shit", "cunt", "rape", "cock", "fag", "whore", "sex") whenever they appeared mid-sentence
rather than at the very start/end of a message — the common case in real chat. Fixed by running two
matchers in parallel instead of one and unioning their matches, so neither property is traded away.

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

### Phase 7 — school map importer (committed: `19eaa72`)
Replaces the flat 5x5 test world with the real Pinehurst campus, per PLAN.md's build order and D4-D6
(§8, confirmed 2026-08-17 — see `8b4eda6`). Full engineering story, including every real bug found and
fixed along the way (pond/grey hue confusion, a wrong outline color assumed from the wrong histogram
entry, overlay arrows/text erasing real walls in the flattened PNG, the tennis facility's own red
border almost becoming a false building), is in the `19eaa72` commit message rather than duplicated
here — read that first if picking this back up.

Headline results:
- `/tools` (separate package, `sharp` kept out of the server's dependency graph) now has a working
  classify → downsample → extrude → diff-PNG → (optional `--write`) pipeline.
- **3.23% of blocks are unclassified** (flagged magenta in the diff-PNG), concentrated in one known,
  deliberately-accepted gap in the GYM/Library complex (closing it via more aggressive gap-dilation was
  confirmed to falsely enclose Field 1 and the tennis courts instead — see the commit message's
  `DILATE_ITERATIONS` reasoning) plus scattered tree/hatching residue elsewhere.
- Two new core block types: `LEAVES`, `COURT` (append-only per contract #1) — plus client vertex colors
  for both and for `WATER`, which the importer is what first makes appear in-world at all.
- `server/src/world.ts` `WORLD_CHUNKS` (5 → 23) and `index.ts` `SPAWN` (was `WORLD_SIZE/2`, now the
  importer's own computed open-ground point, `(181, 98)`) are wired to actually load and spawn into the
  real world — the real site is a rectangle placed at the (0,0) chunk corner of a 23x23 square (contract
  #4 needs one scalar `worldSize`), padded with flat grass, no format change needed.
- **Verified two ways**, never against the real dev DB: a scripted WS join + `world-state` round-trip
  against a throwaway `DATA_DIR` confirmed all 529 written chunks arrive and decode to a real mix of
  grass/brick/stone/path/water/court block ids (not just flat grass); the product owner then walked the
  real world in a browser (aided by a temporary, since-fully-reverted fly-mode addition to
  `client/src/controls.ts` for an aerial check — confirmed clean via `git diff` showing zero changes
  after reverting) and confirmed the layout looks right.
- The `import-config.json` palette/seed/blocker config and every fix are all real, committed source —
  nothing here was thrown away the way this session's many one-off pixel-sampling/debug scripts were
  (only `tools/src/sampleColors.ts` was kept, as a genuinely reusable calibration aid for if the map
  changes).

Not done in Phase 7, deliberately out of scope: closing the GYM/Library gap further (see above); tree
placement or hatching-specific cleanup (PLAN.md's own task list frames both as noise to wash out via
downsampling, not features to place — and majority-vote downsampling does that on its own); re-running
against production data (never attempted — this was built and verified entirely against throwaway
instances).

### Phase 8 (partial) — real block textures (committed: `6b08610`)
Only the texture-atlas task from Phase 8's list, not the rest of the phase (§6 covers what's still
open). The product owner supplied a stock pixel-art texture sheet and delegated tile-to-material
choices ("use your own judgement"); `tools/src/buildTextureArray.ts` crops the 10 tiles this project's
block types need into `client/public/textures/blocks.png`.

Resolves PLAN.md's own flagged §5 spike question (padded atlas vs `DataArrayTexture`) in favor of the
latter, for a real reason rather than convenience: greedy-merged quads (PLAN.md C3) need their texture
to *tile* across the merged span, not stretch one copy across it, and a shared atlas tiled via UV
repeat would sample past a tile's edges into whatever neighbors it at the atlas level — exactly the
bleeding problem padding/inset exists to paper over. An array texture sidesteps it instead: each layer
is independent, so repeating within one can never reach a different block's tile.

Real engineering, not just an image drop-in — full detail in the `6b08610` commit message: `mesh.ts`
now emits per-vertex UVs spanning `[0,w]x[0,h]` (block units) instead of flat colors, tiled via
`fract()`; `blockMaterial.ts` (new) is a hand-rolled `RawShaderMaterial` (GLSL3, `sampler2DArray`) since
nothing built into three.js samples an array texture through the standard material pipeline, with
lighting constants shared with main.ts's actual scene lights so they can't drift apart; `vite.config.ts`
needed its build target bumped to es2022 for the top-level `await` loading the texture before first
render. `client/src/colors.ts` is gone, replaced by `blockLayer.ts`.

Verified two ways: a scripted WS check confirmed the mesh-data pipeline against a throwaway instance
seeded with the real Phase 7 campus (deliberately, not the tiny 5x5 test world — real fields/courts
stress-test large-quad tiling, 3x3 towers don't); the product owner then confirmed in a browser —
the one thing this session had no way to check itself, no WebGL rendering capability — that textures
render, tile in a repeating grid on large flat areas rather than stretching, and walls/floors look
reasonable.

The source stock sheet is a third-party asset, kept out of git like `school map.png` (added to
`.gitignore`) — re-running the build script needs it present locally first, licensing terms unverified
by this session (the product owner sourced and supplied it).

### Phase 8 (continued) — UNCOMMITTED
Everything below is real, working code in the tree right now (`git status` / `git diff` show it) but
**has never been committed** — no hash to cite. Picking this up means either committing it (after
resolving the blue-world bug below, or at least deciding it's not blocking) or continuing on top of it
as-is. `npm run typecheck` and `npm run build` are both clean against this state.

**C4 whole-world-load spike — run for real against the real campus, resolved, no code change.**
PLAN.md's own exit criterion (§5): gzipped `world-state` payload and time-to-playable, measured via a
scripted WS client against a throwaway instance holding the real 529-chunk Phase 7 world. Result: raw
JSON 0.90 MB, **gzipped 15 KB** — several hundred times under the 5 MB threshold; server-side round
trip 23 ms locally, estimated ~0.02 s transfer even at a conservative 5 Mbps. Per C4's own rule,
whole-world load stays and render-distance streaming is never built. Nothing to commit for this one —
it's a measurement, not a code change — but it's the reason the next two items don't need to worry
about a chunk-unload path.

**Geometry disposal on remesh/unload.** Remesh-time disposal already existed and was already correct
(pre-existing code, just confirmed). Unload doesn't apply — confirmed no unload code path exists
anywhere in the client, and given C4's result above, none will ever be needed. The one real gap found:
`ChunkRenderer.dispose()` disposed its material but never the `DataArrayTexture` itself, since it's
only reachable via a shader uniform (`uniforms.map.value`), not `material.map` — the only reference
three.js's own material disposal knows to follow. Fixed; `dispose()` now also removes every chunk mesh
from the scene before clearing its own maps.

**Transparent-block second mesh pass (glass, water) — the biggest piece, and it found a real
pre-existing bug along the way.** PLAN.md's Phase 8 task list only names glass, but this is built
generally for every `transparent: true` block:
- **WATER was completely invisible before this, in every build back to Phase 0.** The mesher's
  face-culling used `isSolid(blockA) !== isSolid(blockB)` to decide whether a face was needed. WATER is
  `solid: false` — so water-vs-air comparisons always found `solid===solid` (both false) and drew
  *nothing*, on every side including the top surface. This never mattered before because the flat test
  world never contained a water block; Phase 7's ponds were the first time it did, and this session's
  own browser passes on Phase 7/the texture work never happened to look straight down into one. Fixed
  by changing the mask logic to a proper "is either side literally AIR" test (with a same-id exception
  so two adjacent identical blocks still don't draw an internal face) instead of a solid-equality test
  — any non-air block, solid or transparent, now correctly gets a face against air.
- `mesh.ts`'s `meshChunk()` now returns `{ opaque, transparent }` instead of one flat result, split by
  `isTransparent(blockId)`. `mesh.worker.ts` passes both halves through. `chunkRenderer.ts` builds two
  `THREE.Mesh` objects per chunk instead of one, each with its own material, so three.js's automatic
  transparent-object sort (back-to-front, after all opaque draws) applies correctly.
- `blockMaterial.ts`'s `createBlockMaterial(map, { transparent })` now has a second variant:
  `transparent: true, depthWrite: false`, with a flat `alpha` uniform (0.55) — the source texture tiles
  have no real alpha channel of their own (ordinary opaque pixel art), so "see-through" has to come from
  the material, not the image.
- Verified two ways before ever reaching a browser: `meshChunk()` run directly against all 529 real
  Phase-7 chunks' actual data outside the browser entirely — zero exceptions. The product owner then
  confirmed in a browser that water renders and glass (before being reverted to opaque — see below) was
  genuinely see-through.

**Hotbar (`client/src/hotbar.ts`, new) — previously didn't exist at all.** `PLACEMENT_BLOCK` was a
single hardcoded `STONE` constant; every player could only ever place stone, full stop, regardless of
anything else this project already supported. Now: one slot per block type (10, in `blocks.ts` id
order), icons are CSS-cropped straight from the real texture-array source image (no separate icon
asset — always in sync with however `buildTextureArray.ts` maps blocks to tiles), number keys `1`-`9`
and `0` select a slot (Minecraft's convention), mouse wheel cycles. Wired into `main.ts` with the same
gating `controls.ts` already uses for movement (disabled while chat is open, so typing a digit into a
message doesn't also swap blocks) and `client/index.html` (new `#hotbar` container + CSS). **Not yet
seen in a browser by anyone** — built and typechecked, not visually confirmed.

**Name tags — reviewed, no changes made.** PLAN.md's Phase 8 list still says "hotbar, join screen, name
tags" verbatim, but join screen (Phase 4) and name tags (Phase 2, `remotePlayers.ts`) were both already
built well ahead of Phase 8 — that list item was stale by the time later phases delivered pieces of it
early. Re-read `remotePlayers.ts` specifically looking for a real gap (interpolation, color-hashing,
disposal on remove) and found none worth changing.

**The "pure blue world" bug (§5's original report) recurred live in this session — still not
conclusively root-caused, actively being investigated with the product owner.** Sequence of events:
1. Product owner hit it while testing the transparency/hotbar work above.
2. Investigated the most direct lead first: does the rewritten `meshChunk()` throw on any real chunk?
   Tested directly against all 529 real Phase-7 chunks outside the browser — zero failures. Ruled out.
3. Found two genuine, previously-**100%-silent** failure-visibility gaps, fixed both, regardless of
   whether either is *the* cause: `chunkRenderer.ts`'s Web Worker had no `onerror`/`onmessageerror`
   handler at all — a worker-side failure would mean a chunk simply never arrives, no console output,
   nothing, indistinguishable from "everything is fine, still loading." `main.ts`'s `tick()` render
   loop had no error handling — a single throw anywhere in it would skip the
   `requestAnimationFrame(tick)` call at the end and silently, permanently end the *entire* render loop
   on that one bad frame, freezing on whatever last rendered (often just `scene.background`'s sky blue,
   before any chunk geometry has arrived) — exactly the reported symptom, from any transient cause.
   `tick()` is now wrapped in try/catch: logs to console every time, surfaces one (not spammed)
   `appendSystemMessage` the first time, and — critically — still calls `requestAnimationFrame(tick)`
   regardless, so a transient failure gets a chance to self-heal on the next frame instead of freezing
   forever.
4. Product owner tried to reproduce with these fixes in place — **could not reproduce it**, once.
5. It then recurred anyway. They're now specifically reproducing it in **Safari**, with DevTools console
   open, at this session's request. **This is a real, unconfirmed, but strong new lead**: the shader
   work above uses WebGL2-specific features — `RawShaderMaterial` with `glslVersion: THREE.GLSL3`
   (`sampler2DArray`, GLSL ES 3.00 syntax) and `THREE.DataArrayTexture` (texture arrays) — that Safari
   has historically supported less consistently than Chrome/Firefox. Nothing in this session's own
   testing (all via scripted Node clients, zero real-browser access) can confirm or rule this in or out.
   **Whoever picks this up next: get the Safari console output first, before changing anything else.**
   If it points at shader compilation or `sampler2DArray`, the fix path is almost certainly a Safari-
   specific fallback (e.g. detecting WebGL2/array-texture support and falling back to the flat-color
   `MeshLambertMaterial` path Phase 8 replaced, rather than a universal fix) — don't assume it's the
   same failure mode as steps 1-3 above just because the symptom looks identical.

**GLASS: a real back-and-forth worth understanding, not just the end state.**
- First made fully opaque per direct request: `shared/src/blocks.ts`'s `GLASS` block flipped from
  `transparent: true` to `false`. This part stays, uncontested.
- Its texture ((2,3) in the source sheet — a "snow melting onto dirt mounds" gradient) was initially
  **re-cropped** to isolate just the clean snow band, dropping the dirt portion entirely — a
  misreading of "I want the snow cover to be always on top" as a request about texture *content*.
  **Reverted** — `tools/src/buildTextureArray.ts` is back to a plain single-tile crop for GLASS, no
  special-casing, once the product owner clarified they meant something else.
- What they actually meant, and what's actually fixed: a real **UV-axis-mapping bug in `mesh.ts`'s
  greedy mesher**, general to every directional texture (this snow/dirt gradient, but equally brick
  coursing or wood grain), not GLASS-specific. For east/west-facing wall faces specifically (`d===0` in
  the mesher's internal `(d+1)%3`/`(d+2)%3` axis-cycling — north/south walls and the top/bottom faces
  were *already* correct, by coincidence of that formula, which is exactly why this went unnoticed
  until a texture with an obvious "this side up" made it visible), world-**Y** was being mapped to the
  texture's horizontal (S/column) coordinate instead of its vertical (T/row) one — so a texture meant
  to read top-to-bottom instead appeared to run sideways, only on that one wall orientation. Fixed by
  swapping which of the merged quad's width/height drives texture-S vs texture-T specifically when the
  mesher's "u" axis is Y (`d===0` only) — the geometric position/mask/merge/winding logic above it is
  completely untouched; this is purely a texture-coordinate remap layered on top.
- Verified **numerically, not visually** (still no browser access): wrote and ran a synthetic
  multi-block-merge test directly against `meshChunk()` (not checked in — discarded after use, this
  project's established pattern for one-off verification scripts) confirming a 4-tall merged column's
  Y-extent now lands on the texture's row coordinate for the previously-broken wall direction, while
  the already-correct wall direction and the top face are unaffected. **Not yet confirmed on screen.**

**Mouse sensitivity halved**, per direct request: `client/src/controls.ts`'s `sensitivity` constant,
`0.01` → `0.005`. (Context for whoever touches this next: `0.01` itself was arrived at through several
rounds of live tuning during Phase 1's original browser pass, up from an initial `0.0022` — see §3's
Phase 1 entry. This halving hasn't had its own dedicated feel-check yet.)

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

### Phase 5 — committed on the product owner's go-ahead; manual browser pass now done
No browser automation tool was available when Phase 5 was built. Every admin action was verified
end-to-end via `fetch`/`WebSocket` against **throwaway server instances** on separate ports with
temporary `DATA_DIR`s (§4) — specifically so the product owner's actual running dev server, with its
real test data, was never touched by this testing. The product owner reviewed the work and directed
moving on to Phase 6 without walking the manual checklist step-by-step in that session — unlike
Phases 1-4, it shipped without an explicit "tried it in a browser, works" confirmation at the time.

**That gap is now closed.** A later session (no browser automation available in it either) stood up
another throwaway instance the same way — separate port (`8799`), temporary `DATA_DIR`, real dev
server on `8787` left untouched throughout — and the product owner walked the full checklist below
directly in a browser: login (wrong password, then right), creating a code from the admin page itself,
join-and-appear-in-online-list, mute/unmute, kick, rejoin + place blocks + rollback, reissue, revoke,
and the chat log viewer's filters. **Confirmed: everything looks good, no issues found.** The throwaway
instance and its data dir were torn down afterwards; nothing from this pass persists anywhere.

The steps, preserved here in case the admin page changes and this needs re-walking:

```sh
npm run hash-admin-password -w server -- "<pick a password>"
# copy the printed ADMIN_PASSWORD_HASH= line, then run a throwaway instance on a spare port
# with a temporary DATA_DIR (never the real dev server/DB):
PORT=8799 DATA_DIR=/tmp/some-throwaway-dir JOIN_CODE_PEPPER='<any value>' \
  ADMIN_PASSWORD_HASH='<paste the hash>' ALLOWED_ORIGIN='http://localhost:8799' \
  npx tsx server/src/index.ts
```

Visit `http://localhost:8799/admin` (the admin page is served by the game server directly, not
through Vite's dev proxy) and `http://localhost:8799` for the game client (needs `client/dist` built
via `npm run build` first — the throwaway server serves it the same way production does). Checklist:
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
  **Update: it recurred**, live in a later session, after the Phase 8 texture/transparency/hotbar work
  — see §2's "Phase 8 (continued) — UNCOMMITTED" section and §6 for the full, current investigation
  (what's been ruled out, what's been fixed as defense-in-depth without confirming root cause, and the
  live Safari-specific lead being chased now). Still not conclusively explained, second time around.

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

**Top priority: the "pure blue world" bug is back, unresolved, and actively being chased with the
product owner in Safari right now.** Full story in §2's "Phase 8 (continued) — UNCOMMITTED" section —
don't skip it, there's real diagnostic history there (what's been ruled out, what's been fixed as
defense-in-depth without confirming it's the cause, and exactly what to ask for next: Safari DevTools
console output, since the newest code uses WebGL2 features — GLSL3 `RawShaderMaterial`,
`DataArrayTexture` — Safari has historically been shakier on than Chrome/Firefox). This bug has now
been reported, investigated, and left unresolved *twice* (originally in §5, now again here) — worth
treating as a real priority rather than something to note and move past a third time.

**Phase 7 (school map importer) is done and committed** (`19eaa72` — see its own section under §2 for
the full story). The real campus is what loads now, not the flat test world; `WORLD_CHUNKS`/`SPAWN` are
wired to it.

**Phase 8 (performance & polish) is functionally complete but only partly committed.** The
texture-atlas task is committed (`6b08610`). Everything else on PLAN.md's Phase 8 list — the C4 spike
(resolved: keep whole-world load, confirmed against the real campus), geometry disposal, the
transparent-block second pass (and the real WATER-was-always-invisible bug it uncovered), the hotbar,
and a UV-orientation bug fix found along the way — is **built, typechecked, and sitting uncommitted in
the working tree** (§2 has the full detail on each). Name tags needed no changes (already solid from
Phase 2). None of the uncommitted pieces except the transparency pass have been confirmed working in an
actual browser yet — that, plus the blue-world bug above, are what's blocking a clean commit and true
"Phase 8 done" status.

One loose end from Phase 7 worth remembering if picking that back up specifically: PLAN.md's original
map inspection read the pod count as P1–P23, the product owner recalled P1–P22 — never actually
recounted against the pixels (the importer doesn't hardcode a pod count anywhere, so this didn't block
Phase 7, but it's still an open factual question if it ever matters for something else).

Both pre-launch items from the previous version of this section are now done:
- **`chatFilter.ts`'s `WHITELIST` is seeded** (`462a5a0`): real display names issued so far (`Eddie`,
  `Jayson`) plus Pinehurst School's campus vocabulary from `school map.png` / PLAN.md §3 (`college`,
  `field`, `library`, `gym`, `theatre`, `administration`, `primary admin`, `maintenance`, `afsc`,
  `carpark`, `drop-off zone`, `pinehurst`). Smoke-tested (script written and discarded, not checked
  in): all of it stays clean, real profanity is still caught, and none of the new terms actually
  collided with the blacklist as substrings today — this is precautionary defense-in-depth, not a fix
  for a live false positive. **Add more names here as more join codes get issued** — only two real
  names are seeded so far. One unrelated gap surfaced by the smoke test — initially reported here as
  just `"tits"` (plural) not being caught — turned out on investigation to be a much bigger, since-fixed
  issue; see below.
- **`JOIN_CODE_PEPPER` and `ADMIN_PASSWORD_HASH` verified as real, distinct secrets**, not testing
  leftovers: the pepper is 32 bytes of hex, distinct from the hardcoded insecure fallback in
  `auth.ts`; the hash's params (`m=65536,p=4,t=3`) match the `argon2` package's own defaults, i.e.
  exactly what `hashAdminPassword.ts` produces; neither value has ever appeared in git history on any
  branch (`git log --all -S` on both, zero hits). Product owner confirmed keeping both as-is rather
  than rotating — note for later: rotating `JOIN_CODE_PEPPER` would invalidate every already-issued
  code (`code_hash = HMAC-SHA256(code, pepper)`), so a future rotation needs reissuing codes alongside
  it, not just swapping the env var.
- **Fixed a real chat-filter bug** (`2988df0`): the `"tits"` report above turned out to be one symptom
  of a much bigger issue. `skipNonAlphabeticTransformer()` (added in Phase 3 to catch spaced-out
  evasion like "f u c k") strips the spaces that word-boundary-anchored blacklist patterns (e.g.
  `|shit|`, `|cunt|`, `|tit|`) rely on — so those words stopped matching whenever sandwiched between
  other words. "shit now" and "this is shit" still matched (word at the very start/end of the
  message); "hey shit now" — ordinary mid-sentence placement — silently didn't. Confirmed this
  silently defeated ~20 dataset words, including "shit", "cunt", "rape", "cock", "fag", "whore", "sex".
  Fixed by running two matchers (one with the transformer, one without) and unioning their matches,
  instead of trading mid-sentence detection away for evasion detection. Verified against a 39-case
  battery covering the regressed words mid-sentence, spaced/unicode evasion, the pre-existing
  cross-word-boundary false-positive checks, and every whitelist term.

Phase 5's admin **page** itself (as opposed to the actions it drives, which were already
scripted-verified) has now also had its manual-browser pass — see §3: the product owner walked the
full checklist against a throwaway instance and confirmed everything works, no issues found.

Whenever always-on hosting is wanted again: [DEPLOY.md](DEPLOY.md) is complete and ready, and its own
post-deploy checklist is where PLAN.md's Railway-specific "done when" criteria (redeploy-preserves-
data canary, WSS through Railway's proxy) would finally get checked for the first time against a real
deployment — nothing currently verifies those specifically, since self-hosting doesn't need Railway's
redeploy/proxy behavior at all.
