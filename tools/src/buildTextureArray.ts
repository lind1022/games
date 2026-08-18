import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

/**
 * One-off: crops the 10 block textures this project needs out of the stock
 * sheet the product owner supplied, and stacks them into one tall PNG (148
 * wide x 1480 tall, one 148x148 tile per row) for client/src/textures.ts to
 * slice into a THREE.DataArrayTexture layer per block type at runtime.
 *
 * Layer order matches shared/src/blocks.ts's block ids exactly (layer =
 * blockId - 1: GRASS=1..COURT=10) — keep that invariant if either changes.
 * Not part of any runtime pipeline; a build-time asset generator, run once.
 *
 * The source sheet is a third-party stock asset (kept out of git, like
 * school map.png — see the repo root's .gitignore) — re-download it there
 * before re-running this if it's ever missing locally.
 */

const SHEET = fileURLToPath(
  new URL(
    '../../retro-8-bit-pixel-art-game-surface-texture-pattern_8071-76262.jpg.avif',
    import.meta.url
  )
);
const OUT = fileURLToPath(new URL('../../client/public/textures/blocks.png', import.meta.url));
const TILE = 148;

// [col, row] into the 5x5 source sheet, in shared/src/blocks.ts id order.
const LAYOUT: Record<string, [number, number]> = {
  GRASS: [4, 2],
  DIRT: [3, 1],
  STONE: [1, 3],
  BRICK: [1, 2],
  GLASS: [2, 3],
  WOOD: [4, 0],
  PATH: [0, 1],
  WATER: [4, 4],
  LEAVES: [1, 1],
  COURT: [3, 3],
};
const ORDER = ['GRASS', 'DIRT', 'STONE', 'BRICK', 'GLASS', 'WOOD', 'PATH', 'WATER', 'LEAVES', 'COURT'];

async function main() {
  const tiles: Buffer[] = [];
  for (const name of ORDER) {
    const [col, row] = LAYOUT[name]!;
    const tile = await sharp(SHEET)
      .extract({ left: col * TILE, top: row * TILE, width: TILE, height: TILE })
      .png()
      .toBuffer();
    tiles.push(tile);
    console.log(name, '<-', `(${col},${row})`);
  }

  await sharp({
    create: { width: TILE, height: TILE * ORDER.length, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(tiles.map((tile, i) => ({ input: tile, top: i * TILE, left: 0 })))
    .png()
    .toFile(OUT);
  console.log('wrote', OUT);
}

main();
