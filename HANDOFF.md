# HANDOFF.md

Snapshot of where this project actually stands, for whoever (or whichever session) picks it up
next. This is a point-in-time status doc, not a spec — [CLAUDE.md](CLAUDE.md) is the durable spec,
[PLAN.md](PLAN.md) is the phased build plan. This file goes stale; trust `git log` and the code over
it if they disagree.

**As of 2026-08-16:** Phase 0 and Phase 1 are committed and pushed (`447d25e`, `66b689f`). Phase 2
(multiplayer sync) is implemented, passed its scripted end-to-end test, and the product owner has
confirmed it in a real two-tab browser pass — remote players, interpolation, and reach-distance all
look good. Committing is the immediate next step, then on to Phase 3 (chat).

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

### Phase 1 — vertical slice (**uncommitted**, in the working tree now)
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

**Still not covered by anything automated:** actual rendering correctness (§3 Phase 2).

---

## 5. Known housekeeping items (not blocking, flagged not fixed)

- **`school map.png` and `.DS_Store`** are still present in git history from before this session
  (an earlier commit added them before PLAN.md's decision D3 said to keep the map out of git). The
  map was `git rm --cached` in the Phase-0 commit, so it's gone from the current tree, but it's still
  recoverable from history. Scrubbing it fully needs a history rewrite + force-push — not done, since
  that's disruptive to a shared remote and wasn't asked for.
- **`allow-scripts` warnings** on `npm install` (esbuild, fsevents, better-sqlite3 postinstall
  scripts) are advisory-only in this environment — verified the actual native binaries build and load
  correctly (`better-sqlite3` opens/queries fine, `esbuild`/Vite run fine). Don't spend time chasing
  these unless something actually breaks.

---

## 6. Next up: Phase 3 (per PLAN.md)

Phase 1 (`66b689f`) and Phase 2 are both confirmed in a real browser. Phase 3 is chat, **with its
safety layer built in from the start, not bolted on after** — PLAN.md is explicit this is
non-negotiable per CLAUDE.md §7, not ordinary feature polish. Headline tasks: `chat-message` type
(already in the Phase 0 protocol schema, unused until now); `obscenity` (TypeScript-native,
transformer-based — chosen over simpler substring libraries specifically because it survives
leetspeak/unicode-lookalike/spacing evasion) as the core matcher; NFKC normalization + control-char
stripping before matching; **mask, don't hard-block** (replace the flagged word, log the raw text
always); token-bucket rate limit (burst 5, refill 1/2s), 200-char cap; PII-ish heuristics (digit
runs, "meet me", "what's your real name") as a high-severity **log tag**, not an auto-block — they
false-positive on things like "meet me at spawn"; no auto-mute on first offense. Critical pre-launch
step once real names exist: whitelist every child's display name and school-specific vocabulary
before the filter goes live — the Scunthorpe problem bites hardest on names and places. Full spec:
PLAN.md → Phase 3.
