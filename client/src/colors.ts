import { BLOCKS } from '@game/shared';

/** Flat per-block-type colors for vertex-color shading. Textures land in Phase 8. */
const COLORS: Partial<Record<number, readonly [number, number, number]>> = {
  [BLOCKS.GRASS.id]: [0.29, 0.62, 0.28],
  [BLOCKS.DIRT.id]: [0.45, 0.32, 0.22],
  [BLOCKS.STONE.id]: [0.55, 0.55, 0.58],
  [BLOCKS.BRICK.id]: [0.65, 0.29, 0.24],
  [BLOCKS.WOOD.id]: [0.55, 0.4, 0.24],
  [BLOCKS.PATH.id]: [0.72, 0.66, 0.55],
};

const FALLBACK_COLOR = [1, 0, 1] as const; // magenta = "no color defined" (debug aid)

export function blockColor(blockId: number): readonly [number, number, number] {
  return COLORS[blockId] ?? FALLBACK_COLOR;
}
