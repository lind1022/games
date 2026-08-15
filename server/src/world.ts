import {
  BLOCKS,
  CHUNK_SIZE,
  CHUNK_VOLUME,
  isWithinWorldBounds,
  voxelIndex,
  worldToChunk,
  worldToLocal,
} from '@game/shared';
import type { GameDb } from './db.js';

/** Flat 5x5-chunk grass test world (Phase 1) — the real school import lands in Phase 7. */
export const WORLD_CHUNKS = 5;
export const WORLD_SIZE = WORLD_CHUNKS * CHUNK_SIZE;

interface Landmark {
  x: number;
  z: number;
  height: number;
  blockId: number;
}

/**
 * Visual test landmarks: 4 colored 3x3 towers, one per cardinal direction
 * from spawn, purely so movement and mouse-look have something to gauge
 * against on an otherwise flat green-floor/blue-sky world. Not part of the
 * phase spec — remove whenever real content (or Phase 8 textures) makes
 * them redundant.
 */
function testLandmarks(): Landmark[] {
  const center = WORLD_SIZE / 2;
  const distance = 10;
  return [
    { x: center, z: center - distance, height: 4, blockId: BLOCKS.BRICK.id }, // north
    { x: center, z: center + distance, height: 4, blockId: BLOCKS.STONE.id }, // south
    { x: center + distance, z: center, height: 4, blockId: BLOCKS.PATH.id }, // east
    { x: center - distance, z: center, height: 4, blockId: BLOCKS.DIRT.id }, // west
  ];
}

function generateFlatChunk(chunkX: number, chunkZ: number): Uint8Array {
  const blocks = new Uint8Array(CHUNK_VOLUME);
  for (let x = 0; x < CHUNK_SIZE; x++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      blocks[voxelIndex(x, 0, z)] = BLOCKS.GRASS.id;
    }
  }

  const baseX = chunkX * CHUNK_SIZE;
  const baseZ = chunkZ * CHUNK_SIZE;
  for (const landmark of testLandmarks()) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const localX = landmark.x + dx - baseX;
        const localZ = landmark.z + dz - baseZ;
        if (localX < 0 || localX >= CHUNK_SIZE || localZ < 0 || localZ >= CHUNK_SIZE) continue;
        for (let y = 1; y <= landmark.height; y++) {
          blocks[voxelIndex(localX, y, localZ)] = landmark.blockId;
        }
      }
    }
  }

  return blocks;
}

function chunkKey(chunkX: number, chunkZ: number): string {
  return `${chunkX},${chunkZ}`;
}

export interface ChunkEntry {
  chunkX: number;
  chunkZ: number;
  blocks: Uint8Array;
}

export class World {
  private readonly chunks = new Map<string, Uint8Array>();

  constructor(private readonly db: GameDb) {
    for (let cx = 0; cx < WORLD_CHUNKS; cx++) {
      for (let cz = 0; cz < WORLD_CHUNKS; cz++) {
        const existing = db.loadChunk(cx, cz);
        if (existing) {
          this.chunks.set(chunkKey(cx, cz), existing);
        } else {
          const generated = generateFlatChunk(cx, cz);
          this.chunks.set(chunkKey(cx, cz), generated);
          db.saveChunk(cx, cz, generated);
        }
      }
    }
  }

  allChunks(): ChunkEntry[] {
    const result: ChunkEntry[] = [];
    for (const [key, blocks] of this.chunks) {
      const [chunkX, chunkZ] = key.split(',').map(Number) as [number, number];
      result.push({ chunkX, chunkZ, blocks });
    }
    return result;
  }

  isWithinBounds(x: number, y: number, z: number): boolean {
    return isWithinWorldBounds(x, y, z, WORLD_SIZE);
  }

  getBlock(x: number, y: number, z: number): number {
    const { chunkX, chunkZ } = worldToChunk(x, z);
    const chunk = this.chunks.get(chunkKey(chunkX, chunkZ));
    if (!chunk) return BLOCKS.AIR.id;
    const { localX, localZ } = worldToLocal(x, z);
    return chunk[voxelIndex(localX, y, localZ)] ?? BLOCKS.AIR.id;
  }

  /**
   * Sets a block and persists the chunk + change record with its pre-image.
   * Caller must have already validated bounds and block id.
   */
  setBlock(x: number, y: number, z: number, blockId: number, displayName: string): number {
    const { chunkX, chunkZ } = worldToChunk(x, z);
    const key = chunkKey(chunkX, chunkZ);
    const chunk = this.chunks.get(key);
    if (!chunk) {
      throw new Error(`setBlock: chunk (${chunkX},${chunkZ}) not loaded`);
    }

    const { localX, localZ } = worldToLocal(x, z);
    const index = voxelIndex(localX, y, localZ);
    const oldBlockId = chunk[index]!;
    chunk[index] = blockId;

    this.db.persistBlockUpdate({
      chunkX,
      chunkZ,
      blockData: chunk,
      x,
      y,
      z,
      oldBlockId,
      newBlockId: blockId,
      displayName,
    });

    return oldBlockId;
  }
}
