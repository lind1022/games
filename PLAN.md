# PLAN.md — Implementation plan

Working plan for the voxel school game specified in [CLAUDE.md](CLAUDE.md). CLAUDE.md is the
durable **spec** (what and why); this file is the **build order** (in what sequence, done when).

> **Status:** pre-code. Repo contains `CLAUDE.md` and `school map.png` only — no `package.json`,
> no git repo. Strategy confirmed by the product owner: **playable demo first**. Host: **Railway
> Hobby (~$5/mo)**. Plan produced 2026-08-15.
>
> **Living document.** Tick items off, revise estimates, and fold decisions back into CLAUDE.md as
> they're confirmed. Phases 7–8 will need revisiting once the importer meets the real map.

---

## 1. Locked contracts — decide before writing code

All four research angles independently flagged the same thing: a small set of shared formats gates
the server, the client, **and** the map importer. Getting them wrong means a data migration, not a
refactor — and the migration lands after children have built things. Fix these in Phase 0, write
them down in `/shared`, and treat them as append-only afterwards.

| # | Contract | Decision | Why it's load-bearing |
|---|---|---|---|
| 1 | **Block-type ID table** | `shared/blocks.ts`: id → name, texture tile, `solid`, `transparent`. Ids 0–31 reserved core. **Append-only; never reorder or reuse an id** once any chunk is saved. | Consumed by mesher, collision, persistence, importer. |
| 2 | **Chunk footprint** | **16 × 16**, full-height column. **No vertical sub-chunking** (no `chunk_y`). | World is shallow; sub-chunking adds 3D indexing for zero gain. Importer maps pixel → column 1:1. |
| 3 | **Column height** | **64** blocks (`WORLD_HEIGHT = 64`). | See conflict C2 below. Importer wall-extrusion and server bounds validation must agree. |
| 4 | **Coordinate origin** | **Bounded, positive-only.** `x, z ∈ [0, worldSize)`, `y ∈ [0, 64)`. Not centred on origin. | Finite world; sidesteps the negative-index/modulo bugs inherited from infinite-terrain engines. |
| 5 | **In-blob voxel order** | `y * 256 + z * 16 + x` within a column. | Server read/write and importer output must match forever. |
| 6 | **Chunk serialization** | **RLE per column, 1-byte block ids**, with a leading `format_version` byte. Stored in `chunks.format_version` too. | See conflict C1. The version byte is the escape hatch. |
| 7 | **`block_changes` coordinates** | **World coordinates**, not chunk-local. | Rollback queries stay simple; changing later means rewriting the whole log. |
| 8 | **Protocol version** | `PROTOCOL_VERSION` constant in `/shared`; server rejects mismatched clients with a friendly "please refresh" message. | Avoids silent breakage when a child has a stale tab open. |
| 9 | **Join message shape** | Include a `code` field from day one, unvalidated until Phase 4. | Avoids a breaking protocol change when real auth lands. |

**Independently corroborated** (higher confidence): contracts 1, 2, 5 and 6 were flagged by three of
four researchers without seeing each other's work; the "no vertical sub-chunking" call was reached
independently by both the engine and persistence angles.

---

## 2. Resolved conflicts

The researchers disagreed on six points. Resolutions, with the reasoning:

**C1 — Chunk encoding: 1-byte RLE (not 2-byte dense).**
In memory: flat `Uint8Array`, 1 byte per block, O(1) access for meshing and collision (~16 KB per
chunk — trivial). On disk and on the wire: **run-length encoded per column**. The counter-argument
was 2-byte ids for headroom beyond 256 block types; rejected because a school world needs perhaps
20–40 types, doubling every byte to insure against a ceiling we won't approach is a bad trade, and
`format_version` + a ~322-row world makes a later re-encode a seconds-long migration. RLE also makes
C2 nearly free.

