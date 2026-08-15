# HANDOFF.md

Snapshot of where this project actually stands, for whoever (or whichever session) picks it up
next. This is a point-in-time status doc, not a spec — [CLAUDE.md](CLAUDE.md) is the durable spec,
[PLAN.md](PLAN.md) is the phased build plan. This file goes stale; trust `git log` and the code over
it if they disagree.

**As of 2026-08-16:** Phase 0 is committed and pushed. Phase 1 is written, tested (automated *and*
in a real browser), and sitting **uncommitted** in the working tree — the product owner has played
it, found two real bugs, had them fixed, and is happy with movement/look-around. Committing is the
main thing left open (see §6).

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
is deferred to Phase 2, which introduces `player-move` and gives the server a trustworthy position to
check against. Bounds and known-block-id validation **are** enforced server-side now. See the comment
in `server/src/index.ts` right above the block-update-intent handling.

---

## 3. Browser verification — done

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
visually legible against the flat green-floor/blue-sky world; it's a testing aid, not phase content,
and can be deleted once real content (or Phase 8 textures) makes it redundant.

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

None of this used a real GPU/display — that gap is closed now by §3's manual pass.

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

## 6. Next up: Phase 2 (per PLAN.md)

Phase 1 is functionally done and confirmed in a real browser — the only thing left open is that it's
**still uncommitted**. Worth deciding before Phase 2: commit/push now (and whether the landmark
towers in `server/src/world.ts` ship as-is, get toned down, or get stripped out first — they're a
testing aid, not spec content).

Phase 2 itself is multiplayer sync — broadcast join/leave/move, remote players as capsule + name
label, 10–15 Hz position broadcast with ~100ms interpolation, move meshing into a Web Worker (cheap
now, since `mesh.ts` was written as a pure function specifically for this), loose server-side
movement sanity checks, and — per §2 above — this is also the natural place to add the reach-distance
check Phase 1 deferred. Full spec: PLAN.md → Phase 2.
