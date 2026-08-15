import { PROTOCOL_VERSION } from '@game/shared';

// Real rendering, controls, and the join/protocol handshake land in
// Phase 1 (see PLAN.md) — this just proves the dev pipeline (Vite +
// the /ws proxy to the server) actually works end to end.

const statusEl = document.getElementById('app');
if (!statusEl) {
  throw new Error('missing #app element');
}

statusEl.textContent = `Connecting… (protocol v${PROTOCOL_VERSION})`;

const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
const socket = new WebSocket(`${wsProtocol}://${location.host}/ws`);

socket.addEventListener('open', () => {
  statusEl.textContent = `Connected (protocol v${PROTOCOL_VERSION})`;
  console.log('[ws] connected');
});

socket.addEventListener('close', () => {
  statusEl.textContent = 'Disconnected';
  console.log('[ws] disconnected');
});

socket.addEventListener('error', (event) => {
  console.error('[ws] error', event);
});
