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
 * WHITELIST covers real children's display names and school-specific
 * vocabulary (PLAN.md's critical pre-launch step — the Scunthorpe problem
 * bites hardest on exactly names and places). Lowercase: the library's
 * recommended whitelist transformers lowercase the input before matching,
 * so terms are written lowercase to match. Entries are substrings, not
 * whole-word matches — e.g. 'college' also covers 'College 1'..'College 5'
 * and 'field' covers 'Field 1'..'Field 3', per PLAN.md §3's map inspection.
 * Smoke-tested (not checked in): none of these actually collide with the
 * dataset's blacklist as substrings today, so this is precautionary
 * defense-in-depth rather than a fix for a live false positive — add new
 * names/terms here as more join codes are issued or more vocabulary comes
 * up, and re-run the smoke test rather than assuming it's still clean.
 */
const WHITELIST: readonly string[] = [
  // Real children's display names (join codes issued so far)
  'eddie',
  'jayson',

  // School name and campus vocabulary (school map.png via PLAN.md §3)
  'pinehurst',
  'pinehurst school',
  'college',
  'junior college',
  'theatre',
  'library',
  'gym',
  'administration',
  'primary admin',
  'maintenance',
  'afsc',
  'field',
  'carpark',
  'drop-off zone',
];

const builtDataset = englishDataset.build();

const sharedWhitelistOptions = {
  whitelistedTerms: [...(builtDataset.whitelistedTerms ?? []), ...WHITELIST],
  whitelistMatcherTransformers: englishRecommendedTransformers.whitelistMatcherTransformers,
};

// Two matchers, not one, run together — never one instead of the other.
//
// `strictMatcher` uses the library's own recommended transformers: it's the
// one that correctly catches ordinary mid-sentence placement.
//
// `evasionMatcher` additionally adds skipNonAlphabeticTransformer() (upstream
// issues #23/#46) to catch letter-spaced evasion ("f u c k", "f.u.c.k") the
// strict matcher misses. But it has a serious trade-off, found empirically
// while smoke-testing: patterns anchored on BOTH sides by a word-boundary
// assertion (e.g. `|tit|`, `|prick[s]|`) stop matching whenever the flagged
// word is sandwiched between other words, because the transformer strips the
// surrounding spaces the boundary assertion needs — e.g. "shit now" and
// "this is shit" still match (word at the very start/end), but "hey shit
// now" (word in the middle — the common case in real sentences) silently
// doesn't. This isn't specific to one word: it silently defeated ~20
// dataset entries this way, including core words like "shit", "cunt",
// "rape", "cock", "fag", "whore", and "sex". Running BOTH matchers and
// unioning their matches (below) keeps both properties instead of trading
// one for the other: strictMatcher's mid-sentence detection is never
// weakened, and evasionMatcher still adds its spaced-out-evasion catches.
// Verified against a battery of cross-word-boundary phrases ("class
// assignment", "the assassin game", "grass stains", "glass door", etc.)
// with no false positives from either matcher.
const strictMatcher = new RegExpMatcher({
  ...builtDataset,
  ...sharedWhitelistOptions,
  blacklistMatcherTransformers: englishRecommendedTransformers.blacklistMatcherTransformers,
});

const evasionMatcher = new RegExpMatcher({
  ...builtDataset,
  ...sharedWhitelistOptions,
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

  const matches = [...strictMatcher.getAllMatches(text), ...evasionMatcher.getAllMatches(text)];
  const filteredMessage = matches.length > 0 ? censor.applyTo(text, matches) : text;

  const piiReasons = PII_HEURISTICS.filter((h) => h.pattern.test(text)).map((h) => h.reason);
  const reasons = matches.length > 0 ? ['profanity', ...piiReasons] : piiReasons;

  return {
    filteredMessage,
    flagged: reasons.length > 0,
    flagReason: reasons.length > 0 ? reasons.join(',') : null,
  };
}
