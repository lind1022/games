# SELF_HOSTING.md

How to host the game yourself — run it on your own computer, only while you're around to supervise
play, with no cloud hosting involved. **This is the current default way to run this for real play**
(see CLAUDE.md §1/§3) — Railway hosting (always-on, joinable without you present) still exists and
works, but is deliberately paused for now; see [DEPLOY.md](DEPLOY.md) for that path when it's wanted
again.

This is a durable reference, not a point-in-time status doc — unlike HANDOFF.md, it shouldn't go
stale as work progresses, only if the self-hosting approach itself changes.

---

## 1. The two ways to run this, and which one to use

- `npm run dev` — **for your own development/testing only.** Splits into two processes on two ports
  (Vite on :5173 serving the client, the game server on :8787), with Vite proxying WebSocket traffic
  between them. Convenient for iterating on code, but not what you want when other kids are actually
  going to connect from their own devices — a second device would need to reach the Vite port *and*
  have its WebSocket traffic correctly proxied back across the network, which is needlessly fragile.
- `npm run build && npm start` — **for actually hosting a play session.** Builds the client into
  static files and runs the server as a single process on a single port, which also serves the built
  client itself (this is exactly the production path built and verified in Phase 6 — see HANDOFF.md).
  One process, one port, one URL to give the kids. This is what the rest of this guide assumes.

## 2. Quick start

```sh
npm install               # first time only
npm run build              # rebuild whenever the code changes; not needed every session otherwise
JOIN_CODE_PEPPER='<a long random secret>' \
ADMIN_PASSWORD_HASH='<from hash-admin-password, see below>' \
ALLOWED_ORIGIN='http://localhost:8787,http://<your-LAN-IP>:8787' \
npm start
```

Then:
- **You** (the admin) open `http://localhost:8787/admin`, log in, and create a join code per child.
- **Kids on the same WiFi** open `http://<your-LAN-IP>:8787` in a browser and enter their code.

Stop with Ctrl+C when the session's over. The world, chat log, and all codes/sessions persist in
`data/world.db` (or wherever `DATA_DIR` points) — starting the server again later picks up exactly
where you left off. Nothing is lost between sessions; the game simply isn't reachable while it's off.

## 3. Finding your LAN IP

Whatever device you're running the server on, kids need your **local network IP**, not `localhost`
(which only means "this machine" to each of their own devices).

- **macOS**: `ipconfig getifaddr en0` (or `en1` if on Wi-Fi via a different interface) in Terminal.
- **Windows**: `ipconfig` in Command Prompt, look for "IPv4 Address" under your active adapter.
- **Linux**: `ip addr show` or `hostname -I`.

It'll look like `192.168.1.42` or `10.0.0.15`. The URL to give kids is `http://<that-IP>:8787`
(assuming the default port). This IP can change between sessions if your router uses DHCP without a
reservation for your machine — check it each time you host, or set a static/reserved IP for your
machine in your router's settings if you host regularly.

## 4. `ALLOWED_ORIGIN` — why it matters and what to set it to

The server checks the `Origin` header on every WebSocket connection attempt against an allowlist
(defense-in-depth, not the primary safety mechanism — see the comment in `server/src/index.ts`). By
default it only allows `localhost`, which is correct for solo dev but **will silently reject
connections from every other device** unless you set `ALLOWED_ORIGIN` to match how kids actually
reach the server:

```sh
ALLOWED_ORIGIN='http://localhost:8787,http://192.168.1.42:8787'
```

Comma-separate multiple values if you want both your own `localhost` access and the LAN IP to work at
once (useful for testing from the host machine itself before kids join). This has to match **exactly**
what's in the browser's address bar, including the port.

## 5. Secrets

Same requirements as any deployment (see CLAUDE.md §7 / DEPLOY.md) — self-hosting on your own machine
doesn't relax these:

- **`JOIN_CODE_PEPPER`** — without this set, codes are hashed with a hardcoded, publicly-known
  fallback value (fine for solo dev, prints a loud warning) — not acceptable once real children's join
  codes are involved, even on a home network. Generate one with `openssl rand -hex 32`.
- **`ADMIN_PASSWORD_HASH`** — run `npm run hash-admin-password -w server -- "<a real password>"` and
  use the printed hash. Without it, `/admin` is simply unreachable.

Keep both values somewhere durable (a password manager, a local `.env` file **that stays out of
git** — check `.gitignore` covers it before creating one) so you're not regenerating them every
session; regenerating `JOIN_CODE_PEPPER` in particular invalidates every previously-issued code.

## 6. Beyond your own WiFi (optional, more advanced)

If a child isn't on your home network, same-WiFi hosting won't reach them. Options, roughly in order
of how much extra complexity they add:

- **Don't** — same-WiFi-only is the simplest and most private option, and matches how a lot of local,
  supervised play (e.g., everyone actually together in the same room/house) naturally works anyway.
- **A tunnel** (e.g., Cloudflare Tunnel, ngrok) — exposes your locally-running server through a public
  URL without opening any ports on your router. Set `ALLOWED_ORIGIN` to match whatever URL the tunnel
  assigns. Free tiers of these services often assign a new random URL each time you start the tunnel,
  so you'd hand out a fresh link each session unless you pay for a fixed subdomain.
- **Router port forwarding** — exposes your home network's port directly to the internet. This is the
  most exposed option (a port on your home router reachable by anyone who finds it, not just people
  you gave a URL to) and isn't recommended for this project without a clearer need for it.

## 7. Switching back to Railway later

Nothing about self-hosting is a one-way door. `railway.json` and DEPLOY.md are complete and were
verified locally (Phase 6) — the code doesn't care whether it's run on your laptop or a Railway
container. When it's time for always-on hosting again, follow DEPLOY.md from the top; nothing here
needs to be undone first.
