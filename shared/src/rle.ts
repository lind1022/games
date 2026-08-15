/**
 * Chunk serialization — locked contract #6 (see PLAN.md §1, C1): run-length
 * encoding per column, 1-byte block ids, with a leading format-version byte.
 *
 * On-disk / on-wire layout:
 *   byte 0: format version
 *   for each of the CHUNK_SIZE*CHUNK_SIZE columns, iterated z outer / x
 *   inner (matching voxelIndex's low-bit ordering — see world.ts):
 *     byte: run count for this column
 *     for each run: [blockId: byte, runLength: byte]
 *       (a column's runs always sum to WORLD_HEIGHT)
 *
 * In memory, a decoded chunk is a flat Uint8Array of length CHUNK_VOLUME,
 * indexed via voxelIndex(x, y, z) = y*256 + z*16 + x. This is the natural
 * encoding for a floor-plan-derived world: each column is dominated by a
 * handful of vertical runs (air, floor, wall, ...), so it compresses large
 * flat/air regions to a few bytes without palette/bitpacking machinery.
 */

import { CHUNK_SIZE, CHUNK_VOLUME, WORLD_HEIGHT, voxelIndex } from './world.js';

export const CHUNK_FORMAT_VERSION = 1;

const MAX_RUN_LENGTH = 255; // fits a uint8; WORLD_HEIGHT (64) is always <= this

export function encodeChunk(blocks: Uint8Array): Uint8Array {
  if (blocks.length !== CHUNK_VOLUME) {
    throw new Error(`encodeChunk: expected ${CHUNK_VOLUME} voxels, got ${blocks.length}`);
  }

  const bytes: number[] = [CHUNK_FORMAT_VERSION];

  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const runs: Array<[blockId: number, runLength: number]> = [];
      let y = 0;
      while (y < WORLD_HEIGHT) {
        const blockId = blocks[voxelIndex(x, y, z)]!;
        let runLength = 1;
        while (
          y + runLength < WORLD_HEIGHT &&
          runLength < MAX_RUN_LENGTH &&
          blocks[voxelIndex(x, y + runLength, z)] === blockId
        ) {
          runLength++;
        }
        runs.push([blockId, runLength]);
        y += runLength;
      }

      if (runs.length > 255) {
        // Cannot happen while WORLD_HEIGHT <= 255 (min run length is 1),
        // but guarded explicitly since the run count is a single byte.
        throw new Error('encodeChunk: column produced more than 255 runs');
      }

      bytes.push(runs.length);
      for (const [blockId, runLength] of runs) {
        bytes.push(blockId, runLength);
      }
    }
  }

  return new Uint8Array(bytes);
}

export function decodeChunk(buf: Uint8Array): Uint8Array {
  if (buf.length === 0) {
    throw new Error('decodeChunk: empty buffer');
  }

  const formatVersion = buf[0]!;
  if (formatVersion !== CHUNK_FORMAT_VERSION) {
    throw new Error(
      `decodeChunk: unsupported format version ${formatVersion} (expected ${CHUNK_FORMAT_VERSION})`
    );
  }

  const blocks = new Uint8Array(CHUNK_VOLUME);
  let cursor = 1;

  for (let z = 0; z < CHUNK_SIZE; z++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const runCount = buf[cursor++];
      if (runCount === undefined) {
        throw new Error('decodeChunk: truncated buffer (missing run count)');
      }

      let y = 0;
      for (let r = 0; r < runCount; r++) {
        const blockId = buf[cursor++];
        const runLength = buf[cursor++];
        if (blockId === undefined || runLength === undefined) {
          throw new Error('decodeChunk: truncated buffer (missing run data)');
        }
        for (let i = 0; i < runLength; i++) {
          blocks[voxelIndex(x, y, z)] = blockId;
          y++;
        }
      }

      if (y !== WORLD_HEIGHT) {
        throw new Error(
          `decodeChunk: column (${x},${z}) runs summed to ${y}, expected ${WORLD_HEIGHT}`
        );
      }
    }
  }

  return blocks;
}
