import sharp from 'sharp';
import type { BlockName } from '@game/shared';

/**
 * Pixel-level classification of the school map image (PLAN.md Phase 7).
 *
 * The naive "nearest palette color" approach PLAN.md originally assumed
 * does not hold for this image: many semantically distinct real features
 * (Field 1/2, the drop-off zone, the parking structure, even the
 * Maintenance building) share near-identical pale-grey fills — confirmed
 * empirically by sampling real pixels before writing this. So classification
 * is a small pipeline, not one lookup:
 *
 *  1. Palette match (color-distance, in priority order) for pixels with an
 *     unambiguous, distinct color: ponds (cyan), tennis turf/court (green
 *     and blue), Field 3 (pale green), background (white). Everything else
 *     pale/neutral-grey defaults to PATH (hardscape) — this is deliberately
 *     the *default*, not a guess: it's what most of the ambiguous grey area
 *     actually is (parking, roads, drop-off zone, the multi-purpose courts
 *     near the pods), and it's overridden below for the two named regions
 *     where grey actually means grass.
 *  2. Building detection is NOT by fill color (buildings' fills overlap
 *     with the grey/path family, e.g. Maintenance). Buildings are drawn
 *     with a dark, roughly-neutral outline stroke instead (brightness
 *     varies per building — see `ImportConfig.outline`'s own comment) —
 *     detected by flood-filling from the image border through every
 *     non-outline pixel; any pixel that flood can't reach is enclosed by
 *     an outline and becomes BUILDING, regardless of what step 1 guessed
 *     for it. Text sharing the outline's dark/neutral tone (the map's
 *     title, building-name labels) would otherwise also count — filtered
 *     out by requiring the enclosing shape's connected component to be
 *     larger than a real building's outline+interior, which text never is.
 *  3. Seed-region overrides: Field 1 and Field 2 are grass but share their
 *     pale grey with the hardscape default — overridden by flood-filling
 *     outward from one manually-identified point inside each, bounded by
 *     color similarity to that point's own real sampled color.
 *
 * Deliberately NOT done here: dedicated tree-icon or overlay-text/arrow
 * detection. Both are thin/sparse relative to one world block's pixel
 * footprint (~5.7px), so majority-vote downsampling (worldGrid.ts) washes
 * them out on its own — this is what PLAN.md's Phase 7 task list already
 * calls "morphological cleanup for tree-circle and hatching noise," not a
 * placement feature.
 */

export enum Label {
  UNCLASSIFIED = 0,
  GRASS = 1,
  PATH = 2,
  WATER = 3,
  COURT = 4,
  BUILDING = 5,
}

export const LABEL_TO_BLOCK: Partial<Record<Label, BlockName>> = {
  [Label.GRASS]: 'GRASS',
  [Label.PATH]: 'PATH',
  [Label.WATER]: 'WATER',
  [Label.COURT]: 'COURT',
};

interface PaletteEntry {
  name: string;
  block: BlockName;
  color?: [number, number, number];
  tolerance?: number;
  neutralGrey?: boolean;
  minBrightness?: number;
  maxBrightness?: number;
  maxChannelSpread?: number;
  /**
   * Extra hue guard: G and B must each exceed R by at least this much.
   * Needed because pond cyan (224,240,240) is close enough to plain bright
   * neutral grey under Manhattan distance alone to false-match — confirmed
   * empirically (Field 1/2's grey briefly misclassified as WATER before
   * this was added). Plain color-distance can't tell "uniformly bright
   * grey" from "pale cyan" apart; this can.
   */
  minCyanHueOffset?: number;
}

interface SeedRegion {
  name: string;
  seed: [number, number];
  block: BlockName;
}

