# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

> **Status:** Greenfield / pre-code. All major product decisions are now **confirmed** (see §2 and
> §9). This file is the agreed **specification and architecture**; the next task is scaffolding.
> A few small items remain marked _(confirm)_. Decisions confirmed on 2026-08-14.

---

## 1. Project vision

A web-based, Minecraft-style voxel game that **primary-school-aged children** can play together
online in a shared, persistent world modelled on **their real school**. Kids can move around,
build with blocks, and chat with each other. Everything in the world is a block.

The game is **online-hosted and always available**: children can join and play at any time,
**without the admin needing to be online**. Every change made to the world is saved permanently.
It is **pure creative / build-only** — no health, mobs, hunger, or day/night survival mechanics.

### Design principles (in priority order)
1. **Child safety first.** The primary audience is young children. Every feature is evaluated for
   safety before polish or performance. See §7.
2. **Simple to join, hard to abuse.** No accounts, emails, or passwords from kids — identity comes
   only from an admin-issued join code. Nobody without a code can get in.
3. **Persistent and self-running.** The world lives on the server and survives restarts; no admin
   presence is required for play.
4. **Keep it small.** Target is **up to 5 concurrent players** — a friend group, not thousands.
   Prefer simple, boring, reliable technology over anything that scales to millions.

---

## 2. Core requirements & confirmed scope _(requirement — confirmed 2026-08-14)_

- **Voxel world** — everything in the game is a block; players build and destroy blocks like Minecraft.
- **Web-based** — runs in a browser, no install.
- **Online hosted** — a server hosts the game so it is reachable over the internet.
- **Multiplayer + chat** — up to **5 children** play in the same world simultaneously and can chat.
- **Join-code identity** — the admin generates unique join codes and shares them.
  - Each join code maps to **one specific display name** (e.g. code `ABCDEFG` → the name "Jack").
  - **One code per child** (each child gets their own code and name).
  - Anyone who joins using that code plays as that name. Codes are the *only* way in.
- **School as the world** — the world represents the admin's school, built from a **provided map image**.
- **World shape** — **flat, single-floor**; total school area ≈ **80,000 m²** (buildings + grounds).
- **Build permissions** — **anyone can build/destroy anywhere** (no protected zones).
- **Game feel** — **pure creative / build-only** (no survival mechanics).
- **Chat** — **free text**, with safety filtering + logging (see §7).
- **Full persistence** — every block change is saved and reloaded.
- **Admin-independent** — the game is joinable and playable when the admin is offline.

---

## 3. Technology stack _(confirmed)_

Chosen for a tiny player count (≤5), simple hosting, and a manageable single-developer codebase.

| Layer            | Choice                                   | Why |
|------------------|------------------------------------------|-----|
| Language         | **TypeScript** (client + server)         | One language everywhere; shared types for the network protocol. |
| 3D rendering     | **Three.js** (WebGL)                      | The standard for browser voxel games; large ecosystem, good docs. |
| Client build     | **Vite**                                 | Fast dev server, simple config. |
| UI overlays      | Lightweight DOM (React only if it grows) | Join screen, chat box, hotbar — plain UI over the 3D canvas. |
| Server runtime   | **Node.js** + TypeScript                 | Same language as client; easy WebSocket support. |
| Realtime transport | **WebSocket** (`ws` library)           | Low-latency player movement, block updates, and chat. |
| Persistence      | **SQLite** (via `better-sqlite3`)        | Zero-ops, single file, ideal at this scale; backup = copy one file. |
| Hosting          | **Railway (Hobby)** recommended; **Hetzner CX22 VPS** for best value | Always-on process + durable disk for the SQLite file. |

**Server is authoritative.** The server is the source of truth for the world and validates every
block change and chat message. Clients never write directly to storage.

### Hosting decision (see §9 — final pick pending)
Both keep the world always-on (no sleeping free tiers) and persist SQLite durably. All-in cost is
**~$5–8/month**, plus an optional domain (~$10–15/year). Prices verified 2026-08-14.

- **Railway (Hobby) — recommended, ~$5/mo.** Git-push deploys, automatic HTTPS, WebSockets, small
  attached volume for the `.db` file. Fits inside the $5 usage credit at 5 players. Near-zero ops.
