import * as THREE from 'three';
import { BLOCKS, PROTOCOL_VERSION, decodeChunk, worldToChunk } from '@game/shared';
import { Net } from './net.js';
import { ClientWorld } from './world.js';
import { ChunkRenderer } from './chunkRenderer.js';
import { PlayerController } from './controls.js';
import { raycastVoxel } from './raycast.js';
import { RemotePlayers } from './remotePlayers.js';

const statusEl = document.getElementById('app');
if (!statusEl) throw new Error('missing #app element');
statusEl.textContent = `Connecting… (protocol v${PROTOCOL_VERSION})`;

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

const displayName = `Player${Math.floor(Math.random() * 1000)}`;

let joined = false;

const net = new Net(displayName, {
  onOpen: () => {
    statusEl.textContent = 'Connected';
  },
  onClose: () => {
    statusEl.textContent = 'Disconnected — reload to reconnect';
    joined = false;
  },
  onError: (msg) => {
    console.error('[server error]', msg.message);
  },
  onWorldState: (msg) => {
    for (const chunk of msg.chunks) {
      const blocks = decodeChunk(base64ToBytes(chunk.data));
      world.setChunk(chunk.chunkX, chunk.chunkZ, blocks);
      chunkRenderer.updateChunk(chunk.chunkX, chunk.chunkZ, blocks);
    }
    controller.setSpawn(msg.spawn.x, msg.spawn.y, msg.spawn.z);
    statusEl.textContent = `Connected as ${msg.selfName}`;
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
});

renderer.domElement.addEventListener('mousedown', (event) => {
  if (document.pointerLockElement !== renderer.domElement) return;

  const origin = camera.getWorldPosition(new THREE.Vector3());
  const direction = camera.getWorldDirection(new THREE.Vector3());
  const hit = raycastVoxel(origin, direction, world);
  if (!hit) return;

  if (event.button === 0) {
    net.send({ type: 'block-update-intent', x: hit.x, y: hit.y, z: hit.z, blockId: BLOCKS.AIR.id });
  } else if (event.button === 2) {
    const px = hit.x + hit.normal.x;
    const py = hit.y + hit.normal.y;
    const pz = hit.z + hit.normal.z;
    net.send({ type: 'block-update-intent', x: px, y: py, z: pz, blockId: PLACEMENT_BLOCK });
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
    net.send({
      type: 'player-move',
      position: { x: state.x, y: state.y, z: state.z },
      yaw: state.yaw,
      pitch: state.pitch,
    });
  }

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
