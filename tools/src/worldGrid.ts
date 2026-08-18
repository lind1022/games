import { BLOCKS, CHUNK_SIZE, CHUNK_VOLUME, WORLD_HEIGHT, voxelIndex } from '@game/shared';
import { Label, LABEL_TO_BLOCK, type ClassifiedImage, type ImportConfig } from './classify.js';

/**
 * Downsamples the classified pixel grid to world blocks (majority vote per
 * cell — this is also what washes out thin overlay/tree/hatching noise
 * without dedicated cleanup logic, see classify.ts), derives real site
 * bounds, and extrudes buildings to hollow shells (PLAN.md §8 D1: walls +
 * floor, no interior subdivision, no roof — "hollow shell" is taken
 * literally, open-top).
 *
 * World coordinates must be square (contract #4, `x, z ∈ [0, worldSize)`
 * with one scalar worldSize) even though the real site is a ~1.67:1
 * rectangle — the imported rectangle is placed at the (0,0) corner and the
 * rest of the square is flat grass, so the server's existing square-world
 * logic (server/src/world.ts's WORLD_SIZE) needs no format change, only
 * its size constant bumped.
 */

export interface WorldGridResult {
  worldChunks: number;
  worldSize: number;
  importedWidthBlocks: number;
  importedDepthBlocks: number;
  spawnX: number;
  spawnZ: number;
  blockGrid: Uint8Array; // Label per (bx,bz), row-major, length width*depth
  unclassifiedBlocks: number;
  getChunkBlocks(chunkX: number, chunkZ: number): Uint8Array;
}

const MARGIN_METRES = 4;

function isRealContent(classified: ClassifiedImage, i: number): boolean {
  const label = classified.labels[i];
  if (label === Label.GRASS) return classified.isBackground[i] === 0;
  // UNCLASSIFIED doesn't count toward bounds even though it's flagged for
  // review in the actual grid: confirmed empirically that anti-aliased
  // edges of the "MAP OF VENUE" title (too blended to match navy-outline
  // tolerance, but not white either) land here, and being an isolated
  // speck far outside the real campus, was inflating the bounding box
  // toward the image corner. A real UNCLASSIFIED speck genuinely inside
  // the campus doesn't need to independently define the bbox anyway,
  // since it's already surrounded by other real content that does.
  if (label === Label.UNCLASSIFIED) return false;
  return true; // BUILDING, PATH, WATER, COURT all count
}

