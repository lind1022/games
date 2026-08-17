import * as THREE from 'three';
import { BLOCKS, PROTOCOL_VERSION, decodeChunk, worldToChunk } from '@game/shared';
import { Net, type JoinPayload } from './net.js';
import { ClientWorld } from './world.js';
import { ChunkRenderer } from './chunkRenderer.js';
import { PlayerController } from './controls.js';
import { raycastVoxel } from './raycast.js';
import { RemotePlayers } from './remotePlayers.js';

const SESSION_TOKEN_KEY = 'sessionToken';

const statusElMaybe = document.getElementById('app');
if (!statusElMaybe) throw new Error('missing #app element');
const statusEl: HTMLElement = statusElMaybe;
statusEl.textContent = `Loading… (protocol v${PROTOCOL_VERSION})`;

const chatLogElMaybe = document.getElementById('chat-log');
const chatInputElMaybe = document.getElementById('chat-input') as HTMLInputElement | null;
if (!chatLogElMaybe || !chatInputElMaybe) throw new Error('missing chat UI elements');
const chatLogEl: HTMLElement = chatLogElMaybe;
const chatInputEl: HTMLInputElement = chatInputElMaybe;

const joinScreenElMaybe = document.getElementById('join-screen');
const joinCodeInputElMaybe = document.getElementById('join-code-input') as HTMLInputElement | null;
const joinSubmitElMaybe = document.getElementById('join-submit');
const joinErrorElMaybe = document.getElementById('join-error');
if (!joinScreenElMaybe || !joinCodeInputElMaybe || !joinSubmitElMaybe || !joinErrorElMaybe) {
  throw new Error('missing join screen elements');
}
const joinScreenEl: HTMLElement = joinScreenElMaybe;
const joinCodeInputEl: HTMLInputElement = joinCodeInputElMaybe;
const joinSubmitEl: HTMLElement = joinSubmitElMaybe;
const joinErrorEl: HTMLElement = joinErrorElMaybe;

const MAX_CHAT_LINES = 50;
function appendChatLine(line: HTMLElement): void {
  chatLogEl.appendChild(line);
  while (chatLogEl.childElementCount > MAX_CHAT_LINES) {
    chatLogEl.removeChild(chatLogEl.firstChild!);
  }
}

function appendChatMessage(from: string, text: string): void {
  const line = document.createElement('div');
  const fromSpan = document.createElement('span');
  fromSpan.className = 'from';
  fromSpan.textContent = `${from}: `;
  line.appendChild(fromSpan);
  line.appendChild(document.createTextNode(text));
  appendChatLine(line);
}

// Surfaces server rejections (rate limit, chat mute, reach/bounds checks,
// etc.) in the chat log instead of only the devtools console — CLAUDE.md
// §7 flags silent failure as the wrong default for a children's product.
function appendSystemMessage(text: string): void {
  const line = document.createElement('div');
  line.className = 'system';
  line.textContent = `⚠ ${text}`;
  appendChatLine(line);
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 1000);
camera.rotation.order = 'YXZ';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(50, 100, 25);
scene.add(sun);

const world = new ClientWorld();
const chunkRenderer = new ChunkRenderer(scene);
const controller = new PlayerController(renderer.domElement, camera, world);
const remotePlayers = new RemotePlayers(scene);

const PLACEMENT_BLOCK = BLOCKS.STONE.id;
const MOVE_SEND_INTERVAL_MS = 1000 / 12; // 12 Hz, within PLAN.md's 10-15 Hz target

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Real identity (PLAN.md Phase 4): the only source of a display name is a
// successful join, resolved server-side from a code or a resumed session —
// the client never invents or supplies one. `net` doesn't exist until the
// first join attempt starts, and a fresh attempt replaces it entirely
// (the server closes the socket on any join failure, so there's nothing to
// reuse — see index.ts's join handling).
let net: Net | undefined;
let joined = false;

