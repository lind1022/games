import * as THREE from 'three';
import { PLAYER_EYE_HEIGHT } from '@game/shared';
import type { ClientWorld } from './world.js';

/**
 * Hand-rolled FPS controller — no physics engine (PLAN.md Phase 1).
 * AABB ~0.6 x 1.8 x 0.6, resolved per-axis X then Z then Y for free
 * wall-sliding. Keyboard + mouse only (D2) — pointer lock has no touch
 * equivalent.
 */

const PLAYER_HALF_WIDTH = 0.3;
const PLAYER_HALF_DEPTH = 0.3;
const PLAYER_HEIGHT = 1.8;
const MOVE_SPEED = 4.5; // m/s
const JUMP_SPEED = 6.5; // m/s
const GRAVITY = 20; // m/s^2
const EPSILON = 1e-3;

export class PlayerController {
  /** Feet position (bottom-center of the hitbox), in world coordinates. */
  private readonly position = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private grounded = false;
  private yaw = 0;
  private pitch = 0;
  private readonly keys = new Set<string>();

  constructor(
    private readonly domElement: HTMLElement,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly world: ClientWorld
  ) {
    domElement.addEventListener('click', () => {
      if (document.pointerLockElement !== domElement) {
        domElement.requestPointerLock();
      }
    });
    document.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  setSpawn(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
    this.updateCamera();
  }

  /** Feet position + look angles, for broadcasting to the server (Phase 2 player-move). */
  getState(): { x: number; y: number; z: number; yaw: number; pitch: number } {
    return { x: this.position.x, y: this.position.y, z: this.position.z, yaw: this.yaw, pitch: this.pitch };
  }

  private onMouseMove(event: MouseEvent): void {
    if (document.pointerLockElement !== this.domElement) return;
    const sensitivity = 0.01;
    this.yaw -= event.movementX * sensitivity;
    this.pitch -= event.movementY * sensitivity;
    const maxPitch = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch));
  }

  update(dt: number): void {
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-forward.z, 0, forward.x);

    let inputX = 0;
    let inputZ = 0;
    if (this.keys.has('KeyW')) inputZ += 1;
    if (this.keys.has('KeyS')) inputZ -= 1;
    if (this.keys.has('KeyD')) inputX += 1;
    if (this.keys.has('KeyA')) inputX -= 1;

    const moveDir = new THREE.Vector3().addScaledVector(forward, inputZ).addScaledVector(right, inputX);
    if (moveDir.lengthSq() > 0) moveDir.normalize();

    this.velocity.x = moveDir.x * MOVE_SPEED;
    this.velocity.z = moveDir.z * MOVE_SPEED;

    if (this.grounded && this.keys.has('Space')) {
      this.velocity.y = JUMP_SPEED;
      this.grounded = false;
    }
    this.velocity.y -= GRAVITY * dt;

    this.moveAxis('x', this.velocity.x * dt);
    this.moveAxis('z', this.velocity.z * dt);
    this.moveAxis('y', this.velocity.y * dt);

    this.updateCamera();
  }

  private updateCamera(): void {
    this.camera.position.set(this.position.x, this.position.y + PLAYER_EYE_HEIGHT, this.position.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  private moveAxis(axis: 'x' | 'y' | 'z', delta: number): void {
    if (delta === 0) return;

    if (axis === 'x') this.position.x += delta;
    else if (axis === 'z') this.position.z += delta;
    else this.position.y += delta;

    const minX = this.position.x - PLAYER_HALF_WIDTH;
    const maxX = this.position.x + PLAYER_HALF_WIDTH;
    const minY = this.position.y;
    const maxY = this.position.y + PLAYER_HEIGHT;
    const minZ = this.position.z - PLAYER_HALF_DEPTH;
    const maxZ = this.position.z + PLAYER_HALF_DEPTH;

    const x0 = Math.floor(minX);
    const x1 = Math.floor(maxX - EPSILON);
    const y0 = Math.floor(minY);
    const y1 = Math.floor(maxY - EPSILON);
    const z0 = Math.floor(minZ);
    const z1 = Math.floor(maxZ - EPSILON);

    for (let bx = x0; bx <= x1; bx++) {
      for (let by = y0; by <= y1; by++) {
        for (let bz = z0; bz <= z1; bz++) {
          if (!this.world.isSolidAt(bx, by, bz)) continue;

          if (axis === 'x') {
            this.position.x =
              delta > 0 ? bx - PLAYER_HALF_WIDTH - EPSILON : bx + 1 + PLAYER_HALF_WIDTH + EPSILON;
          } else if (axis === 'z') {
            this.position.z =
              delta > 0 ? bz - PLAYER_HALF_DEPTH - EPSILON : bz + 1 + PLAYER_HALF_DEPTH + EPSILON;
          } else {
            if (delta > 0) {
              this.position.y = by - PLAYER_HEIGHT - EPSILON;
            } else {
              this.position.y = by + 1 + EPSILON;
              this.grounded = true;
            }
            this.velocity.y = 0;
          }
          return; // one collision resolved is enough for this axis this frame
        }
      }
    }

    if (axis === 'y' && delta < 0) {
      this.grounded = false;
    }
  }
}
