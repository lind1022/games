import { BLOCKS, type BlockDef } from '@game/shared';
import { blockLayer } from './blockLayer.js';

/**
 * Block-selection hotbar (PLAN.md Phase 8) — previously there wasn't one at
 * all: the block a click placed was a single hardcoded constant
 * (`PLACEMENT_BLOCK` in main.ts), so every player could only ever place
 * STONE, regardless of anything else this project already supports.
 *
 * Every non-AIR block gets a slot, in `shared/src/blocks.ts` id order —
 * keys 1-9 select slots 1-9, 0 selects the 10th (Minecraft's convention),
 * matching this project's exactly-10-block-type roster today. Each slot's
 * icon reuses the real texture-array source image (public/textures/
 * blocks.png) via a CSS background-position crop, rather than a separate
 * icon asset — same tiles the world itself renders, always in sync with
 * however textures.ts's build script maps blocks to tiles.
 */

const SLOTS: readonly BlockDef[] = Object.values(BLOCKS).filter((block) => block.id !== BLOCKS.AIR.id);
const SLOT_PX = 48;

export class Hotbar {
  private selectedIndex = 0;
  private readonly slotEls: HTMLElement[] = [];

  constructor(private readonly container: HTMLElement) {
    for (let i = 0; i < SLOTS.length; i++) {
      const block = SLOTS[i]!;
      const layer = blockLayer(block.id);
      const el = document.createElement('div');
      el.className = 'hotbar-slot';
      el.style.backgroundImage = 'url(/textures/blocks.png)';
      // Scales the whole stacked source image (see textures.ts) down so
      // each of its tiles becomes exactly SLOT_PX square, then crops to
      // just this block's layer via backgroundPosition.
      el.style.backgroundSize = `${SLOT_PX}px ${SLOT_PX * SLOTS.length}px`;
      el.style.backgroundPosition = `0 -${layer * SLOT_PX}px`;
      el.title = block.name;

      const keyLabel = document.createElement('span');
      keyLabel.className = 'hotbar-key';
      keyLabel.textContent = String((i + 1) % 10); // slot 9 -> "0", matching keyboard handling below
      el.appendChild(keyLabel);

      container.appendChild(el);
      this.slotEls.push(el);
    }
    this.render();
  }

  get selectedBlockId(): number {
    return SLOTS[this.selectedIndex]!.id;
  }

  /** Handles digit keys ("1".."9", "0") — main.ts gates this the same way it gates movement while chat is open. */
  handleKey(code: string): boolean {
    const match = /^Digit([0-9])$/.exec(code);
    if (!match) return false;
    const digit = Number(match[1]);
    const index = digit === 0 ? 9 : digit - 1;
    if (index >= SLOTS.length) return false;
    this.select(index);
    return true;
  }

  /** Mouse wheel cycling — deltaY > 0 (scroll down) advances, matching the common convention. */
  handleWheel(deltaY: number): void {
    const delta = deltaY > 0 ? 1 : -1;
    this.select((this.selectedIndex + delta + SLOTS.length) % SLOTS.length);
  }

  private select(index: number): void {
    this.selectedIndex = index;
    this.render();
  }

  private render(): void {
    this.slotEls.forEach((el, i) => el.classList.toggle('selected', i === this.selectedIndex));
  }
}
