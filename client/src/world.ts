import { BLOCKS, voxelIndex, worldToChunk, worldToLocal, isSolid } from '@game/shared';

/** Client-side decoded chunk store — mirrors server/src/world.ts's shape but has no DB backing. */

function chunkKey(chunkX: number, chunkZ: number): string {
  return `${chunkX},${chunkZ}`;
}

export class ClientWorld {
  private readonly chunks = new Map<string, Uint8Array>();

  setChunk(chunkX: number, chunkZ: number, blocks: Uint8Array): void {
    this.chunks.set(chunkKey(chunkX, chunkZ), blocks);
  }

  getChunkBlocks(chunkX: number, chunkZ: number): Uint8Array | undefined {
    return this.chunks.get(chunkKey(chunkX, chunkZ));
  }

  getBlock(x: number, y: number, z: number): number {
    const { chunkX, chunkZ } = worldToChunk(x, z);
    const chunk = this.chunks.get(chunkKey(chunkX, chunkZ));
    if (!chunk) return BLOCKS.AIR.id; // unloaded = open air, never traps the player
    const { localX, localZ } = worldToLocal(x, z);
    return chunk[voxelIndex(localX, y, localZ)] ?? BLOCKS.AIR.id;
  }

  /** Applies a server-confirmed block update. No-op if the chunk isn't loaded. */
  setBlock(x: number, y: number, z: number, blockId: number): void {
    const { chunkX, chunkZ } = worldToChunk(x, z);
    const chunk = this.chunks.get(chunkKey(chunkX, chunkZ));
    if (!chunk) return;
    const { localX, localZ } = worldToLocal(x, z);
    chunk[voxelIndex(localX, y, localZ)] = blockId;
  }

  isSolidAt(x: number, y: number, z: number): boolean {
    return isSolid(this.getBlock(x, y, z));
  }
}
