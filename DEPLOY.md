# DEPLOY.md

How to deploy this to Railway. This is a durable reference — unlike HANDOFF.md, it shouldn't go stale
as work progresses, only as the deploy process itself changes.

**Status: not yet deployed.** Everything below has been written and locally verified (see HANDOFF.md
Phase 6), but nobody has run through this checklist against a real Railway account yet — that step
needs the product owner, since it requires account creation and possibly billing.

---

## 1. One-time setup

1. **Create a Railway account** at railway.app if you don't have one, and a new empty project.
2. **Connect this GitHub repo** to the project (Railway → New Service → GitHub Repo). Railway will
   auto-detect Node.js via Nixpacks; `railway.json` (checked into the repo root) tells it exactly how
   to build and run this monorepo — you shouldn't need to configure build/start commands by hand.
3. **Attach a volume.** In the service's Settings → Volumes, add a volume and mount it somewhere like
   `/data`. This is where the SQLite database lives, and the entire point of a mounted volume instead
   of the container's own ephemeral disk is that it survives redeploys.
4. **Set environment variables** (service Settings → Variables):
   - `DATA_DIR` — the exact path you mounted the volume at (e.g. `/data`). **Never hardcode this in
     code** — the server already reads it from this env var everywhere.
   - `JOIN_CODE_PEPPER` — a long random secret. Generate one locally, e.g. `openssl rand -hex 32`.
     Without this set, the server falls back to a hardcoded insecure default and prints a loud warning
     on boot — fine for local dev, **not acceptable for anywhere a real child's join code lives.**
   - `ADMIN_PASSWORD_HASH` — run `npm run hash-admin-password -w server -- "<a real password>"`
     locally, and paste the printed hash here. The admin panel (`/admin`) is unreachable until this is
     set.
   - `ALLOWED_ORIGIN` — once you know the real public URL Railway assigns (or your own domain, if you
     set one up), set this to it, e.g. `https://your-app.up.railway.app`. Until this is set, only the
     hardcoded local dev origins are allowed to open a WebSocket connection — **the app will not work
     from the public URL until you set this.**
   - `PORT` is set automatically by Railway; the server already reads it and binds `0.0.0.0`.
5. **Set the health check.** `railway.json` already points Railway at `GET /health` with a 30s
   timeout and `restartPolicyType: ALWAYS` — check the dashboard reflects this after the first deploy
   in case Railway's UI needs it confirmed manually.

## 2. Deploying

Push to the branch Railway is watching (or trigger a manual deploy from the dashboard). Railway runs
`npm install && npm run build` (per `railway.json`), which builds the client (`vite build` →
`client/dist`); then `npm start`, which runs the server directly from TypeScript source via `tsx` —
there is no separate server build step by design (see CLAUDE.md §8). The server serves the built
client itself, so the whole app — game client, WebSocket, admin panel — is one process on one port.

## 3. Post-deploy verification checklist

PLAN.md Phase 6's actual "done when" criteria need a real deployment to check at all — do these once,
right after the first successful deploy, before trusting this with anything real:

- [ ] Visit the public URL. The join screen loads (confirms the client build + static serving works).
- [ ] Create a join code via `/admin` (after logging in) and actually join with it — confirms WSS
      (WebSocket over TLS) works through Railway's proxy, not just plain WS locally.
- [ ] **Canary check**: place a block, note where. Trigger a redeploy (push an empty commit, or use
      Railway's "Redeploy" button). After it comes back up, reconnect and confirm the block is still
      there. This is the single check PLAN.md's risk table calls out as most important — if the volume
      isn't really mounted, this is exactly what would silently fail.
- [ ] Kill the process mid-session (Railway → Restart, or similar) while a block is mid-placement, and
      confirm nothing already-committed was lost on restart.
- [ ] Confirm `restartPolicyType: ALWAYS` actually restarts the service if `/health` starts failing
      (e.g., temporarily point `DATA_DIR` at something unwritable and watch it happen, then fix it).

## 4. Backups

`db.backup()` runs automatically every 6h (in-process `setInterval` in `index.ts`) and writes a
`VACUUM INTO` snapshot to `DATA_DIR/backups/` — **on the same volume as the live database.** This
protects against application-level corruption or a bad migration, but **not** against the volume
itself failing, which would take the live DB and every backup together.

**Not yet done:** shipping these backups off-box (R2, S3, or similar) needs cloud storage credentials
this project doesn't have configured yet. Until that's wired up, treat the automatic backups as a
convenience, not real disaster recovery — consider manually copying `DATA_DIR/backups/*.db` off the
volume periodically (e.g. `railway run` + `scp`, or Railway's own volume backup feature if enabled)
until proper off-box shipping is built.

**Rehearsing a restore:** a backup file is just a regular standalone SQLite database — open it with
the same `GameDb` class locally (`new GameDb('/path/to/backup.db')`) to inspect or use it directly. To
actually restore one into production, stop the service, replace the file at `DATA_DIR/world.db` with
the backup (renamed), and restart. This has been rehearsed **locally only** (HANDOFF.md Phase 6) —
not yet against a real Railway volume.

## 5. Known gaps

- Backups are local-only (see §4).
- The dirty-chunk-flush / crash-recovery-replay optimization from PLAN.md C6 was deliberately skipped
  (see HANDOFF.md Phase 6) — pure write-through already makes every change durable immediately, which
  is correct at this project's scale; revisit only if a real performance problem shows up.
- `chatFilter.ts`'s `WHITELIST` is empty. Seed it with every real child's display name and any
  school-specific vocabulary **before** real codes go out — PLAN.md calls this a critical pre-launch
  step, and it hasn't been done because no real names exist yet.
