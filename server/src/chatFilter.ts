import {
  RegExpMatcher,
  TextCensor,
  asteriskCensorStrategy,
  englishDataset,
  englishRecommendedTransformers,
  skipNonAlphabeticTransformer,
} from 'obscenity';

/**
 * Server-side chat safety layer (PLAN.md Phase 3 / CLAUDE.md §7). Masks,
 * never hard-blocks: the caller always gets a message to broadcast, plus a
 * flag for logging. Filtering is entirely in-process — no child's chat text
 * ever leaves this server to a third-party moderation API.
 *
 * WHITELIST is empty for now — there are no real children's names or
 * school-specific vocabulary yet (dev-stub identity, Phases 1-3). PLAN.md
 * calls seeding this out as a **critical pre-launch step**: add every
 * child's display name and school vocabulary here, then smoke-test them
 * through the filter, before Phase 4 goes live with real names. The
 * Scunthorpe problem bites hardest on exactly names and places.
 */
const WHITELIST: readonly string[] = [];

const builtDataset = englishDataset.build();

const matcher = new RegExpMatcher({
  ...builtDataset,
  whitelistedTerms: [...(builtDataset.whitelistedTerms ?? []), ...WHITELIST],
  whitelistMatcherTransformers: englishRecommendedTransformers.whitelistMatcherTransformers,
  // The recommended preset deliberately omits skipNonAlphabeticTransformer
  // (upstream issues #23/#46 — it can over-match across word boundaries).
  // We add it back: this is a mask-don't-block system, so a false positive
  // just over-asterisks a harmless phrase, while a false negative lets
  // spaced-out evasion ("f u c k", "f.u.c.k") straight through — the wrong
  // side to err on for a children's chat filter. Verified against a battery
  // of cross-word-boundary phrases ("class assignment", "the assassin
  // game", "glass door", etc.) with no false positives before adopting.
  blacklistMatcherTransformers: [
    ...(englishRecommendedTransformers.blacklistMatcherTransformers ?? []),
    skipNonAlphabeticTransformer(),
  ],
});

const censor = new TextCensor().setStrategy(asteriskCensorStrategy());

interface PiiHeuristic {
  pattern: RegExp;
  reason: string;
}

// High-severity *log tags*, not auto-blocks (PLAN.md Phase 3) — these
// false-positive too easily (e.g. "meet me at spawn") to justify blocking a
// child's message outright. An admin reviews flagged messages instead.
const PII_HEURISTICS: readonly PiiHeuristic[] = [
  { pattern: /\d{7,}/, reason: 'digit-run' },
  { pattern: /\bmeet\s*me\b/i, reason: 'meet-me' },
  { pattern: /\b(your|ur)\s+real\s+name\b/i, reason: 'asks-real-name' },
  { pattern: /\b(street|address|postcode|zip\s*code)\b/i, reason: 'address-ish' },
];

export interface ChatFilterResult {
  /** What should actually be broadcast — normalized, and masked if flagged for profanity. */
  filteredMessage: string;
  flagged: boolean;
  /** Comma-joined reason tags (e.g. "profanity,meet-me"), for chat_log review. */
  flagReason: string | null;
}

/**
 * NFKC collapses unicode-lookalike evasion (e.g. fullwidth characters) to a
 * canonical form before matching; control characters are stripped outright.
 * The *normalized* text, not the raw original, is what gets broadcast — for
 * masked and clean messages alike — so nobody downstream sees ambient
 * unicode weirdness a child pasted in. The true raw text is still preserved
 * in chat_log's `message` column for audit purposes; only the broadcast
 * copy is normalized.
 */
function normalize(text: string): string {
  return text.normalize('NFKC').replace(/[\x00-\x1F\x7F]/g, '');
}

export function filterChatMessage(rawText: string): ChatFilterResult {
  const text = normalize(rawText);

  const matches = matcher.getAllMatches(text);
  const filteredMessage = matches.length > 0 ? censor.applyTo(text, matches) : text;

  const piiReasons = PII_HEURISTICS.filter((h) => h.pattern.test(text)).map((h) => h.reason);
  const reasons = matches.length > 0 ? ['profanity', ...piiReasons] : piiReasons;

  return {
    filteredMessage,
    flagged: reasons.length > 0,
    flagReason: reasons.length > 0 ? reasons.join(',') : null,
  };
}
