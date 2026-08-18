import { BLOCKS } from '@game/shared';

/**
 * Maps a block id to its layer index in the texture array built by
 * `textures.ts` from `public/textures/blocks.png` (itself built by
 * `tools/src/buildTextureArray.ts` from the product owner's supplied
 * texture sheet). `layer = blockId - 1` because every block id from
 * `GRASS` (1) through `COURT` (10) has a texture, in that exact id order —
 * keep both in lockstep if a new block type is ever added.
 */
export function blockLayer(blockId: number): number {
  return blockId - 1;
}

export const BLOCK_TEXTURE_COUNT = Object.keys(BLOCKS).length - 1; // - AIR, which has none
