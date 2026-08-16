# SELF_HOSTING.md

How to host the game yourself — run it on your own computer, only while you're around to supervise
play, exposed through a public URL via a tunnel rather than always-on cloud hosting. **This is the
current default way to run this for real play** (see CLAUDE.md §1/§3) — Railway hosting (always-on,
joinable without you present) still exists and works, but is deliberately paused for now; see
[DEPLOY.md](DEPLOY.md) for that path when it's wanted again.

This is a durable reference, not a point-in-time status doc — unlike HANDOFF.md, it shouldn't go
stale as work progresses, only if the self-hosting approach itself changes. The tunnel steps below
were rehearsed end-to-end against a real Cloudflare quick tunnel (join + chat confirmed working over
the actual public URL), not just written from documentation.

---

## 1. The two ways to run this, and which one to use

- `npm run dev` — **for your own development/testing only.** Splits into two processes on two ports
  (Vite on :5173 serving the client, the game server on :8787), with Vite proxying WebSocket traffic
  between them. Not what you want for hosting a real session — a tunnel needs one single port to
  point at.
- `npm run build && npm start` — **for actually hosting a play session.** Builds the client into
  static files and runs the server as a single process on a single port, which also serves the built
  client itself (the production path built and verified in Phase 6 — see HANDOFF.md). One process,
  one port — exactly what a tunnel needs. This is what the rest of this guide assumes.

## 2. Install a tunnel client

This guide uses **Cloudflare Tunnel** (`cloudflared`) — free, no account required for the "quick
tunnel" mode used here, and it proxies WebSocket traffic transparently (confirmed by rehearsal).

- **macOS**: `brew install cloudflared` (or download the binary from Cloudflare's GitHub releases if
  you don't have Homebrew).
- **Windows**: `winget install --id Cloudflare.cloudflared`, or download from Cloudflare's site.
- **Linux**: your package manager, or the binary from Cloudflare's GitHub releases.

## 3. Start the tunnel, then the server

The tunnel has to exist *before* you start the server, because the server needs to know the tunnel's
URL (via `ALLOWED_ORIGIN`) at startup, and that URL is only assigned once the tunnel connects.

**Terminal 1 — start the tunnel, pointed at the port the server will use:**

```sh
cloudflared tunnel --url http://localhost:8787
```

Wait for it to print something like:

```
Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):
https://some-random-words.trycloudflare.com
```

Copy that URL. **It's different every time** you start a quick tunnel this way — there's no free way
to get a stable one without owning a domain (see §6).

**Terminal 2 — build (first time / after code changes) and start the server with that URL:**

```sh
npm install                       # first time only
npm run build                     # rebuild whenever the code changes
JOIN_CODE_PEPPER='<a long random secret>' \
ADMIN_PASSWORD_HASH='<from hash-admin-password, see §5>' \
ALLOWED_ORIGIN='https://some-random-words.trycloudflare.com' \
npm start
```

Then:
- **You** (the admin) open `https://some-random-words.trycloudflare.com/admin`, log in, and create a
  join code per child.
- **Kids** open that same `https://some-random-words.trycloudflare.com` URL (from anywhere — they
  don't need to be on your network) and enter their code.

Stop both (Ctrl+C in each terminal) when the session's over. The world, chat log, and all
codes/sessions persist in `data/world.db` (or wherever `DATA_DIR` points) regardless of the tunnel —
starting again later (with a freshly-generated tunnel URL) picks up exactly where you left off.

## 4. `ALLOWED_ORIGIN` — why it matters

The server checks the `Origin` header on every WebSocket connection attempt against an allowlist
(defense-in-depth, not the primary safety mechanism — see the comment in `server/src/index.ts`). By
default it only allows `localhost`, which **will silently reject every connection coming through the
tunnel** unless `ALLOWED_ORIGIN` is set to match the tunnel's URL exactly, protocol included
(`https://`, not `http://` — Cloudflare terminates TLS for you, so the public URL is always HTTPS even
though the server itself is plain HTTP on localhost).

If you also want to test from the host machine directly at `localhost:8787` (bypassing the tunnel)
without restarting, comma-separate both:

```sh
ALLOWED_ORIGIN='http://localhost:8787,https://some-random-words.trycloudflare.com'
```

## 5. Secrets

Self-hosting doesn't relax the child-safety posture:

- **`JOIN_CODE_PEPPER`** — without this set, codes are hashed with a hardcoded, publicly-known
  fallback value (fine for solo dev, prints a loud warning) — not acceptable once real children's join
  codes are involved. Generate one with `openssl rand -hex 32`.
- **`ADMIN_PASSWORD_HASH`** — run `npm run hash-admin-password -w server -- "<a real password>"` and
  use the printed hash. Without it, `/admin` is simply unreachable.

Keep both values somewhere durable (a password manager, a local `.env` file **that stays out of
git** — check `.gitignore` covers it before creating one) so you're not regenerating them every
session; regenerating `JOIN_CODE_PEPPER` in particular invalidates every previously-issued code.

## 6. Getting a stable URL instead of a new one every session

Quick tunnels (§3) assign a random `*.trycloudflare.com` subdomain every time you start one — fine
for occasional sessions, mildly annoying if you host often (kids need a fresh link each time). To get
a fixed URL instead:

- Buy a domain (~$10–15/yr — CLAUDE.md §9 already flags this as an open, independent decision) and
  add it to a free Cloudflare account.
- Create a **named tunnel** (`cloudflared tunnel create <name>`) and route a hostname on that domain
  to it (`cloudflared tunnel route dns <name> play.yourdomain.com`) — this gives a permanent URL that
  doesn't change between sessions.

This is a nice-to-have, not required to get started — the quick-tunnel flow in §3 works fully without
owning anything.

## 7. Switching back to Railway later

Nothing about self-hosting is a one-way door. `railway.json` and DEPLOY.md are complete and were
verified locally (Phase 6) — the code doesn't care whether it's run on your laptop behind a tunnel or
a Railway container. When it's time for always-on hosting again, follow DEPLOY.md from the top;
nothing here needs to be undone first.