function findBounds(classified: ClassifiedImage): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = classified.width;
  let minY = classified.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < classified.height; y++) {
    for (let x = 0; x < classified.width; x++) {
      const i = y * classified.width + x;
      if (!isRealContent(classified, i)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

function majorityLabel(counts: Int32Array): Label {
  let best = Label.GRASS;
  let bestCount = -1;
  for (let label = 0; label < counts.length; label++) {
    if (counts[label]! > bestCount) {
      bestCount = counts[label]!;
      best = label as Label;
    }
  }
  return best;
}

export function buildWorldGrid(classified: ClassifiedImage, config: ImportConfig): WorldGridResult {
  const { pixelsPerMetre, wallHeight } = config;
  const marginPx = Math.round(MARGIN_METRES * pixelsPerMetre);

  const raw = findBounds(classified);
  const minX = Math.max(0, raw.minX - marginPx);
  const minY = Math.max(0, raw.minY - marginPx);
  const maxX = Math.min(classified.width - 1, raw.maxX + marginPx);
  const maxY = Math.min(classified.height - 1, raw.maxY + marginPx);

  const importedWidthBlocks = Math.ceil((maxX - minX + 1) / pixelsPerMetre);
  const importedDepthBlocks = Math.ceil((maxY - minY + 1) / pixelsPerMetre);

  const blockGrid = new Uint8Array(importedWidthBlocks * importedDepthBlocks);
  let unclassifiedBlocks = 0;

  for (let bz = 0; bz < importedDepthBlocks; bz++) {
    const py0 = minY + Math.round(bz * pixelsPerMetre);
    const py1 = Math.min(maxY, minY + Math.round((bz + 1) * pixelsPerMetre) - 1);
    for (let bx = 0; bx < importedWidthBlocks; bx++) {
      const px0 = minX + Math.round(bx * pixelsPerMetre);
      const px1 = Math.min(maxX, minX + Math.round((bx + 1) * pixelsPerMetre) - 1);

      const counts = new Int32Array(6);
      for (let y = py0; y <= py1; y++) {
        for (let x = px0; x <= px1; x++) {
          counts[classified.labels[y * classified.width + x]!]!++;
        }
      }
      const label = majorityLabel(counts);
      blockGrid[bz * importedWidthBlocks + bx] = label;
      if (label === Label.UNCLASSIFIED) unclassifiedBlocks++;
    }
  }

  // Buildings touching a non-building neighbor (or the grid edge) are wall
  // columns; interior building cells are floor-only.
  function isBuildingAt(bx: number, bz: number): boolean {
    if (bx < 0 || bz < 0 || bx >= importedWidthBlocks || bz >= importedDepthBlocks) return false;
    return blockGrid[bz * importedWidthBlocks + bx] === Label.BUILDING;
  }
  const isWall = new Uint8Array(importedWidthBlocks * importedDepthBlocks);
  for (let bz = 0; bz < importedDepthBlocks; bz++) {
    for (let bx = 0; bx < importedWidthBlocks; bx++) {
      if (blockGrid[bz * importedWidthBlocks + bx] !== Label.BUILDING) continue;
      const edge =
        !isBuildingAt(bx + 1, bz) ||
        !isBuildingAt(bx - 1, bz) ||
        !isBuildingAt(bx, bz + 1) ||
        !isBuildingAt(bx, bz - 1);
      if (edge) isWall[bz * importedWidthBlocks + bx] = 1;
    }
  }

  const worldChunks = Math.ceil(Math.max(importedWidthBlocks, importedDepthBlocks) / CHUNK_SIZE);
  const worldSize = worldChunks * CHUNK_SIZE;

  function columnBlocks(bx: number, bz: number): { surface: number; wall: boolean } {
    if (bx < 0 || bz < 0 || bx >= importedWidthBlocks || bz >= importedDepthBlocks) {
      return { surface: BLOCKS.GRASS.id, wall: false };
    }
    const label = blockGrid[bz * importedWidthBlocks + bx] as Label;
    if (label === Label.BUILDING) {
      return { surface: BLOCKS.STONE.id, wall: isWall[bz * importedWidthBlocks + bx] === 1 };
    }
    const blockName = LABEL_TO_BLOCK[label] ?? 'GRASS';
    return { surface: BLOCKS[blockName].id, wall: false };
  }

  function getChunkBlocks(chunkX: number, chunkZ: number): Uint8Array {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    const baseX = chunkX * CHUNK_SIZE;
    const baseZ = chunkZ * CHUNK_SIZE;
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const { surface, wall } = columnBlocks(baseX + lx, baseZ + lz);
        blocks[voxelIndex(lx, 0, lz)] = surface;
        if (wall) {
          for (let y = 1; y <= wallHeight && y < WORLD_HEIGHT; y++) {
            blocks[voxelIndex(lx, y, lz)] = BLOCKS.BRICK.id;
          }
        }
      }
    }
    return blocks;
  }

  const { spawnX, spawnZ } = findSpawn(blockGrid, importedWidthBlocks, importedDepthBlocks);

  return {
    worldChunks,
    worldSize,
    importedWidthBlocks,
    importedDepthBlocks,
    spawnX,
    spawnZ,
    blockGrid,
    unclassifiedBlocks,
    getChunkBlocks,
  };
}

/** Centre of the imported rectangle, nudged outward in a ring search if that cell isn't open ground. */
function findSpawn(
  blockGrid: Uint8Array,
  width: number,
  depth: number
): { spawnX: number; spawnZ: number } {
  const cx = Math.floor(width / 2);
  const cz = Math.floor(depth / 2);
  const isOpen = (bx: number, bz: number): boolean => {
    if (bx < 0 || bz < 0 || bx >= width || bz >= depth) return false;
    const label = blockGrid[bz * width + bx] as Label;
    return label === Label.GRASS || label === Label.PATH || label === Label.COURT;
  };

  for (let ring = 0; ring < Math.max(width, depth); ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        if (isOpen(cx + dx, cz + dz)) {
          return { spawnX: cx + dx, spawnZ: cz + dz };
        }
      }
    }
  }
  return { spawnX: cx, spawnZ: cz };
}
