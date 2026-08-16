import * as THREE from 'three';

/**
 * Remote players as capsule + name label (PLAN.md Phase 2), rendered on a
 * ~100ms interpolation delay: each player keeps its two most recent network
 * snapshots and `tick()` renders the position between them at "now minus the
 * buffer", trading a little latency for smooth motion despite the 10-15Hz
 * update rate. No prediction/reconciliation — this game has no fairness
 * problem that would justify it (PLAN.md Phase 2).
 */

const INTERP_DELAY_MS = 100;
const CAPSULE_RADIUS = 0.3;
const CAPSULE_HEIGHT = 1.8; // cosmetic match for controls.ts's PLAYER_HEIGHT — not a shared contract

interface Snapshot {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface Entity {
  group: THREE.Group;
  capsule: THREE.Mesh;
  label: THREE.Sprite;
  snapshots: Snapshot[]; // oldest first, capped at 2
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function playerColor(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return new THREE.Color(`hsl(${hash % 360}, 65%, 55%)`).getHex();
}

function makeLabel(name: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 32px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'black';
  ctx.strokeText(name, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = 'white';
  ctx.fillText(name, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
  sprite.scale.set(1.6, 0.4, 1);
  sprite.position.y = CAPSULE_HEIGHT + 0.35;
  return sprite;
}

export class RemotePlayers {
  private readonly entities = new Map<string, Entity>();

  constructor(private readonly scene: THREE.Scene) {}

  has(id: string): boolean {
    return this.entities.has(id);
  }

  add(id: string, name: string, x: number, y: number, z: number, yaw: number): void {
    if (this.entities.has(id)) return;

    const capsule = new THREE.Mesh(
      new THREE.CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2 * CAPSULE_RADIUS, 4, 8),
      new THREE.MeshLambertMaterial({ color: playerColor(id) })
    );
    capsule.position.y = CAPSULE_HEIGHT / 2;

    const label = makeLabel(name);

    const group = new THREE.Group();
    group.add(capsule, label);
    group.position.set(x, y, z);
    group.rotation.y = yaw;
    this.scene.add(group);

    this.entities.set(id, { group, capsule, label, snapshots: [{ t: performance.now(), x, y, z, yaw }] });
  }

  remove(id: string): void {
    const entity = this.entities.get(id);
    if (!entity) return;

    this.scene.remove(entity.group);
    entity.capsule.geometry.dispose();
    (entity.capsule.material as THREE.Material).dispose();
    const labelMaterial = entity.label.material as THREE.SpriteMaterial;
    labelMaterial.map?.dispose();
    labelMaterial.dispose();

    this.entities.delete(id);
  }

  updateState(id: string, x: number, y: number, z: number, yaw: number): void {
    const entity = this.entities.get(id);
    if (!entity) return;
    entity.snapshots.push({ t: performance.now(), x, y, z, yaw });
    if (entity.snapshots.length > 2) entity.snapshots.shift();
  }

  /** Interpolates every remote player's rendered transform toward "now minus the interp buffer". */
  tick(): void {
    const renderTime = performance.now() - INTERP_DELAY_MS;

    for (const entity of this.entities.values()) {
      const snaps = entity.snapshots;
      if (snaps.length === 1) {
        const s = snaps[0]!;
        entity.group.position.set(s.x, s.y, s.z);
        entity.group.rotation.y = s.yaw;
        continue;
      }

      const [prev, next] = snaps as [Snapshot, Snapshot];
      const span = next.t - prev.t || 1;
      const alpha = Math.max(0, Math.min(1, (renderTime - prev.t) / span));

      entity.group.position.set(
        prev.x + (next.x - prev.x) * alpha,
        prev.y + (next.y - prev.y) * alpha,
        prev.z + (next.z - prev.z) * alpha
      );
      entity.group.rotation.y = prev.yaw + wrapAngle(next.yaw - prev.yaw) * alpha;
    }
  }
}
