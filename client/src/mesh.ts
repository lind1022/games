import { CHUNK_SIZE, WORLD_HEIGHT, isSolid, voxelIndex } from '@game/shared';

/**
 * Greedy mesher — PLAN.md C3: written once as a pure function (chunk data
 * in, typed arrays out) so the call site can move into a Web Worker in
 * Phase 2 without changing this function at all. This world is dominated
 * by large flat expanses, which is the best case for greedy meshing, not
 * an edge case — naive per-face meshing was explicitly rejected.
 *
 * Treats the chunk's own boundary as air (no neighbor-chunk lookups): a
 * few extra faces get drawn at chunk seams (harmless overdraw, opaque
 * neighbors cover them), in exchange for keeping this function
 * self-contained — exactly what the future worker migration needs.
 */

export interface ChunkMeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

const DIMS = [CHUNK_SIZE, WORLD_HEIGHT, CHUNK_SIZE] as const;

function getBlockAt(blocks: Uint8Array, x: number, y: number, z: number): number {
  if (x < 0 || x >= CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT || z < 0 || z >= CHUNK_SIZE) {
    return 0; // air — see module comment on chunk-boundary handling
  }
  return blocks[voxelIndex(x, y, z)] ?? 0;
}

export function meshChunk(
  blocks: Uint8Array,
  blockColor: (blockId: number) => readonly [number, number, number]
): ChunkMeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;

    const x = [0, 0, 0];
    const q = [0, 0, 0];
    q[d] = 1;

    const maskW = DIMS[u]!;
    const maskH = DIMS[v]!;
    const mask: number[] = new Array(maskW * maskH);

    for (x[d] = -1; x[d] < DIMS[d]!; x[d]++) {
      // Build the 2D face mask for this slice: mask[i] is +blockId if a
      // solid block on the "A" side faces outward in +d, -blockId if the
      // solid block is on the "B" side (face points in -d), else 0.
      let n = 0;
      for (x[v] = 0; x[v] < DIMS[v]!; x[v]++) {
        for (x[u] = 0; x[u] < DIMS[u]!; x[u]++) {
          const blockA = getBlockAt(blocks, x[0]!, x[1]!, x[2]!);
          const blockB = getBlockAt(blocks, x[0]! + q[0]!, x[1]! + q[1]!, x[2]! + q[2]!);
          const solidA = isSolid(blockA);
          const solidB = isSolid(blockB);

          if (solidA === solidB) {
            mask[n] = 0;
          } else if (solidA) {
            mask[n] = blockA;
          } else {
            mask[n] = -blockB;
          }
          n++;
        }
      }

      // Greedily merge the mask into maximal rectangles.
      n = 0;
      for (let j = 0; j < maskH; j++) {
        for (let i = 0; i < maskW; ) {
          const c = mask[n]!;
          if (c === 0) {
            i++;
            n++;
            continue;
          }

          let w = 1;
          while (i + w < maskW && mask[n + w] === c) w++;

          let h = 1;
          heightLoop: while (j + h < maskH) {
            for (let k = 0; k < w; k++) {
              if (mask[n + k + h * maskW] !== c) break heightLoop;
            }
            h++;
          }

          const blockId = Math.abs(c);
          const dir = c > 0 ? 1 : -1;

          const base = [0, 0, 0];
          base[u] = i;
          base[v] = j;
          base[d] = x[d]! + 1;

          const du = [0, 0, 0];
          du[u] = w;
          const dv = [0, 0, 0];
          dv[v] = h;

          const p0 = [base[0]!, base[1]!, base[2]!];
          const p1 = [base[0]! + du[0]!, base[1]! + du[1]!, base[2]! + du[2]!];
          const p2 = [base[0]! + du[0]! + dv[0]!, base[1]! + du[1]! + dv[1]!, base[2]! + du[2]! + dv[2]!];
          const p3 = [base[0]! + dv[0]!, base[1]! + dv[1]!, base[2]! + dv[2]!];

          const normal = [0, 0, 0];
          normal[d] = dir;

          // dir>0: p0->p1->p2->p3 is CCW as seen from +d (cross(du,dv) == +d
          // for this cyclic u,v choice). dir<0 reverses the winding to stay
          // CCW as seen from -d.
          const quad = dir > 0 ? [p0, p1, p2, p3] : [p0, p3, p2, p1];
          const [r, g, b] = blockColor(blockId);
          const vertexStart = positions.length / 3;

          for (const p of quad) {
            positions.push(p[0]!, p[1]!, p[2]!);
            normals.push(normal[0]!, normal[1]!, normal[2]!);
            colors.push(r, g, b);
          }
          indices.push(
            vertexStart,
            vertexStart + 1,
            vertexStart + 2,
            vertexStart,
            vertexStart + 2,
            vertexStart + 3
          );

          for (let l = 0; l < h; l++) {
            for (let k = 0; k < w; k++) {
              mask[n + k + l * maskW] = 0;
            }
          }

          i += w;
          n += w;
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}