**C2 — Column height: 64 (not 32, not 128).**
CLAUDE.md says 16–32, reasoning from the real school being single-storey. But this is a *creative
building game for children*, and towers are the single most predictable thing kids build — clipping
them is a self-inflicted wound. 64 doubles the spec's ceiling. Under RLE the cost is near zero:
empty sky costs ~2 bytes per column, not 1 byte per block. (This is precisely why RLE beats dense
here — dense at height 64 would be ~5 MB; RLE lands under ~500 KB.) *Needs product-owner confirmation
— see open questions.*

**C3 — Greedy meshing from the start (not naive-then-rewrite).**
This world is dominated by huge flat expanses — three sports fields, a carpark, a playground. That's
the best case for greedy meshing, not an edge case; naive meshing a flat 283 m plane produces tens of
thousands of 1×1 quads. Since even the *Phase 1 test world is flat ground*, naive meshing would be at
its worst in the demo itself. Write the mesher once. Compromise on threading: implement it as a
**pure function** (chunk data in, typed arrays out) called directly in Phase 1, then move the call
site into a Web Worker in Phase 2 — a cheap migration precisely because the function is pure.

**C4 — Whole-world data load by default; streaming only if a spike says otherwise.**
First, separate two things the reports conflated: **rendering** is always culled (frustum culling +
render distance, never draw all chunks). The open question is only whether chunk *data* is streamed.
Given the whole world is ~5 MB dense and likely under 500 KB RLE'd, sending it all on join may delete
an entire subsystem. Default to whole-world load through Phases 1–6 (the test world is tiny anyway);
run the spike after Phase 7 against the *real* imported world. **Threshold: if the gzipped payload is
< 5 MB and time-to-playable is < 10 s on the slowest target device, keep whole-world load and never
build streaming.** Otherwise build render-distance streaming in Phase 8.

