import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ADMIN_SESSION_COOKIE,
  createAdminSession,
  destroyAdminSession,
  isValidAdminSession,
  verifyAdminPassword,
} from './adminAuth.js';
import type { GameDb } from './db.js';
import { TokenBucket } from './rateLimit.js';

/**
 * `/admin/api/*` — the moderation surface PLAN.md Phase 5 calls for: code
 * management and moderation without shell access, for an admin who is
 * usually offline. Hand-rolled routing over Node's `http` module (no
 * framework) — a handful of routes doesn't need one, and it keeps the
 * server's dependency footprint the same as it's been since Phase 0.
 *
 * Every route except login is gated on a valid `ADMIN_SESSION_COOKIE`.
 */

export interface OnlinePlayer {
  id: string;
  name: string;
}

export interface AdminDeps {
  db: GameDb;
  getOnlinePlayers(): OnlinePlayer[];
  /** Returns true if a live connection with this id was found and closed. */
  kickPlayer(id: string): boolean;
  /** Toggles the mute on the code and, if a live connection exists, tells the child. */
  mutePlayerByCode(codeHash: string, muted: boolean): void;
  /** Disables the code, revokes its session, and kicks any live connection. */
  revokeCode(codeHash: string): void;
  /** Revokes the old code and issues a fresh one for the same display name; undefined if not found. */
  reissueCode(codeHash: string): { code: string; displayName: string } | undefined;
  /** Restores a player's edits from the last N minutes; returns how many blocks were touched. */
  rollbackPlayer(displayName: string, minutes: number): number;
}

// Login attempts (PLAN.md Phase 5: "rate-limited — an unauthenticated
// admin panel is worse than none"). Same shape as the join-code limiter.
const LOGIN_RATE_CAPACITY = 5;
const LOGIN_RATE_REFILL_PER_SECOND = 5 / (15 * 60);
const loginRateLimiters = new Map<string, TokenBucket>();
function loginLimiterFor(ip: string): TokenBucket {
  let bucket = loginRateLimiters.get(ip);
  if (!bucket) {
    bucket = new TokenBucket(LOGIN_RATE_CAPACITY, LOGIN_RATE_REFILL_PER_SECOND);
    loginRateLimiters.set(ip, bucket);
  }
  return bucket;
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
      if (raw.length > 10_000) req.destroy(); // trivial abuse guard
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function setSessionCookie(res: ServerResponse, token: string): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/admin${secure}; Max-Age=${12 * 60 * 60}`
  );
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('Set-Cookie', `${ADMIN_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`);
}

/** Returns true if this request was for `/admin/api/*` and has been fully handled. */
export async function handleAdminApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/admin/api/')) return false;

  const path = url.pathname.slice('/admin/api'.length); // e.g. '/login', '/codes/<hash>/revoke'
  const cookies = parseCookies(req);
  const sessionToken = cookies[ADMIN_SESSION_COOKIE];

  if (path === '/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!loginLimiterFor(ip).tryConsume()) {
      sendJson(res, 429, { error: 'Too many attempts — please try again later.' });
      return true;
    }
    const body = (await readJsonBody(req).catch(() => ({}))) as { password?: unknown };
    const password = typeof body.password === 'string' ? body.password : '';
    const ok = await verifyAdminPassword(password);
    if (!ok) {
      sendJson(res, 401, { error: 'Incorrect password.' });
      return true;
    }
    const token = createAdminSession();
    setSessionCookie(res, token);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === '/session' && req.method === 'GET') {
    sendJson(res, 200, { authenticated: isValidAdminSession(sessionToken) });
    return true;
  }

  if (path === '/logout' && req.method === 'POST') {
    destroyAdminSession(sessionToken);
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (!isValidAdminSession(sessionToken)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return true;
  }

  if (path === '/codes' && req.method === 'GET') {
    sendJson(res, 200, deps.db.listJoinCodes());
    return true;
  }

  if (path === '/codes' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as { displayName?: unknown };
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!displayName) {
      sendJson(res, 400, { error: 'displayName is required' });
      return true;
    }
    const code = deps.db.createJoinCode(displayName);
    sendJson(res, 200, { code, displayName });
    return true;
  }

  const revokeMatch = path.match(/^\/codes\/([^/]+)\/revoke$/);
  if (revokeMatch && req.method === 'POST') {
    deps.revokeCode(decodeURIComponent(revokeMatch[1]!));
    sendJson(res, 200, { ok: true });
    return true;
  }

  const reissueMatch = path.match(/^\/codes\/([^/]+)\/reissue$/);
  if (reissueMatch && req.method === 'POST') {
    const result = deps.reissueCode(decodeURIComponent(reissueMatch[1]!));
    if (!result) {
      sendJson(res, 404, { error: 'code not found' });
      return true;
    }
    sendJson(res, 200, result);
    return true;
  }

  const muteMatch = path.match(/^\/codes\/([^/]+)\/mute$/);
  if (muteMatch && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as { muted?: unknown };
    const muted = body.muted !== false; // default true: this endpoint's purpose is to mute
    deps.mutePlayerByCode(decodeURIComponent(muteMatch[1]!), muted);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === '/players' && req.method === 'GET') {
    sendJson(res, 200, deps.getOnlinePlayers());
    return true;
  }

  const kickMatch = path.match(/^\/players\/([^/]+)\/kick$/);
  if (kickMatch && req.method === 'POST') {
    const found = deps.kickPlayer(decodeURIComponent(kickMatch[1]!));
    sendJson(res, found ? 200 : 404, { ok: found });
    return true;
  }

  if (path === '/chat-log' && req.method === 'GET') {
    const flaggedOnly = url.searchParams.get('flagged') === '1';
    const displayName = url.searchParams.get('player') ?? undefined;
    const limitParam = Number(url.searchParams.get('limit'));
    const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : undefined;
    sendJson(res, 200, deps.db.getChatLog({ flaggedOnly, displayName, limit }));
    return true;
  }

  if (path === '/rollback' && req.method === 'POST') {
    const body = (await readJsonBody(req).catch(() => ({}))) as { displayName?: unknown; minutes?: unknown };
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    const minutes = typeof body.minutes === 'number' && body.minutes > 0 ? body.minutes : NaN;
    if (!displayName || Number.isNaN(minutes)) {
      sendJson(res, 400, { error: 'displayName and a positive minutes are required' });
      return true;
    }
    const restored = deps.rollbackPlayer(displayName, minutes);
    sendJson(res, 200, { restored });
    return true;
  }

  sendJson(res, 404, { error: 'not found' });
  return true;
}
