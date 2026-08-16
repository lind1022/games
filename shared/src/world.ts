/**
 * Chunk footprint, world height, and coordinate math — locked contracts
 * #2-5 (see PLAN.md §1).
 *
 * - 16x16 chunk footprint, full-height column, no vertical sub-chunking.
 * - Column height is 64 (y in [0, WORLD_HEIGHT)) — see PLAN.md C2.
 * - World coordinates are bounded and positive-only: x, z in
 *   [0, worldSize), y in [0, WORLD_HEIGHT). There is no "negative chunk"
 *   case to handle, unlike infinite-terrain engines.
 * - Voxel order within a chunk's flat block array is y*256 + z*16 + x.
 */

export const CHUNK_SIZE = 16;
export const WORLD_HEIGHT = 64;
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT;

export interface ChunkCoord {
  readonly chunkX: number;
  readonly chunkZ: number;
}

export interface LocalCoord {
  readonly localX: number;
  readonly localZ: number;
}

/**
 * Index into a chunk's flat block array for local coordinates.
 * localX, localZ must be in [0, CHUNK_SIZE); y must be in [0, WORLD_HEIGHT).
 */
export function voxelIndex(localX: number, y: number, localZ: number): number {
  return y * CHUNK_SIZE * CHUNK_SIZE + localZ * CHUNK_SIZE + localX;
}

export function worldToChunk(worldX: number, worldZ: number): ChunkCoord {
  return {
    chunkX: Math.floor(worldX / CHUNK_SIZE),
    chunkZ: Math.floor(worldZ / CHUNK_SIZE),
  };
}

/** World coordinates are non-negative by contract, so plain floor+subtract is safe here. */
export function worldToLocal(worldX: number, worldZ: number): LocalCoord {
  return {
    localX: worldX - Math.floor(worldX / CHUNK_SIZE) * CHUNK_SIZE,
    localZ: worldZ - Math.floor(worldZ / CHUNK_SIZE) * CHUNK_SIZE,
  };
}

export function isValidHeight(y: number): boolean {
  return Number.isInteger(y) && y >= 0 && y < WORLD_HEIGHT;
}

export function isWithinWorldBounds(
  x: number,
  y: number,
  z: number,
  worldSize: number
): boolean {
  return (
    Number.isInteger(x) &&
    Number.isInteger(z) &&
    x >= 0 &&
    x < worldSize &&
    z >= 0 &&
    z < worldSize &&
    isValidHeight(y)
  );
}

/**
 * Gameplay constants shared between client and server so they can never
 * drift apart (Phase 2): the client uses them to render/raycast, the
 * server uses them to validate — e.g. reach-distance for block placement
 * only means anything if both sides agree on where the eye actually is.
 */
export const PLAYER_EYE_HEIGHT = 1.62;
export const REACH_DISTANCE = 6;