interface IgnoreRegion {
  name: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ImportConfig {
  pixelsPerMetre: number;
  wallHeight: number;
  ignoreRegions: IgnoreRegion[];
  /**
   * Building outlines are a dark, roughly-neutral stroke — but not one
   * fixed color: sampled directly across several buildings, the stroke's
   * anti-aliased core ranges from near-black (~48,46,46) to medium grey
   * (~100,97,97) depending on the building. A brightness+neutrality test
   * (same style as the palette's `neutralGrey` rule, just at the dark end)
   * covers that whole range; a fixed-color distance match does not.
   *
   * `additionalBlockerColors`: confirmed empirically that a blue event
   * directional arrow is painted directly across part of GYM's real wall
   * in the source PNG, erasing ~40px of outline there — no amount of
   * dilation bridges a gap that wide. Treating the arrow's own color as an
   * additional enclosure blocker seals exactly this case. Safe everywhere
   * else too: an arrow is an open line, not a loop, so on its own it can
   * never create a false enclosure — it only matters where it happens to
   * cross a real wall.
   *
   * Red event text (e.g. "Ct 5&6") crosses a wall the same way, but red
   * can't be treated as an unconditional blocker like the arrow: the
   * tennis facility's red event *border* is itself one huge closed loop
   * (confirmed by measuring connected components: 8164px, vs every text
   * label's largest component at 329px), and blocking it would falsely
   * enclose the entire tennis court as a "building." `maxComponentSize`
   * makes a color's blocker status conditional on its own connected
   * component staying under that size — real for text, not for the border.
   */
  outline: {
    maxBrightness: number;
    maxChannelSpread: number;
    additionalBlockerColors: {
      name: string;
      color: [number, number, number];
      tolerance: number;
      maxComponentSize?: number;
    }[];
  };
  palette: PaletteEntry[];
  seedRegions: SeedRegion[];
}

export interface ClassifiedImage {
  width: number;
  height: number;
  labels: Uint8Array;
  /**
   * True where a pixel's *only* match was the generic near-white background
   * fallback — i.e. blank canvas margin, not a real site feature. Used to
   * derive real site bounds (excluding the large white margins around the
   * campus) rather than importing the whole image canvas.
   */
  isBackground: Uint8Array;
  unclassifiedCount: number;
}

const BLOCK_LABEL: Record<BlockName, Label> = {
  AIR: Label.UNCLASSIFIED,
  GRASS: Label.GRASS,
  DIRT: Label.UNCLASSIFIED,
  STONE: Label.UNCLASSIFIED,
  BRICK: Label.UNCLASSIFIED,
  GLASS: Label.UNCLASSIFIED,
  WOOD: Label.UNCLASSIFIED,
  PATH: Label.PATH,
  WATER: Label.WATER,
  LEAVES: Label.UNCLASSIFIED,
  COURT: Label.COURT,
};

function colorDistance(r: number, g: number, b: number, cr: number, cg: number, cb: number): number {
  return Math.abs(r - cr) + Math.abs(g - cg) + Math.abs(b - cb);
}

function matchesPalette(entry: PaletteEntry, r: number, g: number, b: number): boolean {
  if (entry.neutralGrey) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return (
      max - min <= (entry.maxChannelSpread ?? 8) &&
      max >= (entry.minBrightness ?? 0) &&
      max <= (entry.maxBrightness ?? 255)
    );
  }
  if (entry.minCyanHueOffset !== undefined) {
    if (g - r < entry.minCyanHueOffset || b - r < entry.minCyanHueOffset) return false;
  }
  const [cr, cg, cb] = entry.color!;
  return colorDistance(r, g, b, cr, cg, cb) <= (entry.tolerance ?? 20);
}

