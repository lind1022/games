import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PLAYER_EYE_HEIGHT,
  PROTOCOL_VERSION,
  REACH_DISTANCE,
  WORLD_HEIGHT,
  clientMessageSchema,
  encodeChunk,
  isKnownBlockId,
  type ChunkData,
  type ServerMessage,
} from '@game/shared';
import { filterChatMessage } from './chatFilter.js';
import { GameDb } from './db.js';
import { TokenBucket } from './rateLimit.js';
import { World, WORLD_CHUNKS, WORLD_SIZE } from './world.js';

// Origin validation (PLAN.md Phase 4): defense-in-depth, not the primary
// guard — this app deliberately keeps the session token in localStorage
// rather than a cookie specifically so there's no ambient auth for a
// cross-origin page to ride on, which is the attack Origin-checking
// normally exists to stop. Missing-Origin requests are allowed through
// (real browsers always send Origin on a WS upgrade; only non-browser
// clients, e.g. this project's own test scripts, omit it).
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGIN
  ? [process.env.ALLOWED_ORIGIN]
  : ['http://localhost:5173', 'http://localhost:8787'];

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../');
const DATA_DIR = process.env.DATA_DIR ?? path.join(REPO_ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'world.db');

mkdirSync(DATA_DIR, { recursive: true });

const db = new GameDb(DB_PATH);
const world = new World(db);

const SPAWN = { x: WORLD_SIZE / 2, y: 1, z: WORLD_SIZE / 2 };

// Loose movement sanity checks only (PLAN.md Phase 2) — there's no client
// prediction to reconcile against, and a school wifi hiccup produces the
// exact same symptom as a speed-hack attempt, so bad reports are dropped
// (not trusted, not rebroadcast) rather than punished.
const MAX_HORIZONTAL_SPEED = 8; // m/s — client caps at 4.5; generous headroom for jitter
const SPEED_TOLERANCE = 1; // flat allowance on top, for clock/frame variance
const POSITION_BOUNDS_MARGIN = 4; // blocks of slack around the world box
const REACH_TOLERANCE = 2; // blocks — position is only as fresh as the last player-move tick

// Chat safety (PLAN.md Phase 3 / CLAUDE.md §7). No auto-mute on a first
// offense — only after repeated flags in a short window, and even then it's
// a short cooldown, never a kick. A single flagged message is very often a
// false positive (see chatFilter.ts); repeated flags are a stronger signal.
const CHAT_RATE_CAPACITY = 5;
const CHAT_RATE_REFILL_PER_SECOND = 0.5; // 1 message per 2s sustained
const CHAT_FLAG_WINDOW_MS = 10 * 60 * 1000;
const CHAT_FLAG_THRESHOLD = 5;
const CHAT_MUTE_DURATION_MS = 60 * 1000;

// Join-code entry rate limiting (PLAN.md Phase 4): 5 attempts per 15 min
// per IP. Only counts fresh *code* entry (guessing) — resuming an existing
// session via a stored token isn't an attempt to guess anything and
// shouldn't burn a family's budget on every page reload.
const CODE_RATE_CAPACITY = 5;
const CODE_RATE_REFILL_PER_SECOND = 5 / (15 * 60);
const codeRateLimiters = new Map<string, TokenBucket>();

function codeRateLimiterFor(ip: string): TokenBucket {
  let bucket = codeRateLimiters.get(ip);
  if (!bucket) {
    bucket = new TokenBucket(CODE_RATE_CAPACITY, CODE_RATE_REFILL_PER_SECOND);
    codeRateLimiters.set(ip, bucket);
  }
  return bucket;
}

interface Connection {
  id: string;
  displayName: string;
  codeHash: string;
  socket: WebSocket;
  rateLimiter: TokenBucket;
  moveLimiter: TokenBucket;
  position: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  lastMoveAt: number;
  chatLimiter: TokenBucket;
  recentFlagTimestamps: number[];
  chatMutedUntil: number;
}

const connections = new Map<WebSocket, Connection>();
// One live connection per code, enforced at the application level so a
// takeover (C5) can find and close the superseded socket. The DB-level
// partial unique index (see db.ts) backs up the *session-row* invariant
// independently, in case this map and reality ever disagree.
const connectionsByCodeHash = new Map<string, Connection>();

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(message: ServerMessage): void {
  const payload = JSON.stringify(message);
  for (const conn of connections.values()) {
    if (conn.socket.readyState === conn.socket.OPEN) {
      conn.socket.send(payload);
    }
  }
}

function broadcastExcept(exclude: WebSocket, message: ServerMessage): void {
  const payload = JSON.stringify(message);
  for (const conn of connections.values()) {
    if (conn.socket !== exclude && conn.socket.readyState === conn.socket.OPEN) {
      conn.socket.send(payload);
    }
  }
}

function playerStateMessage(conn: Connection): ServerMessage {
  return {
    type: 'player-state',
    id: conn.id,
    name: conn.displayName,
    position: conn.position,
    yaw: conn.yaw,
    pitch: conn.pitch,
  };
}