**C5 — Session takeover *and* the DB constraint (they're not alternatives).**
Takeover is the behaviour; the partial unique index is the enforcement. On join: in one transaction,
mark any existing active session for that code `revoked = 1` (reason `superseded`), close its socket
with a friendly "You joined from another device" message, then insert the new session. The index
`UNIQUE(code) WHERE revoked = 0` guarantees the invariant even if app logic has a bug. **Never reject
the incoming connection** — that's the lockout failure mode: school wifi drops constantly, and a
child locked out mid-play can't be rescued by an admin who is offline.

**C6 — Phase 1 uses pure write-through; dirty-chunk flush is a later optimization.**
One report both recommended write-through for the first slice *and* listed the flush loop as P0.
Resolved toward simplicity: Phase 1 rewrites the chunk blob and appends to `block_changes` on every
edit. At one player on a 5×5 test world the write amplification is irrelevant, and "obviously correct"
beats "efficient" in the milestone whose job is proving the architecture. Dirty-chunk flush (10 s
interval, eager flush at >50 pending, flush-on-SIGTERM) plus crash-recovery replay moves to Phase 6.

---

## 3. What the map actually is — and why it changes Phase 7

I inspected `school map.png` (2326 × 1390 RGBA) directly. Findings that the plan has to absorb:

**It is a venue/event overlay, not an architectural floor plan.** Titled "MAP OF VENUE", it is a
*site plan* of the whole campus seen from above, with a sports-event layer drawn on top.

**Consequence — there are no interior walls.** Buildings appear as **footprint outlines only**:
College 1–5 & Theatre, Junior College, Library, Gym, Administration, Primary Admin, Maintenance,
AFSC, and a large cluster of numbered pods P1–P23. No rooms, no corridors, no doors. CLAUDE.md §4
assumes "floor-plan image → walls, floors, doors"; **that assumption does not hold for this image.**
As written, the importer can only produce hollow building shells. This is the single biggest open
product question — see Q1.

**Event annotations must be stripped, not imported.** Overlaid in red/blue and unrelated to the
school: "Ct A & F", "Ct 1&2", "Ct 3&4", "Ct 5&6", the large "GYM" label, two "Control Room" labels,
"Warm Up Area", blue directional arrows, coffee and hot-dog vendor icons, and the green/blue court
diagram lettered A–F at bottom-left. Left in, these bake nonsense blocks into the world.

**Genuinely importable features:** building footprints; Field 1, 2, 3; carpark and drop-off zone;
paths and roads; **two stormwater settlement ponds** (cyan → water blocks); a large number of trees
(drawn as line-art circles); parking areas.

**Good news for classification:** it is clean vector-style art — flat fills, crisp edges, no JPEG
noise. Palette matching should work; the polygon-tracing fallback is probably unnecessary.

**Noise to handle:** text labels scattered throughout, tree circles drawn as outlines rather than
fills, parking-bay hatching, and a dashed site-boundary line.

**No scale bar and no legend.** Calibrate `pixelsPerMetre` against a known-size feature — the marked
courts at bottom-left are the best anchor (a netball court is 30.5 × 15.25 m).

**The footprint is irregular and not square.** CLAUDE.md's "283 m × 283 m" is illustrative only; the
site is a rotated, irregular polygon roughly 1.67:1. At 80,000 m² that's a bounding box nearer
**~365 m × ~219 m**, giving a **23 × 14 ≈ 322 chunk** grid — coincidentally almost identical to
CLAUDE.md's 324 estimate, so sizing conclusions hold even though the shape doesn't. Derive real
bounds from the image, don't hardcode a square.

---

## 4. Phases

### Phase 0 — Scaffolding & shared contracts
**Goal:** repo skeleton plus the frozen contracts from §1, so every later phase builds against
something stable.
**Tasks:** `git init` + `.gitignore` (`/data`, `node_modules`, **`school map.png`** — see D3); npm workspaces (`client/`, `server/`,
`shared/`, `tools/`); `tsconfig.base.json` + project references (`composite: true`); `/shared`
exports **source**, not a built `dist`, so edits propagate in dev without a build step; root
`npm run dev` runs Vite + `tsx watch` concurrently, with Vite proxying `/ws` (`ws: true`) to the
server port so one same-origin path works in dev and prod; **pin Node** via `engines` + `.nvmrc`;
write `shared/blocks.ts`, chunk constants, coordinate math, RLE codec, and zod-validated WS message
unions.
**Done when:** one `npm run dev` starts both processes; `tsc -b` passes across all packages and a
deliberate type error in `/shared` surfaces in *both* client and server; every §1 contract is written
down in `/shared`.
**Deps:** none · **P0 · S–M**

### Phase 1 — Vertical slice: one player, real authority loop, real persistence
**Goal:** prove the whole architecture end to end on a flat test world. Highest-value milestone.
**Build in this order — each step independently testable:**
1. Server: WS listen, dev-stub join (no code validation yet), in-memory 5×5-chunk grass world.
2. Client: connect, render, free-fly camera — proves the render pipeline.
3. Client: pointer lock, WASD, gravity, **AABB collision** (~0.6 × 1.8 × 0.6 hitbox, resolve per axis
   X→Z→Y for free wall-sliding). Hand-rolled; no physics engine. **Keyboard + mouse only** (D2) —
   pointer lock has no touch equivalent, so tablet support is a second control scheme, deferred.
4. Client: raycast target block, click sends `block-update-intent`. **No local write.**
5. Server: validate (bounds, known id, reach distance) → apply → persist (`chunks` +
   `block_changes` **with pre-image `old_block_id`**) → broadcast.
6. Client renders the change **only on receiving the broadcast** — proves server authority.
7. Restart the server; reconnect; world is exactly as left.

**Safety shipping in this phase:** `block_changes` with pre-image from the *first* moment building
exists (no log ⇒ no rollback for early griefing); block-placement rate limit (10–20/s per player);
server-side reach validation.
**Done when:** a player walks the test world with working collision; **stopping the server visibly
prevents block changes client-side** (proves no local write path exists); restart preserves all
edits; `block_changes` has one row per edit with who/what/when/before/after.
**Deps:** Phase 0 · **P0 · M–L**

### Phase 2 — Multiplayer sync
**Goal:** 2–5 clients see each other move and build, live.
**Tasks:** broadcast join/leave/move; remote players as capsule + name label; 10–15 Hz position
broadcast with ~100 ms interpolation buffer; move meshing into a **Web Worker** with transferable
`ArrayBuffer`s. **No client-side prediction** — the client simulates its own movement locally against
its own chunk data and the server does loose sanity checks (speed clamp, teleport detection).
Full prediction/reconciliation solves competitive-fairness problems this game doesn't have.
**Safety shipping in this phase:** online-players list (near-free once connections are tracked).
**Done when:** two tabs see each other move and build without refresh; disconnect removes the avatar
within seconds; 5 clients show no obvious CPU/memory blowup; main-thread frame time stays flat while
meshing.
**Deps:** Phase 1 · **P0 · M**

### Phase 3 — Chat (with its safety layer, not after it)
**Goal:** free-text chat meeting CLAUDE.md §7. Non-negotiable, not polish.
**Tasks:** `chat-message` type; **`obscenity`** (TypeScript-native, transformer-based, handles
leetspeak/unicode-lookalike/spacing evasion) as the core matcher — not the simpler substring
libraries; NFKC normalization + control-char stripping before matching; **mask, don't hard-block**
(replace the flagged word with asterisks, show the sender the masked version too, always log the raw
text); token-bucket rate limit (burst 5, refill 1/2 s), 200-char cap; PII-ish heuristics (7+ digit
runs, "meet me", "what's your real name") as a **high-severity log tag, not an auto-block** — they
false-positive on "meet me at spawn"; **no auto-mute on first offense** (short 60 s cooldown only
after ~5 flags in 10 min). Filtering stays **in-process** — no third-party moderation API, so no
child's chat text leaves the system.
**Critical pre-launch step:** seed the whitelist with **every child's display name and school-specific
vocabulary**, then smoke-test them through the filter. The Scunthorpe problem bites hardest exactly
on names and places.
**Done when:** messages broadcast; a blocklisted word is masked **in server logic** (not merely hidden
in UI); a burst test trips the limiter; every message — masked, flagged, or clean — lands in
`chat_log` with raw text preserved.
**Deps:** Phase 2 · can run parallel with Phase 4 · **P0 · S–M**

### Phase 4 — Join codes & sessions
**Goal:** replace the dev stub with real identity. Required before any child touches it.
**Tasks:** 6-char codes from a **Crockford-style alphabet excluding `0/O`, `1/I/L` and vowels** —
ambiguous glyphs get mistyped by young children, and dropping vowels stops codes accidentally
spelling words; normalize input to uppercase server-side; **hash codes** (HMAC-SHA256 + server-only
pepper) so a leaked `.db` file or backup can't be used to impersonate a child; show plaintext to the
admin **once** at creation; 256-bit session token in **localStorage** (not a cookie — this is a
WebSocket-first app, and localStorage avoids ambient-cookie cross-site WS hijacking); validate
`Origin` on upgrade; sliding expiry (~30–90 days); **session takeover per C5**; rate-limit code entry
(5 per 15 min per IP, generic error).
**Done when:** no player spawns without a valid code; invalid/disabled codes are cleanly refused; a
stored token skips re-entry; revoking a code both blocks reuse **and** kills the live session; a
reload or wifi drop reconnects the same child cleanly rather than locking them out.
**Deps:** Phases 1–2 · **P0 · M**

### Phase 5 — Admin panel
**Goal:** code management and moderation without shell access, for an admin who is usually offline.
**Tasks:** **real admin login first** — argon2id password, httpOnly + Secure + SameSite=Strict
cookie, rate-limited (an unauthenticated admin panel is worse than none); create/list/revoke codes;
live online-players list; chat log review with flagged-only filter, per-player view and surrounding
context, with inline actions; **four distinct actions** — kick (disconnect, code still valid), mute
(chat-only, and *tell* the child, don't fail silently), revoke (disable + disconnect + unusable),
rollback. Rollback v1 = **"undo player X's changes in the last N minutes"**, which matches the actual
threat model (one kid wrecking another's build); area-based undo is riskier and can wait.
**Done when:** a new code works immediately with no restart; online list updates live; a muted child's
messages stop reaching others but still log; kick disconnects within seconds; rollback restores a
griefed build using `old_block_id` pre-images.
**Deps:** Phases 3, 4 · **P1 · M**

### Phase 6 — Deploy, durability, backups
**Goal:** always-on, reachable, and safe to restart.
**Tasks:** Railway project + **volume mounted at `/data`, referenced via `DATA_DIR` env var, never a
hardcoded path**; **boot-time assertion that `DATA_DIR` is writable and actually on the mounted
volume**; pragmas on every open (`journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`,
`foreign_keys=ON` — the last is per-connection and silently unenforced if forgotten); `GET /health`;
restart policy `ALWAYS`; bind `0.0.0.0:$PORT`; migration runner on `PRAGMA user_version`; **dirty-chunk
flush + flush-on-SIGTERM + crash-recovery replay** (per C6); backups via **`VACUUM INTO`, never a raw
file copy** (a `cp` under WAL misses the `-wal` sidecar and produces an inconsistent snapshot), every
6 h, **shipped off-box** (R2/S3) so a volume failure doesn't take the world and every backup together.
**Done when:** the full flow works over the public internet including WSS; **a redeploy provably does
not lose data** (place a block → redeploy → still there); a restore from backup has been *rehearsed*
at least once; killing the process mid-session loses no committed block changes.
**Deps:** Phase 1 for mechanics; the *production* deploy should wait for Phases 4–5 so it isn't an
open door · **P0 · M**

### Phase 7 — School map importer
**Goal:** replace the flat test world with the real campus. Lives in `/tools` as a **separate
package** — `sharp` is a native addon and must not join the always-on server's dependency graph.
**Tasks:** `sharp` decode; **config-driven, not code-driven** (`/tools/import-config.json`:
`pixelsPerMetre`, `wallHeight`, colour→block palette, tolerance); **strip the event-annotation layer**
(§3) before classification; nearest-colour palette match with tolerance, unclassifiable pixels
defaulting to grass **and flagged for review** rather than silently guessed; morphological cleanup for
tree-circle and hatching noise; calibrate scale on the marked courts; derive real bounds from the
image rather than assuming a square; extrude building footprints to `wallHeight` as **hollow shells —
walls and a floor, no interior subdivision** (D1: the source has no interior detail, and dividing the
space is left to the children as a build activity); ponds → water;
**always emit a diff-PNG of the importer's own interpretation** for visual comparison against the
source before writing any chunks.
**Re-run policy:** destructive wipe-and-regenerate is fine **before** children build. Afterwards it
becomes a rare, human-supervised operation: review the diff-PNG, approve specific chunks, apply only
those. Building an automatic "never touch player-modified cells" merge is real complexity for a
scenario that may never arise.
**Applying to production:** never run the importer against the live DB. Take a `VACUUM INTO` backup,
run locally, verify the diff-PNG, then apply in a short maintenance window with the service stopped.
**Done when:** importer output loads in the **unmodified** Phase-1 server/client with zero format
changes; someone who knows the school walks it and recognizes it; a re-run against the same image is
idempotent.
**Deps:** Phase 0 contracts · **P1 · L**

### Phase 8 — Performance & polish
**Goal:** hit the bar on real school hardware at full scale.
**Tasks:** run the C4 whole-world-load spike and either delete streaming or build render-distance
loading (8–10 chunks); texture atlas with **1–2 px padded tiles and half-texel UV inset**
(`magFilter: Nearest` + `minFilter: NearestMipmapLinear` + mipmaps — Nearest alone disables mipmaps
and shimmers badly on exactly this world's big flat ground); geometry `.dispose()` on remesh/unload;
transparent-block second mesh pass for glass; hotbar, join screen, name tags.
**Target: 30 fps sustained** on integrated graphics (Chromebook / Intel UHD class), 60 fps stretch.
**Done when:** 30+ fps with the full imported world and 5 players on representative low-end hardware;
no jarring pop-in at walking speed; a long soak session shows no memory growth.
**Deps:** Phase 7 · **P2 · M**

---

## 5. Spikes — derisk these early, out of band

| Spike | When | Measures | Decides |
|---|---|---|---|
| **Railway + better-sqlite3 + WSS** | Right after Phase 0, parallel with Phase 1 | Does the native addon build on Railway? Does WSS survive the proxy? Does a volume file survive a redeploy? | Whether the Phase 6 hosting assumptions hold. A throwaway "hello world + DB write + WS echo" deploy. |
| **Controls & collision feel** | First thing inside Phase 1 | Does movement feel good to a child? | Whether the control scheme needs rework before networking is layered on. |
| **Whole-world load** | After Phase 7 | Gzipped payload size; time-to-playable on slowest device | < 5 MB and < 10 s ⇒ delete the streaming subsystem entirely (C4). |
| **Atlas bleeding** | Before finalizing textures | Long flat textured corridor viewed at distance | Whether padded atlas suffices or `DataArrayTexture` is needed. |

---

## 6. Schema

Reconciled with the C1/C2 decisions (1-byte RLE, height 64).

```sql
PRAGMA foreign_keys = ON;   -- per-connection; silently unenforced if omitted on any open

CREATE TABLE join_codes (
  code_hash    TEXT PRIMARY KEY,              -- HMAC-SHA256(code, pepper); plaintext never stored
  display_name TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  disabled     INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
  revoked_at   INTEGER
);

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,
  code_hash    TEXT NOT NULL REFERENCES join_codes(code_hash),
  display_name TEXT NOT NULL,                 -- snapshot at issue time
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen    INTEGER NOT NULL DEFAULT (unixepoch()),
  pos_x REAL, pos_y REAL, pos_z REAL, yaw REAL, pitch REAL,
  revoked      INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  revoke_reason TEXT                          -- 'superseded' | 'admin' | 'expired'
);
CREATE INDEX idx_sessions_code ON sessions(code_hash);
-- Enforces C5's invariant even if application logic has a bug:
CREATE UNIQUE INDEX idx_sessions_one_active ON sessions(code_hash) WHERE revoked = 0;

CREATE TABLE chunks (
  chunk_x        INTEGER NOT NULL,
  chunk_z        INTEGER NOT NULL,
  format_version INTEGER NOT NULL DEFAULT 1,  -- escape hatch: lets encoding change later
  block_data     BLOB NOT NULL,               -- RLE per column, 1-byte ids, order y*256 + z*16 + x
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (chunk_x, chunk_z)
);

CREATE TABLE block_changes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL DEFAULT (unixepoch()),
  chunk_x      INTEGER NOT NULL,
  chunk_z      INTEGER NOT NULL,
  x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,   -- world coords (contract 7)
  old_block_id INTEGER NOT NULL,              -- pre-image: REQUIRED for rollback
  new_block_id INTEGER NOT NULL,
  code_hash    TEXT NOT NULL REFERENCES join_codes(code_hash),
  display_name TEXT NOT NULL                  -- denormalized: survives revocation
);
CREATE INDEX idx_bc_ts       ON block_changes(ts);
CREATE INDEX idx_bc_chunk_ts ON block_changes(chunk_x, chunk_z, ts);
CREATE INDEX idx_bc_code_ts  ON block_changes(code_hash, ts);

CREATE TABLE chat_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL DEFAULT (unixepoch()),
  code_hash        TEXT NOT NULL REFERENCES join_codes(code_hash),
  display_name     TEXT NOT NULL,
  message          TEXT NOT NULL,             -- raw, as typed — never store only the masked form
  filtered_message TEXT,                      -- what was actually broadcast
  flagged          INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0,1)),
  flag_reason      TEXT
);
CREATE INDEX idx_chat_ts      ON chat_log(ts);
CREATE INDEX idx_chat_code_ts ON chat_log(code_hash, ts);
```

**Sizing.** `chunks` is **bounded, not growing** — capped by world volume regardless of how much
gets built (~5 MB dense at height 64; well under 500 KB RLE'd). The real growth vectors are
`block_changes` (~1–3 GB/year unpruned under heavy use) and `chat_log` (trivial). Start the Railway
volume at **1 GB** (~$0.15/mo, live-resizable). Add a retention job in Phase 6+: keep 30–90 days live,
archive older rows to gzipped NDJSON off-box, then delete — `block_changes` is audit/rollback data,
**not** needed to reconstruct world state, so pruning is safe.

---

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Volume not attached / wrong mount path** | Silent total world loss on every redeploy | Boot-time writability assertion; verify a canary file survives a redeploy *before* trusting real data. The single most dangerous Railway+SQLite footgun. |
| Map has no interior walls (§3) | Buildings are shells | **Accepted (D1)** — kids divide the space themselves. Revisit only if the school feels empty in playtesting. |
| **better-sqlite3 ABI mismatch** | Server won't boot after a Node bump | Pin Node (`engines` + `.nvmrc`); never let dev `node_modules` reach the deploy; smoke-test every deploy |
| **Backup taken by file copy under WAL** | Corrupt/inconsistent backups discovered only at restore time | `VACUUM INTO` only; **rehearse a restore** in Phase 6 |
| **Backups on the same volume as the DB** | One failure loses world *and* history | Ship off-box (R2/S3) |
| **Filter false-positives on children's names** | Kids can't say each other's names; feels broken | Whitelist all display names + school vocabulary; smoke-test pre-launch |
| **Join codes stored in plaintext** | One leaked `.db`/backup ⇒ impersonate any child | HMAC + pepper (Phase 4) |
| **Hard session lockout on wifi drop** | Child stranded; offline admin can't help | Takeover semantics (C5) |
| **Blocking the event loop** | better-sqlite3 is synchronous; one slow query stalls *all* players | Prepared statements, indices, transactions for batches; `worker_threads` only if it ever bites |
| **Chunk format churn after kids build** | Migration on live data instead of a refactor | §1 contracts + `format_version` from day one |

---

## 8. Decisions & open questions

### Decided 2026-08-15

- **D1 — Buildings are hollow shells.** The importer emits walls and a floor per footprint, no interior
  subdivision. Dividing and furnishing the space becomes a build activity for the children rather than
  importer scope. Nothing precludes hand-authoring interiors later.
- **D2 — Keyboard + mouse at launch.** Touch/tablet support deferred; it is a second control scheme
  (pointer lock has no touch equivalent), not a variation on the first.
- **D3 — `school map.png` stays out of git.** Gitignored, kept locally. It's a real school's site
  layout, and this matches the §7 posture. Reversible if it becomes inconvenient.

### Open — blocking Phase 7 (map import)

1. **Multi-storey.** Do any buildings have upper floors that matter, given the flat single-floor decision?
2. **Exclusion zones.** Anything to leave out — neighbouring property, staff-only areas, the maintenance
   compound?
3. **Scale anchor.** One confirmed real measurement (a court or field dimension) to calibrate
   pixels→metres. The marked courts are the best candidate if you can confirm their size.

### Open — before launch

4. **Session takeover** — confirm "joining from a new device bumps the old session" as the implementation
   of one-session-per-code (recommended; never locks a child out).
5. **Token lifetime** — how long before a child must re-enter their code? Proposed 30–90 days.
6. **Chat log retention** — proposed 6–12 months with a purge tool.
7. **Run by the school, or your personal project themed on it?** Affects whether the UK educational
   exemption from the Children's Code applies. The plan already does the right things either way; this
   only changes how much the answer matters.
8. **Parent notice** — telling parents that chat is logged and moderated costs nothing and materially
   strengthens the consent posture. Worth doing?

### Open — can default

9. **Height cap 64** (C2) — confirm, or ask for more headroom for towers.
10. **Railway account** — who provisions it, and when? Blocks the Phase 0/1 hosting spike.
11. **Deadline** — anything (start of term?) that should reorder phases?

---

## 9. Suggested next step

**Nothing blocks starting.** Phase 0 depends on none of the remaining open questions — the first
commit is the workspace skeleton plus the `/shared` contracts from §1, with the Railway spike running
alongside Phase 1. The Phase 7 questions (1–3) only need answering once the importer is next up.
