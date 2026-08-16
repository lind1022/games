import argon2 from 'argon2';

/**
 * Prints an argon2id hash for `ADMIN_PASSWORD_HASH` (PLAN.md Phase 5).
 * Usage: `npm run hash-admin-password -w server -- "<password>"`
 */

const password = process.argv[2];
if (!password) {
  console.error('Usage: npm run hash-admin-password -w server -- "<password>"');
  process.exit(1);
}

const hash = await argon2.hash(password, { type: argon2.argon2id });
console.log(`\nADMIN_PASSWORD_HASH=${hash}\n`);
console.log('Set this as an environment variable where the server runs. The plaintext password is not stored anywhere.\n');
