import * as THREE from 'three';
import { REACH_DISTANCE } from '@game/shared';
import type { ClientWorld } from './world.js';

export interface RaycastHit {
  x: number;
  y: number;
  z: number;
  /** Outward face normal of the hit block — placement target is hit + normal. */
  normal: { x: number; y: number; z: number };
}

/** Amanatides & Woo voxel-grid DDA traversal — the standard algorithm for ray-vs-voxel targeting. */
export function raycastVoxel(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  world: ClientWorld,
  maxDistance = REACH_DISTANCE
): RaycastHit | null {
  let x = Math.floor(origin.x);
  let y = Math.floor(origin.y);
  let z = Math.floor(origin.z);

  const stepX = Math.sign(direction.x);
  const stepY = Math.sign(direction.y);
  const stepZ = Math.sign(direction.z);

  const tDeltaX = direction.x !== 0 ? Math.abs(1 / direction.x) : Infinity;
  const tDeltaY = direction.y !== 0 ? Math.abs(1 / direction.y) : Infinity;
  const tDeltaZ = direction.z !== 0 ? Math.abs(1 / direction.z) : Infinity;

  function firstBoundaryDistance(originComponent: number, cell: number, step: number): number {
    if (step > 0) return cell + 1 - originComponent;
    if (step < 0) return originComponent - cell;
    return Infinity;
  }

  let tMaxX = direction.x !== 0 ? firstBoundaryDistance(origin.x, x, stepX) * tDeltaX : Infinity;
  let tMaxY = direction.y !== 0 ? firstBoundaryDistance(origin.y, y, stepY) * tDeltaY : Infinity;
  let tMaxZ = direction.z !== 0 ? firstBoundaryDistance(origin.z, z, stepZ) * tDeltaZ : Infinity;

  let lastAxis: 'x' | 'y' | 'z' | null = null;
  let traveled = 0;

  while (traveled <= maxDistance) {
    if (world.isSolidAt(x, y, z)) {
      const normal = { x: 0, y: 0, z: 0 };
      if (lastAxis === 'x') normal.x = -stepX;
      else if (lastAxis === 'y') normal.y = -stepY;
      else if (lastAxis === 'z') normal.z = -stepZ;
      return { x, y, z, normal };
    }

    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      traveled = tMaxX;
      tMaxX += tDeltaX;
      lastAxis = 'x';
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      traveled = tMaxY;
      tMaxY += tDeltaY;
      lastAxis = 'y';
    } else {
      z += stepZ;
      traveled = tMaxZ;
      tMaxZ += tDeltaZ;
      lastAxis = 'z';
    }
  }

  return null;
}
