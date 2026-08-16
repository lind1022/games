import { createHmac, randomBytes, randomInt } from 'node:crypto';

/**
 * Join-code and session-token generation/hashing (PLAN.md Phase 4).
 *
 * Codes and tokens are only ever handled as plaintext transiently (at
 * creation, and in transit to the client that owns them) — everything at
 * rest (`join_codes.code_hash`, `sessions.token_hash`) is an HMAC-SHA256
 * digest, so a leaked `.db` file or backup can't be used to impersonate a
 * child.
 */

const PEPPER = process.env.JOIN_CODE_PEPPER ?? 'dev-only-insecure-pepper-change-in-production';
if (!process.env.JOIN_CODE_PEPPER) {
  console.warn(
    '[auth] JOIN_CODE_PEPPER is not set — using an insecure default. ' +
      'Set a real secret before deploying anywhere real children will use.'
  );
}

export function hashWithPepper(value: string): string {
  return createHmac('sha256', PEPPER).update(value).digest('hex');
}

// Crockford-style alphabet, further restricted per PLAN.md Phase 4: exclude
// 0/O, 1/I/L (ambiguous glyphs young children mistype) AND vowels (so a code
// never accidentally spells a word). What's left: digits 2-9, consonants only.
const CODE_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 6;

export function generateJoinCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/** Server-side normalization so a child's code works regardless of case. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/** 256 bits of entropy, base64url-encoded for easy storage/transport. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

// Proposed default (PLAN.md §8, open question #5): sliding expiry somewhere
// in a 30-90 day range. 60 days as a middle-ground default — tune later.
export const SESSION_EXPIRY_MS = 60 * 24 * 60 * 60 * 1000;
