/**
 * Block-type ID table — locked contract #1 (see PLAN.md §1).
 *
 * Ids 0-31 are reserved "core" block types. This table is append-only:
 * never reorder, renumber, or reuse an id once any chunk data has been
 * saved, since persisted chunk blobs and block_changes rows reference
 * blocks by id only.
 */

export interface BlockDef {
  readonly id: number;
  readonly name: string;
  readonly textureTile: string;
  readonly solid: boolean;
  readonly transparent: boolean;
}

function defineBlock(
  id: number,
  name: string,
  textureTile: string,
  solid: boolean,
  transparent: boolean
): BlockDef {
  return { id, name, textureTile, solid, transparent };
}

export const BLOCKS = {
  AIR: defineBlock(0, 'air', 'air', false, true),
  GRASS: defineBlock(1, 'grass', 'grass', true, false),
  DIRT: defineBlock(2, 'dirt', 'dirt', true, false),
  STONE: defineBlock(3, 'stone', 'stone', true, false),
  BRICK: defineBlock(4, 'brick', 'brick', true, false),
  GLASS: defineBlock(5, 'glass', 'glass', true, true),
  WOOD: defineBlock(6, 'wood', 'wood', true, false),
  PATH: defineBlock(7, 'path', 'path', true, false),
  WATER: defineBlock(8, 'water', 'water', false, true),
} as const satisfies Record<string, BlockDef>;

export type BlockName = keyof typeof BLOCKS;

/** Ids above this are non-core (importer/user-added). Reserved range per contract #1. */
export const MAX_CORE_BLOCK_ID = 31;

const BLOCK_BY_ID: ReadonlyMap<number, BlockDef> = new Map(
  Object.values(BLOCKS).map((block) => [block.id, block])
);

export function getBlock(id: number): BlockDef | undefined {
  return BLOCK_BY_ID.get(id);
}

export function isKnownBlockId(id: number): boolean {
  return BLOCK_BY_ID.has(id);
}

export function isSolid(id: number): boolean {
  return BLOCK_BY_ID.get(id)?.solid ?? false;
}

export function isTransparent(id: number): boolean {
  return BLOCK_BY_ID.get(id)?.transparent ?? true;
}