export async function classifyImage(imagePath: string, config: ImportConfig): Promise<ClassifiedImage> {
  const image = sharp(imagePath).ensureAlpha();
  const meta = await image.metadata();
  const width = meta.width!;
  const height = meta.height!;
  const raw = await image.raw().toBuffer();

  const labels = new Uint8Array(width * height);
  const isOutline = new Uint8Array(width * height);
  const isBackground = new Uint8Array(width * height);

  for (let i = 0, p = 0; i < labels.length; i++, p += 4) {
    const x = i % width;
    const y = (i / width) | 0;
    if (
      config.ignoreRegions.some(
        (region) => x >= region.x0 && x < region.x1 && y >= region.y0 && y < region.y1
      )
    ) {
      labels[i] = Label.GRASS;
      isBackground[i] = 1;
      continue;
    }

    const r = raw[p]!;
    const g = raw[p + 1]!;
    const b = raw[p + 2]!;

    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    if (maxC <= config.outline.maxBrightness && maxC - minC <= config.outline.maxChannelSpread) {
      isOutline[i] = 1;
      continue;
    }
    if (
      config.outline.additionalBlockerColors.some(
        (blocker) =>
          blocker.maxComponentSize === undefined &&
          colorDistance(r, g, b, ...blocker.color) <= blocker.tolerance
      )
    ) {
      isOutline[i] = 1;
      continue;
    }

    let label: Label = Label.UNCLASSIFIED;
    for (const entry of config.palette) {
      if (matchesPalette(entry, r, g, b)) {
        label = BLOCK_LABEL[entry.block];
        if (entry.name === 'background') isBackground[i] = 1;
        break;
      }
    }
    labels[i] = label;
  }

  // Size-conditioned blocker colors (see the config comment): compute a
  // standalone match mask for the color, connected-component it, and only
  // fold components at or under maxComponentSize into isOutline. Kept
  // separate from the main loop above because "was this pixel color-matched
  // by a size-limited blocker" can't be recovered from isOutline alone once
  // merged with the unconditional blockers/outline stroke.
  for (const blockerColor of config.outline.additionalBlockerColors) {
    if (blockerColor.maxComponentSize === undefined) continue;
    const match = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < match.length; i++, p += 4) {
      const r = raw[p]!;
      const g = raw[p + 1]!;
      const b = raw[p + 2]!;
      if (colorDistance(r, g, b, ...blockerColor.color) <= blockerColor.tolerance) {
        match[i] = 1;
      }
    }
    const visited = new Uint8Array(width * height);
    for (let start = 0; start < match.length; start++) {
      if (!match[start] || visited[start]) continue;
      const component: number[] = [];
      const stack = [start];
      visited[start] = 1;
      while (stack.length > 0) {
        const idx = stack.pop()!;
        component.push(idx);
        const x = idx % width;
        const y = (idx / width) | 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (match[nIdx] && !visited[nIdx]) {
            visited[nIdx] = 1;
            stack.push(nIdx);
          }
        }
      }
      if (component.length <= blockerColor.maxComponentSize) {
        for (const idx of component) isOutline[idx] = 1;
      }
    }
  }

  // The outline stroke is thin (1-2px) with anti-aliased edges — real
  // buildings' outlines have small gaps where a pixel falls just outside
  // the color tolerance, letting the border flood below leak straight
  // through into the interior (confirmed empirically: without this, real
  // building interiors came back reachable from the border, so no building
  // was ever detected at all). Dilate the outline mask by a couple of
  // pixels first to seal those gaps — flood-fill blocking only needs a
  // solid-enough wall, not the exact stroke width.
  //
  // This value is a real trade-off, not a free knob: the Library building
  // has one particular gap wide enough to need dilation >= 4 to seal (left
  // as a known, flagged (magenta in the diff-PNG) gap rather than chase
  // further) — but at dilation >= 4, Field 1 and the tennis courts start
  // coming back fully enclosed as false BUILDINGs instead. Confirmed by
  // bisecting 2-10: something in the map (not the dashed site-boundary
  // line — checked, it's far too light at ~235-250 brightness to match
  // this rule at all) closes a loop around them once the dilation radius
  // gets that large, and root-causing exactly what wasn't worth it against
  // the alternative of one real building staying unresolved. 3 is the
  // highest value confirmed safe against both Field 1 and the tennis
  // courts — don't raise it without re-checking those two specifically.
  const DILATE_ITERATIONS = 3;
  let blocker = isOutline;
  for (let iter = 0; iter < DILATE_ITERATIONS; iter++) {
    const next = new Uint8Array(blocker);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (blocker[idx]) continue;
        if (
          (x > 0 && blocker[idx - 1]) ||
          (x < width - 1 && blocker[idx + 1]) ||
          (y > 0 && blocker[idx - width]) ||
          (y < height - 1 && blocker[idx + width])
        ) {
          next[idx] = 1;
        }
      }
    }
    blocker = next;
  }

  // Step 2: border flood fill through non-blocker pixels; anything it
  // can't reach is enclosed by an outline stroke -> BUILDING.
  const outside = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let qHead = 0;
  let qTail = 0;

  function pushIfOutside(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const idx = y * width + x;
    if (outside[idx] || blocker[idx]) return;
    outside[idx] = 1;
    queue[qTail++] = idx;
  }

  for (let x = 0; x < width; x++) {
    pushIfOutside(x, 0);
    pushIfOutside(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    pushIfOutside(0, y);
    pushIfOutside(width - 1, y);
  }

  while (qHead < qTail) {
    const idx = queue[qHead++]!;
    const x = idx % width;
    const y = (idx / width) | 0;
    pushIfOutside(x + 1, y);
    pushIfOutside(x - 1, y);
    pushIfOutside(x, y + 1);
    pushIfOutside(x, y - 1);
  }

  // isOutline/enclosed candidates include real building outlines but also
  // navy text (the "MAP OF VENUE" title, building-name labels like
  // "College 1") — confirmed empirically: the title text's color is a near
  // exact match for the outline color, and was corrupting the real-content
  // bounding box by pulling it toward the image corner. Filter by
  // connected-component size: real building outlines are large connected
  // shapes; text glyphs are small, mostly-disconnected blobs. Components
  // under the threshold are dropped back to their pre-outline label
  // (effectively: treated as if the text pixels weren't there).
  const MIN_BUILDING_COMPONENT_PIXELS = 150;
  const candidate = new Uint8Array(width * height);
  for (let i = 0; i < labels.length; i++) {
    if (isOutline[i] || !outside[i]) candidate[i] = 1;
  }

  const componentVisited = new Uint8Array(width * height);
  const stack: number[] = [];
  for (let start = 0; start < candidate.length; start++) {
    if (!candidate[start] || componentVisited[start]) continue;
    const component: number[] = [];
    stack.push(start);
    componentVisited[start] = 1;
    while (stack.length > 0) {
      const idx = stack.pop()!;
      component.push(idx);
      const x = idx % width;
      const y = (idx / width) | 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (candidate[nIdx] && !componentVisited[nIdx]) {
          componentVisited[nIdx] = 1;
          stack.push(nIdx);
        }
      }
    }
    if (component.length >= MIN_BUILDING_COMPONENT_PIXELS) {
      for (const idx of component) labels[idx] = Label.BUILDING;
    }
    // else: too small to be a real building outline (text/noise) — leave
    // labels[idx] at whatever step 1's palette match already gave it.
  }

  // Step 3: seed-region overrides (Field 1 / Field 2) — flood outward from
  // each seed through 4-connected PATH-labeled pixels. `labels[nIdx] ===
  // PATH` is the only admission test: PATH already means "matched the
  // hardscapeGrey rule," a principled category, so no extra per-pixel
  // color-distance-to-seed check is needed — and an earlier version that
  // added one was actively wrong, confirmed empirically: the fill has real
  // anti-aliasing/dither noise (a seed pixel sampled at 224 sits in a
  // field whose dominant tone is 237, a 39-point gap that exceeded a
  // 24-tolerance distance check and stopped the flood after ~1px). Since
  // PATH-classified pixels don't reach past Field 1/2's true edges anyway
  // (bounded by white background, which classifies as GRASS not PATH, and
  // by non-grey building/pond/court colors elsewhere), this can't bleed
  // into unrelated hardscape the way an unbounded fill would.
  for (const region of config.seedRegions) {
    const [sx, sy] = region.seed;
    const sIdx = sy * width + sx;
    const targetLabel = BLOCK_LABEL[region.block];

    const visited = new Uint8Array(width * height);
    const stack: number[] = [sIdx];
    visited[sIdx] = 1;

    while (stack.length > 0) {
      const idx = stack.pop()!;
      labels[idx] = targetLabel;
      const x = idx % width;
      const y = (idx / width) | 0;

      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (visited[nIdx] || labels[nIdx] !== Label.PATH) continue;
        visited[nIdx] = 1;
        stack.push(nIdx);
      }
    }
  }

  let unclassifiedCount = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === Label.UNCLASSIFIED) unclassifiedCount++;
  }

  return { width, height, labels, isBackground, unclassifiedCount };
}
