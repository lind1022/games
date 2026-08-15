import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@game/shared';

// Full join/message handling lands in Phase 1 (see PLAN.md) — this is
// just the WS plumbing that Phase 0 needs to prove out.

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (socket) => {
  console.log('[ws] client connected');

  socket.on('close', () => {
    console.log('[ws] client disconnected');
  });
});

httpServer.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT} (protocol v${PROTOCOL_VERSION})`);
});
