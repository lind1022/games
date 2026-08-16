import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameDb } from './db.js';

/**
 * Admin CLI for issuing a join code (PLAN.md Phase 4). There's no admin
 * panel yet — that's Phase 5 — so this is the only way to create a code
 * until then. Usage: `npm run create-code -w server -- "Jack"`.
 *
 * The printed code is the only time it's ever available in plaintext —
 * only its hash is stored (see auth.ts).
 */

const displayName = process.argv[2]?.trim();
if (!displayName) {
  console.error('Usage: npm run create-code -w server -- "<display name>"');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../');
const DATA_DIR = process.env.DATA_DIR ?? path.join(REPO_ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'world.db');

mkdirSync(DATA_DIR, { recursive: true });

const db = new GameDb(DB_PATH);
const code = db.createJoinCode(displayName);
db.close();

console.log(`\nJoin code for "${displayName}": ${code}\n`);
console.log('This is shown once — write it down. It cannot be recovered from the database.\n');
