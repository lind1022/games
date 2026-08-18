import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

/**
 * Ad hoc pixel-color probe used to build `import-config.json`'s palette by
 * hand against real coordinates in `school map.png` (identified by eye from
 * a rendered view of the map, not guessed). Not part of the import pipeline
 * itself — a one-off aid for calibrating the config.
 *
 * Usage: `npm run sample-colors -w tools -- x1,y1 label1 x2,y2 label2 ...`
 * Coordinates are in the *original* image's pixel space.
 */

const MAP_PATH = fileURLToPath(new URL('../../school map.png', import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.length % 2 !== 0) {
    console.error('Usage: sample-colors x,y label [x,y label ...]');
    process.exit(1);
  }

  const image = sharp(MAP_PATH).ensureAlpha();
  const { width, height } = await image.metadata();
  const raw = await image.raw().toBuffer();

  for (let i = 0; i < args.length; i += 2) {
    const [xStr, yStr] = args[i]!.split(',');
    const label = args[i + 1]!;
    const x = Math.round(Number(xStr));
    const y = Math.round(Number(yStr));
    if (x < 0 || y < 0 || x >= width! || y >= height!) {
      console.log(`${label.padEnd(24)} (${x},${y}) OUT OF BOUNDS`);
      continue;
    }
    const offset = (y * width! + x) * 4;
    const r = raw[offset]!;
    const g = raw[offset + 1]!;
    const b = raw[offset + 2]!;
    const a = raw[offset + 3]!;
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    console.log(`${label.padEnd(24)} (${x},${y}) rgb(${r},${g},${b}) a=${a} ${hex}`);
  }
}

main();