- **Hetzner CX22 — best value, ~€4.35 (~$4.60)/mo.** 2 vCPU / 4 GB / 40 GB NVMe; disk included, so
  SQLite lives on it directly; trivial backups. Trade-off: you manage Node, a process manager
  (systemd/pm2), and TLS (Caddy makes this trivial).
- Fly.io (~$2–6, pay-as-you-go) and Render Starter ($7 + disk) are viable but not preferred here.

---

## 4. Architecture _(proposed)_

```
┌────────────┐   WebSocket    ┌─────────────────────────┐      ┌──────────────┐
│  Browser   │ ◀────────────▶ │   Game server (Node)    │ ◀──▶ │  SQLite DB   │
│  client    │   (realtime)   │  - authoritative world  │      │  world +     │
│  (Three.js)│                │  - join-code auth       │      │  codes +     │
└────────────┘   HTTP (load)  │  - chat + moderation    │      │  chat log    │
      ▲         ◀────────────▶│  - admin API            │      └──────────────┘
      │                        └─────────────────────────┘
   Admin panel (web) ──────────────────▲
   (create join codes, moderate)
```

### The world model
- The world is divided into **chunks** (fixed-size columns/cubes of blocks) so only nearby chunks
  are sent to a client and only changed chunks are saved.
- A block is identified by a small **block-type id** (air, grass, brick, glass, door, …).
- On join, the client requests the chunks around the player; the server streams them from the DB.
- When a player places/removes a block, the client sends the intent, the server validates it,
  applies it, persists it, and broadcasts it to everyone in range.

### World sizing (from confirmed scope)
- Proposed scale: **1 block = 1 metre** (Minecraft-style). _(confirm)_
- 80,000 m² ⇒ roughly a **283 m × 283 m footprint** (≈80k ground columns). Flat single-floor means
  a small vertical extent — ground + building height + a little headroom (~16–32 blocks tall).
- This is large but very cheap to store: with sparse / run-length chunk encoding the whole world is
  only a few MB. At 16-wide chunks that's ~18×18 ≈ 324 chunks per layer.
- **Rendering must use a render distance** (load/mesh only chunks near each player) + frustum culling
  + greedy meshing — never render all 324 chunks at once. Comfortable for school laptops/tablets at
  ≤5 players. Note: much of 80k m² is open grounds (field/playground); the importer can render those
  simply (flat grass) and put detail into the buildings.

### Join-code auth flow
1. Admin creates a code in the admin panel → row `{ code, display_name }` saved (one code per child).
2. Child opens the game, enters the code.
3. Server validates the code, assigns the associated display name, and issues a **session token**
   (stored in the browser) so the child doesn't re-enter the code every time.
4. If the code is invalid, entry is refused. Recommended default: **one active session per code**
   at a time, to discourage sharing/impersonation. _(confirm)_

### School map import
The provided **map image** is converted into the initial voxel world by a **one-time importer**
(`/tools`). Approach: read the image, map regions/colours to block types (walls, floors, doors,
grass, paths), and emit the starting chunks into the DB. Because the source is a flat floor-plan
image and the world is single-floor, a 2D image → 2D block grid (with fixed wall height) is the
natural mapping. Re-runnable against an updated image before kids start building.

---

## 5. Data model _(proposed)_

- **join_codes** — `code` (unique), `display_name`, `created_at`, `disabled` (for revoking).
- **players / sessions** — `session_token`, `code`, `display_name`, `last_seen`, last position.
- **chunks** — `chunk_x`, `chunk_z` (+ `chunk_y` if vertical chunking), serialized block data, `updated_at`.
- **block_changes** (recommended) — append-only log of who changed which block and when. Enables
  **anti-grief rollback** and moderation even though anyone can build anywhere. See §7.
- **chat_log** — `timestamp`, `display_name`, `message`, moderation flags. Kept for safety review.

---

## 6. Repository structure _(proposed)_

```
/client     Browser game: Three.js rendering, input, UI overlays (chat, hotbar, join screen)
/server     Node game server: WebSocket handling, world logic, persistence, admin API
/shared     Types shared by client + server (block ids, network message schemas)
/admin      Admin panel UI (join-code management, moderation dashboard) — may live inside /server
/tools      One-off tools, incl. the school-map (image) → voxel-world importer
/data       Runtime data (SQLite file, backups) — gitignored
```