function chunksForWorldState(): ChunkData[] {
  return world.allChunks().map(({ chunkX, chunkZ, blocks }) => ({
    chunkX,
    chunkZ,
    formatVersion: 1,
    data: Buffer.from(encodeChunk(blocks)).toString('base64'),
  }));
}

const httpServer = createServer((req, res) => {
  // Unauthenticated on purpose for now: display names are already visible to
  // every connected player via player-join/player-state, so this adds no new
  // exposure. Phase 5's admin panel gates the real moderation surface behind
  // real auth — this is just the "near-free" plumbing PLAN.md Phase 2 flags.
  if (req.method === 'GET' && req.url === '/players') {
    const online = [...connections.values()].map((c) => ({ id: c.id, name: c.displayName }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(online));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});

const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  verifyClient: (info, callback) => {
    const origin = info.origin;
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(true);
    } else {
      callback(false, 403, 'origin not allowed');
    }
  },
});

wss.on('connection', (socket, request) => {
  let joined = false;
  const ip = request.socket.remoteAddress ?? 'unknown';

  socket.on('message', (raw) => {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw.toString());
    } catch {
      send(socket, { type: 'error', message: 'malformed message' });
      return;
    }

    const result = clientMessageSchema.safeParse(parsedJson);
    if (!result.success) {
      send(socket, { type: 'error', message: 'invalid message shape' });
      return;
    }

    const message = result.data;

    if (message.type === 'join') {
      if (joined) return; // duplicate join on an already-joined socket — ignore

      if (message.protocolVersion !== PROTOCOL_VERSION) {
        send(socket, { type: 'error', message: 'Client out of date — please refresh.' });
        socket.close();
        return;
      }

      // Real identity (PLAN.md Phase 4): exactly one of code / sessionToken
      // resolves who's joining. Every failure path closes the socket —
      // simpler to reason about than a half-joined socket left open for a
      // retry, and the client just opens a fresh one to try again.
      let displayName: string;
      let codeHash: string;
      let sessionToken: string;

      if (message.sessionToken) {
        const session = db.lookupSession(message.sessionToken);
        if (!session) {
          send(socket, { type: 'error', message: 'Session expired — please enter your code again.' });
          socket.close();
          return;
        }
        db.touchSession(session.tokenHash);
        displayName = session.displayName;
        codeHash = session.codeHash;
        sessionToken = message.sessionToken;
      } else if (message.code) {
        if (!codeRateLimiterFor(ip).tryConsume()) {
          send(socket, { type: 'error', message: 'Too many attempts — please try again later.' });
          socket.close();
          return;
        }
        const found = db.lookupJoinCode(message.code);
        if (!found) {
          send(socket, { type: 'error', message: 'Invalid code.' });
          socket.close();
          return;
        }
        displayName = found.displayName;
        codeHash = found.codeHash;
        // Also revokes any existing DB session row for this code (C5).
        sessionToken = db.createSession(codeHash, displayName);
      } else {
        send(socket, { type: 'error', message: 'A code or session is required to join.' });
        socket.close();
        return;
      }

      // Session takeover (C5): at most one *live* connection per code.
      // Never reject the incoming connection over this — school wifi drops
      // constantly, and the new join always wins so a stranded child is
      // never the one locked out.
      const previous = connectionsByCodeHash.get(codeHash);
      if (previous) {
        send(previous.socket, { type: 'error', message: 'You joined from another device.' });
        previous.socket.close();
        connections.delete(previous.socket);
        connectionsByCodeHash.delete(codeHash);
        broadcast({ type: 'player-leave', id: previous.id });
      }

      const conn: Connection = {
        id: randomUUID(),
        displayName,
        codeHash,
        socket,
        rateLimiter: new TokenBucket(),
        moveLimiter: new TokenBucket(),
        position: { ...SPAWN },
        yaw: 0,
        pitch: 0,
        lastMoveAt: Date.now(),
        chatLimiter: new TokenBucket(CHAT_RATE_CAPACITY, CHAT_RATE_REFILL_PER_SECOND),
        recentFlagTimestamps: [],
        chatMutedUntil: 0,
      };

      // Snapshot before registering the new connection, so it doesn't get
      // announced to itself below.
      const existing = [...connections.values()];

      connections.set(socket, conn);
      connectionsByCodeHash.set(codeHash, conn);
      joined = true;

      console.log(`[join] ${displayName} (${conn.id})`);

      send(socket, {
        type: 'world-state',
        chunks: chunksForWorldState(),
        spawn: SPAWN,
        selfId: conn.id,
        selfName: displayName,
        sessionToken,
      });

      for (const other of existing) {
        send(socket, { type: 'player-join', id: other.id, name: other.displayName });
        send(socket, playerStateMessage(other));
      }

      broadcastExcept(socket, { type: 'player-join', id: conn.id, name: conn.displayName });
      broadcastExcept(socket, playerStateMessage(conn));
      return;
    }

    const conn = connections.get(socket);
    if (!conn) {
      send(socket, { type: 'error', message: 'join before sending other messages' });
      return;
    }

    if (message.type === 'block-update-intent') {
      if (!conn.rateLimiter.tryConsume()) {
        send(socket, { type: 'error', message: 'slow down — too many block changes' });
        return;
      }

      const { x, y, z, blockId } = message;

      if (!world.isWithinBounds(x, y, z)) {
        send(socket, { type: 'error', message: 'block out of bounds' });
        return;
      }
      if (!isKnownBlockId(blockId)) {
        send(socket, { type: 'error', message: 'unknown block type' });
        return;
      }

      // Reach-distance check (Phase 2): conn.position is only as fresh as the
      // player's last player-move tick, hence the generous tolerance — this
      // is a sanity check against wildly-out-of-range edits, not tight
      // anti-cheat (see the module-level comment on movement validation).
      const eyeY = conn.position.y + PLAYER_EYE_HEIGHT;
      const dist = Math.hypot(
        x + 0.5 - conn.position.x,
        y + 0.5 - eyeY,
        z + 0.5 - conn.position.z
      );
      if (dist > REACH_DISTANCE + REACH_TOLERANCE) {
        send(socket, { type: 'error', message: 'block out of reach' });
        return;
      }

      world.setBlock(x, y, z, blockId, conn.displayName);

      broadcast({
        type: 'block-update',
        x,
        y,
        z,
        blockId,
        by: conn.displayName,
      });
      return;
    }

    if (message.type === 'player-move') {
      if (!conn.moveLimiter.tryConsume()) return; // drop silently — no need to alarm a child over jitter

      const { x, y, z } = message.position;
      const { yaw, pitch } = message;
      const now = Date.now();
      const dt = Math.max((now - conn.lastMoveAt) / 1000, 0.001);

      const withinBounds =
        x >= -POSITION_BOUNDS_MARGIN &&
        x < WORLD_SIZE + POSITION_BOUNDS_MARGIN &&
        z >= -POSITION_BOUNDS_MARGIN &&
        z < WORLD_SIZE + POSITION_BOUNDS_MARGIN &&
        y >= -POSITION_BOUNDS_MARGIN &&
        y < WORLD_HEIGHT + POSITION_BOUNDS_MARGIN;

      const horizontalDist = Math.hypot(x - conn.position.x, z - conn.position.z);
      const maxHorizontalDist = MAX_HORIZONTAL_SPEED * dt + SPEED_TOLERANCE;

      if (!withinBounds || horizontalDist > maxHorizontalDist) {
        conn.lastMoveAt = now;
        return; // drop: don't trust or rebroadcast this position
      }

      conn.position = { x, y, z };
      conn.yaw = yaw;
      conn.pitch = pitch;
      conn.lastMoveAt = now;

      broadcastExcept(socket, playerStateMessage(conn));
      return;
    }

    if (message.type === 'chat-message') {
      const now = Date.now();

      if (now < conn.chatMutedUntil) {
        send(socket, { type: 'error', message: 'muted for a moment — try again shortly' });
        return;
      }

      if (!conn.chatLimiter.tryConsume()) {
        send(socket, { type: 'error', message: 'slow down — too many messages' });
        return;
      }

      const trimmed = message.text.trim();
      if (trimmed.length === 0) return;

      const { filteredMessage, flagged, flagReason } = filterChatMessage(trimmed);

      db.insertChatMessage({
        displayName: conn.displayName,
        message: trimmed,
        filteredMessage,
        flagged,
        flagReason,
      });

      // No auto-mute on a single flag — it's very often a false positive
      // (see chatFilter.ts). Only a burst of flags in a short window earns
      // a short cooldown, and even then it's a mute, never a kick.
      if (flagged) {
        conn.recentFlagTimestamps.push(now);
        conn.recentFlagTimestamps = conn.recentFlagTimestamps.filter(
          (t) => now - t < CHAT_FLAG_WINDOW_MS
        );
        if (conn.recentFlagTimestamps.length >= CHAT_FLAG_THRESHOLD) {
          conn.chatMutedUntil = now + CHAT_MUTE_DURATION_MS;
          conn.recentFlagTimestamps = [];
        }
      }

      // Broadcast to everyone, including the sender, so they see the same
      // (possibly masked) text everyone else does.
      broadcast({ type: 'chat-message', from: conn.displayName, text: filteredMessage });
    }
  });

  socket.on('close', () => {
    const conn = connections.get(socket);
    if (conn) {
      console.log(`[leave] ${conn.displayName} (${conn.id})`);
      connections.delete(socket);
      // Only clear the code->connection mapping if it's still pointing at
      // this connection — a takeover may have already replaced it with a
      // newer one before this (now-stale) socket's close event arrives.
      if (connectionsByCodeHash.get(conn.codeHash) === conn) {
        connectionsByCodeHash.delete(conn.codeHash);
      }
      broadcast({ type: 'player-leave', id: conn.id });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(
    `[server] listening on http://localhost:${PORT} (protocol v${PROTOCOL_VERSION}, world ${WORLD_CHUNKS}x${WORLD_CHUNKS} chunks)`
  );
});

function shutdown(): void {
  console.log('[server] shutting down');
  db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
