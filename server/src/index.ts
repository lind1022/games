import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
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

interface Connection {
  id: string;
  displayName: string;
  socket: WebSocket;
  rateLimiter: TokenBucket;
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

function chunksForWorldState(): ChunkData[] {
  return world.allChunks().map(({ chunkX, chunkZ, blocks }) => ({
    chunkX,
    chunkZ,
    formatVersion: 1,
    data: Buffer.from(encodeChunk(blocks)).toString('base64'),
  }));
}

const httpServer = createServer((_req, res) => {
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
      };
      connections.set(socket, conn);
      joined = true;

      console.log(`[join] ${displayName} (${conn.id})`);

      send(socket, {
        type: 'world-state',
        chunks: chunksForWorldState(),
        spawn: { x: WORLD_SIZE / 2, y: 1, z: WORLD_SIZE / 2 },
        selfId: conn.id,
        selfName: displayName,
      });
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

      // Reach-distance validation is deferred to Phase 2, which introduces
      // player-move and gives the server a trusted position to check
      // against (see PLAN.md Phase 1). Bounds + known-id are Phase 1's job.

      world.setBlock(x, y, z, blockId, conn.displayName);

      broadcast({
        type: 'block-update',
        x,
        y,
        z,
        blockId,
        by: conn.displayName,
      });
    }
  });

  socket.on('close', () => {
    const conn = connections.get(socket);
    if (conn) {
      console.log(`[leave] ${conn.displayName} (${conn.id})`);
      connections.delete(socket);
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
