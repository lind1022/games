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
import { GameDb } from './db.js';
import { TokenBucket } from './rateLimit.js';
import { World, WORLD_CHUNKS, WORLD_SIZE } from './world.js';

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

interface Connection {
  id: string;
  displayName: string;
  socket: WebSocket;
  rateLimiter: TokenBucket;
  moveLimiter: TokenBucket;
  position: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  lastMoveAt: number;
}

const connections = new Map<WebSocket, Connection>();

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

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (socket) => {
  let joined = false;

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

      // Dev-stub identity (Phases 1-3): `code` is present but unvalidated
      // per contract #9; the client-supplied `name` is trusted directly.
      // Phase 4 replaces this with a real join-code lookup.
      const displayName = message.name?.trim() || `Player${Math.floor(Math.random() * 10000)}`;
      const conn: Connection = {
        id: randomUUID(),
        displayName,
        socket,
        rateLimiter: new TokenBucket(),
        moveLimiter: new TokenBucket(),
        position: { ...SPAWN },
        yaw: 0,
        pitch: 0,
        lastMoveAt: Date.now(),
      };

      // Snapshot before registering the new connection, so it doesn't get
      // announced to itself below.
      const existing = [...connections.values()];

      connections.set(socket, conn);
      joined = true;

      console.log(`[join] ${displayName} (${conn.id})`);

      send(socket, {
        type: 'world-state',
        chunks: chunksForWorldState(),
        spawn: SPAWN,
        selfId: conn.id,
        selfName: displayName,
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
    }
  });

  socket.on('close', () => {
    const conn = connections.get(socket);
    if (conn) {
      console.log(`[leave] ${conn.displayName} (${conn.id})`);
      connections.delete(socket);
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
