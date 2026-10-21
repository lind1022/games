import { BLOCKS, CHUNK_SIZE, WORLD_HEIGHT, isTransparent, voxelIndex } from '@game/shared';

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
  /**
   * Spans [0,w]x[0,h] (block units) per merged quad, not [0,1] — the
   * fragment shader tiles the texture within each block unit via
   * `fract()`, so a quad merged from w x h blocks (PLAN.md C3's greedy
   * meshing) repeats the texture w x h times instead of stretching one
   * copy across the whole merged quad.
   */
  uvs: Float32Array;
  /** One texture-array layer index per vertex (see blockLayer.ts) — constant across each quad. */
  layers: Float32Array;
  indices: Uint32Array;
}

/**
 * PLAN.md Phase 8's "transparent-block second mesh pass for glass" — kept
 * general to every `transparent: true` block (also WATER), not glass
 * specifically, and split at the mesh-building level rather than after:
 * `opaque` gets the game's normal fully-opaque depth-writing material;
 * `transparent` gets its own alpha-blended one, rendered as a separate
 * THREE.Mesh so three.js's automatic transparent-object sort (back-to-
 * front, after all opaque draws) applies — see blockMaterial.ts.
 */
export interface ChunkMeshResult {
  opaque: ChunkMeshData;
  transparent: ChunkMeshData;
}

const DIMS = [CHUNK_SIZE, WORLD_HEIGHT, CHUNK_SIZE] as const;
const AIR_ID = BLOCKS.AIR.id;

function getBlockAt(blocks: Uint8Array, x: number, y: number, z: number): number {
  if (x < 0 || x >= CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT || z < 0 || z >= CHUNK_SIZE) {
    return AIR_ID; // see module comment on chunk-boundary handling
  }
  return blocks[voxelIndex(x, y, z)] ?? AIR_ID;
}

interface MeshBuilder {
  positions: number[];
  normals: number[];
  uvs: number[];
  layers: number[];
  indices: number[];
}

function createBuilder(): MeshBuilder {
  return { positions: [], normals: [], uvs: [], layers: [], indices: [] };
}

function finalize(builder: MeshBuilder): ChunkMeshData {
  return {
    positions: new Float32Array(builder.positions),
    normals: new Float32Array(builder.normals),
    uvs: new Float32Array(builder.uvs),
    layers: new Float32Array(builder.layers),
    indices: new Uint32Array(builder.indices),
  };
}

export function meshChunk(
  blocks: Uint8Array,
  blockLayer: (blockId: number) => number
): ChunkMeshResult {
  const opaqueBuilder = createBuilder();
  const transparentBuilder = createBuilder();

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
      // block on the "A" side faces outward in +d, -blockId if the block
      // is on the "B" side (face points in -d), else 0.
      //
      // A face is needed exactly when one side is air and the other isn't
      // — never between two *different* non-air blocks (solid or
      // transparent alike: the shared interior seam between them is never
      // visible from outside either one), and never between two blocks of
      // the *same* id (would just double-draw an invisible internal face).
      // Earlier this used isSolid() equality instead of an air check,
      // which happened to work for solid-vs-solid and looked plausible
      // for solid-vs-air, but silently never drew a face for non-solid,
      // non-air blocks at all — WATER (`solid: false`) never rendered
      // anything, ever, air or not, until this was fixed.
      let n = 0;
      for (x[v] = 0; x[v] < DIMS[v]!; x[v]++) {
        for (x[u] = 0; x[u] < DIMS[u]!; x[u]++) {
          const blockA = getBlockAt(blocks, x[0]!, x[1]!, x[2]!);
          const blockB = getBlockAt(blocks, x[0]! + q[0]!, x[1]! + q[1]!, x[2]! + q[2]!);

          if (blockA === blockB || (blockA !== AIR_ID && blockB !== AIR_ID)) {
            mask[n] = 0;
          } else if (blockA !== AIR_ID) {
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

          // Texture V (the 2nd UV component — image rows, per the fragment
          // shader's texture(map, vec3(uv, layer))) should be world-Y
          // whenever this face has a Y-axis edge at all, so a texture with
          // meaningful top-to-bottom content (a snow cap fading to dirt,
          // brick coursing, wood grain) reads right-side-up on every wall,
          // not just the ones where that happens to fall out of the loop's
          // (d+1)%3/(d+2)%3 axis-cycling by luck. Y is u (not v) only when
          // d===0 — swap which of w/h drives S vs T *for texture purposes
          // only* in that one case. The position/mask/merge/winding logic
          // above must keep using its own untouched w,h/u,v — this is a
          // separate remap, not a change to which axis is geometrically u
          // or v (that would flip cross(du,dv) and break face winding).
          const yIsU = u === 1;
          const textureS = yIsU ? h : w;
          const textureT = yIsU ? w : h;
          // dir>0: p0->p1->p2->p3 is CCW as seen from +d (cross(du,dv) == +d
          // for this cyclic u,v choice). dir<0 reverses the winding to stay
          // CCW as seen from -d. UVs are permuted the same way to keep each
          // one matched to its corresponding position.
          const uv0 = [0, 0];
          const uv1 = yIsU ? [0, textureT] : [textureS, 0];
          const uv2 = [textureS, textureT];
          const uv3 = yIsU ? [textureS, 0] : [0, textureT];
          const quad = dir > 0 ? [p0, p1, p2, p3] : [p0, p3, p2, p1];
          const quadUv = dir > 0 ? [uv0, uv1, uv2, uv3] : [uv0, uv3, uv2, uv1];
          const layer = blockLayer(blockId);
          const builder = isTransparent(blockId) ? transparentBuilder : opaqueBuilder;
          const vertexStart = builder.positions.length / 3;

          for (let vi = 0; vi < quad.length; vi++) {
            const p = quad[vi]!;
            const uv = quadUv[vi]!;
            builder.positions.push(p[0]!, p[1]!, p[2]!);
            builder.normals.push(normal[0]!, normal[1]!, normal[2]!);
            builder.uvs.push(uv[0]!, uv[1]!);
            builder.layers.push(layer);
          }
          builder.indices.push(
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

  return { opaque: finalize(opaqueBuilder), transparent: finalize(transparentBuilder) };
}