---

## 7. Child safety & moderation _(mandatory)_

The audience is young children, so safety is not optional. Build these in from the start, not later.
Chat is **free text**, which raises the bar on filtering:

- **No PII from children.** Identity is only the admin-assigned display name via a join code. Never
  collect emails, real names, ages, or logins from kids.
- **Closed world.** Only holders of a valid join code can enter. No open sign-up.
- **Chat safety (free text).** Mandatory: a **profanity/blocklist filter**, **rate-limiting**, and
  **full chat logging** for review. Filter on the **server** (authoritative). Consider blocking
  things that look like phone numbers, addresses, or "meet me" style messages.
- **Admin moderation tools.** Kick, mute, and disable/revoke a join code; review the chat log;
  see who is online.
- **Anti-griefing.** Anyone can build anywhere, so kids can destroy each other's builds. The
  `block_changes` log enables admin rollback/undo. (Protected zones are out of scope by decision.)
- **Backups.** Regularly back up the SQLite file so a bad day is recoverable.

When adding any feature that touches chat, names, or player interaction, explicitly check it
against this section.

---

## 8. Development workflow

> **Build order lives in [PLAN.md](PLAN.md)** — phased milestones, "done when" criteria, the locked
> shared contracts (block ids, chunk format, coordinates), schema SQL, risks, and open questions.
> This file stays the durable spec; PLAN.md is the working plan and changes as work progresses.

Commands (npm workspaces monorepo — `shared` / `server` / `client` / `tools`):
- `npm run dev` — client (Vite, :5173) + server (`tsx watch`, :8787) concurrently, Vite proxying `/ws`.
- `npm run build` — builds the client only (`vite build` → `client/dist`). The server has no separate
  build step — it runs directly off TypeScript source via `tsx` in both dev and production, and in
  production also serves `client/dist` itself (one process, one port — see [DEPLOY.md](DEPLOY.md)).
- `npm start` — runs the production server (`tsx src/index.ts` under the hood). Requires `npm run
  build` to have been run first if you want the game client reachable, not just the API/admin panel.
- `npm run typecheck` — `tsc -b` across all four workspace packages.
- `npm run create-code -w server -- "<name>"` — issue a join code from the CLI (or use `/admin`).
- `npm run hash-admin-password -w server -- "<password>"` — produces an `ADMIN_PASSWORD_HASH` value.
- No automated test suite exists yet (no framework chosen) — verification has been scripted
  ad hoc smoke tests, run and discarded per change; see HANDOFF.md for what's been covered.
- Prefer small, reviewable commits. Do not commit the `/data` directory.

**Current state:** Phases 0-5 built (scaffolding, vertical slice, multiplayer, chat, join codes,
admin panel); Phase 6 (deploy/durability/backups) in progress. See PLAN.md and HANDOFF.md.

---

## 9. Decisions & remaining items

**Confirmed (2026-08-14):**
1. **Tech stack** — §3 stack accepted.
2. **School map format** — an **image**.
3. **World shape** — **flat, single-floor**; total area ≈ **80,000 m²**.
4. **Codes** — **one code per child** (one code = one name).
5. **Player count** — **up to 5** concurrent.
6. **Chat style** — **free text** (with §7 filtering + logging).
7. **Build permissions** — **anyone can build anywhere** (no protected zones).
8. **Game feel** — **pure creative / build-only**.
9. **Hosting** — **Railway**, confirmed 2026-08-16. See [DEPLOY.md](DEPLOY.md) for the deploy process.
10. **One active session per code** — confirmed yes: joining from a new device takes over the old
    session with a friendly message (never a hard lockout). Implemented and tested, Phase 4.

**Small items still open:**
- **Block scale** — proposed **1 block = 1 m**. Confirm, or choose finer (e.g. 0.5 m) for detail.
- **Domain name** — do you want a friendly URL (~$10–15/yr), or is an IP/subdomain fine to start?

---

## 10. Notes for Claude Code

- This is a project **for and about children**. Weigh every change against §7 (safety) and §1
  (principles). When in doubt, choose the safer, simpler option and flag the trade-off.
- Keep the server **authoritative**; never trust the client for world or chat writes.
- Update this file as decisions get made — fold remaining §9 items into fixed sections once
  confirmed, and fill in §8 once the project is scaffolded.
