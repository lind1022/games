import sharp from 'sharp';
import { Label } from './classify.js';

/**
 * Renders the classified/downsampled world grid to a PNG, one pixel per
 * world block, for visual comparison against the source map (PLAN.md Phase
 * 7: "always emit a diff-PNG of the importer's own interpretation... before
 * writing any chunks").
 */

const LABEL_COLOR: Record<Label, [number, number, number]> = {
  [Label.UNCLASSIFIED]: [255, 0, 255], // magenta — flagged for review, matches client's debug fallback
  [Label.GRASS]: [74, 158, 71],
  [Label.PATH]: [184, 168, 140],
  [Label.WATER]: [51, 115, 191],
  [Label.COURT]: [51, 140, 128],
  [Label.BUILDING]: [166, 74, 61],
};

export async function renderDiffPng(
  blockGrid: Uint8Array,
  width: number,
  height: number,
  outPath: string
): Promise<void> {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < blockGrid.length; i++) {
    const [r, g, b] = LABEL_COLOR[blockGrid[i] as Label];
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  await sharp(rgb, { raw: { width, height, channels: 3 } }).png().toFile(outPath);
}