function attemptJoin(payload: JoinPayload): void {
  joinSubmitEl.setAttribute('aria-disabled', 'true');
  joinCodeInputEl.disabled = true;
  joinErrorEl.textContent = '';
  statusEl.textContent = 'Connecting…';

  // A server-sent `error` (onError) is always followed by the server
  // closing the socket (onClose) moments later. This flag stops onClose's
  // generic fallback message from stomping the specific one onError just
  // showed — it only kicks in for closes onError never got a chance to
  // explain (transport-level failures: server unreachable, tunnel down,
  // a network hiccup during the handshake).
  let failureHandled = false;

  function resetJoinForm(message: string): void {
    if ('sessionToken' in payload) {
      localStorage.removeItem(SESSION_TOKEN_KEY);
    }
    joinSubmitEl.removeAttribute('aria-disabled');
    joinCodeInputEl.disabled = false;
    joinErrorEl.textContent = message;
    joinScreenEl.classList.remove('hidden');
    statusEl.textContent = `Loading… (protocol v${PROTOCOL_VERSION})`;
  }

  net = new Net(payload, {
    onOpen: () => {
      statusEl.textContent = 'Connecting…';
    },
    onClose: () => {
      const wasJoined = joined;
      joined = false;
      if (wasJoined) {
        statusEl.textContent = 'Disconnected — reload to reconnect';
        return;
      }
      if (failureHandled) return; // onError already explained this and reset the form
      // The connection closed before we ever got world-state, and without
      // a server-sent error first — a transport-level failure. Without
      // this, the join form is left disabled with no explanation at all —
      // exactly a silent "nothing happens when I click Join" bug.
      resetJoinForm('Could not connect — please check your connection and try again.');
    },
    onError: (msg) => {
      console.error('[server error]', msg.message);
      if (joined) {
        appendSystemMessage(msg.message);
        return;
      }
      failureHandled = true;
      // A join attempt failed. If it was a stored-session resume, the
      // token is stale (expired/revoked/superseded) — drop it and fall
      // back to asking for a fresh code rather than retrying it forever.
      resetJoinForm(msg.message);
      joinCodeInputEl.value = '';
      joinCodeInputEl.focus();
    },
    onWorldState: (msg) => {
      for (const chunk of msg.chunks) {
        const blocks = decodeChunk(base64ToBytes(chunk.data));
        world.setChunk(chunk.chunkX, chunk.chunkZ, blocks);
        chunkRenderer.updateChunk(chunk.chunkX, chunk.chunkZ, blocks);
      }
      controller.setSpawn(msg.spawn.x, msg.spawn.y, msg.spawn.z);
      localStorage.setItem(SESSION_TOKEN_KEY, msg.sessionToken);
      statusEl.textContent = `Connected as ${msg.selfName}`;
      joinScreenEl.classList.add('hidden');
      joined = true;
    },
    onBlockUpdate: (msg) => {
      // Applied only on the server's broadcast — the client never writes
      // locally (PLAN.md Phase 1: proves server authority).
      world.setBlock(msg.x, msg.y, msg.z, msg.blockId);
      const { chunkX, chunkZ } = worldToChunk(msg.x, msg.z);
      const blocks = world.getChunkBlocks(chunkX, chunkZ);
      if (blocks) chunkRenderer.updateChunk(chunkX, chunkZ, blocks);
    },
    onPlayerJoin: () => {
      // Announcement only — the entity is created lazily by the first
      // player-state (which carries position and name), see onPlayerState.
    },
    onPlayerLeave: (msg) => {
      remotePlayers.remove(msg.id);
    },
    onPlayerState: (msg) => {
      if (!remotePlayers.has(msg.id)) {
        remotePlayers.add(msg.id, msg.name, msg.position.x, msg.position.y, msg.position.z, msg.yaw);
      } else {
        remotePlayers.updateState(msg.id, msg.position.x, msg.position.y, msg.position.z, msg.yaw);
      }
    },
    onChatMessage: (msg) => {
      appendChatMessage(msg.from, msg.text);
    },
  });
}

function submitJoinCode(): void {
  const code = joinCodeInputEl.value.trim();
  if (!code) return;
  attemptJoin({ code });
}

joinSubmitEl.addEventListener('click', submitJoinCode);
joinCodeInputEl.addEventListener('keydown', (event) => {
  if (event.code === 'Enter') submitJoinCode();
});

const storedToken = localStorage.getItem(SESSION_TOKEN_KEY);
if (storedToken) {
  joinScreenEl.classList.add('hidden');
  attemptJoin({ sessionToken: storedToken });
} else {
  joinScreenEl.classList.remove('hidden');
  joinCodeInputEl.focus();
}

// Minimal chat UI (CLAUDE.md §3: plain DOM overlay, not React). Enter opens
// the input and releases pointer lock; Enter again sends and re-locks;
// Escape cancels without sending. Movement input is disabled while typing
// so "wasd" in a message doesn't also walk the player (see
// PlayerController.setInputEnabled).
let chatOpen = false;

function openChat(): void {
  if (chatOpen) return;
  chatOpen = true;
  document.exitPointerLock();
  controller.setInputEnabled(false);
  chatInputEl.classList.add('visible');
  chatInputEl.value = '';
  chatInputEl.focus();
}

function closeChat(): void {
  chatOpen = false;
  chatInputEl.classList.remove('visible');
  chatInputEl.blur();
  controller.setInputEnabled(true);
  renderer.domElement.requestPointerLock();
}

window.addEventListener('keydown', (event) => {
  if (!chatOpen && event.code === 'Enter' && joined) {
    event.preventDefault();
    openChat();
  }
});

chatInputEl.addEventListener('keydown', (event) => {
  event.stopPropagation();
  if (event.code === 'Enter') {
    const text = chatInputEl.value.trim();
    if (text.length > 0) net?.send({ type: 'chat-message', text });
    closeChat();
  } else if (event.code === 'Escape') {
    closeChat();
  }
});

renderer.domElement.addEventListener('mousedown', (event) => {
  if (document.pointerLockElement !== renderer.domElement) return;

  const origin = camera.getWorldPosition(new THREE.Vector3());
  const direction = camera.getWorldDirection(new THREE.Vector3());
  const hit = raycastVoxel(origin, direction, world);
  if (!hit) return;

  if (event.button === 0) {
    net?.send({ type: 'block-update-intent', x: hit.x, y: hit.y, z: hit.z, blockId: BLOCKS.AIR.id });
  } else if (event.button === 2) {
    const px = hit.x + hit.normal.x;
    const py = hit.y + hit.normal.y;
    const pz = hit.z + hit.normal.z;
    net?.send({ type: 'block-update-intent', x: px, y: py, z: pz, blockId: PLACEMENT_BLOCK });
  }
});

renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());

let lastTime = performance.now();
let lastMoveSend = 0;
function tick(now: number): void {
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  controller.update(dt);
  remotePlayers.tick();
  renderer.render(scene, camera);

  if (joined && now - lastMoveSend >= MOVE_SEND_INTERVAL_MS) {
    lastMoveSend = now;
    const state = controller.getState();
    net?.send({
      type: 'player-move',
      position: { x: state.x, y: state.y, z: state.z },
      yaw: state.yaw,
      pitch: state.pitch,
    });
  }

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
