import * as THREE from 'three';
import { BLOCK_TEXTURE_COUNT } from './blockLayer.js';

const TILE_SIZE = 148;

/**
 * Loads `public/textures/blocks.png` (built by tools/src/buildTextureArray.ts
 * — a tall strip, one 148x148 tile per block-texture layer, stacked in
 * blockLayer.ts's id order) and slices it into a THREE.DataArrayTexture: one
 * independent layer per block type.
 *
 * A texture array, not a padded shared atlas, deliberately — PLAN.md's own
 * spike question ("padded atlas vs DataArrayTexture") is resolved by this:
 * greedy-merged quads (PLAN.md C3) need their texture to *tile* w x h times
 * across a merged quad, not stretch once across it, and each array layer
 * being its own independent texture means that tiling (done via `fract()` in
 * the fragment shader — see chunkRenderer.ts) can never bleed into a
 * neighboring tile's texture the way tiling within a shared atlas would.
 */
export async function loadBlockTextureArray(): Promise<THREE.DataArrayTexture> {
  const image = await loadImage('/textures/blocks.png');

  const canvas = document.createElement('canvas');
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE * BLOCK_TEXTURE_COUNT;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  const texture = new THREE.DataArrayTexture(data, TILE_SIZE, TILE_SIZE, BLOCK_TEXTURE_COUNT);
  texture.magFilter = THREE.NearestFilter;
  // Mipmapped + linear-between-mips: PLAN.md Phase 8 explicitly calls out
  // that Nearest alone shimmers badly on this world's large flat expanses
  // viewed at a distance.
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`failed to load ${src}`));
    image.src = src;
  });
}
