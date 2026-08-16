import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';

/**
 * Admin authentication (PLAN.md Phase 5): a single admin account, since
 * this project has exactly one admin role (§1). No user table — the
 * password hash lives in an env var (`ADMIN_PASSWORD_HASH`, produced by
 * `hashAdminPassword.ts`), sidestepping "how do you create the first
 * admin account" entirely.
 *
 * Sessions are kept in memory only (not persisted to the DB): losing them
 * on a server restart just means the admin logs in again, which is a
 * fine trade for not writing admin session material to disk.
 */

const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
if (!ADMIN_PASSWORD_HASH) {
  console.warn(
    '[admin] ADMIN_PASSWORD_HASH is not set — /admin is unreachable until it is. ' +
      'Generate one with: npm run hash-admin-password -w server -- "<password>"'
  );
}

export const ADMIN_SESSION_COOKIE = 'admin_session';
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000; // 12h

const adminSessions = new Map<string, number>(); // token -> expiresAt

export async function verifyAdminPassword(password: string): Promise<boolean> {
  if (!ADMIN_PASSWORD_HASH) return false;
  try {
    return await argon2.verify(ADMIN_PASSWORD_HASH, password);
  } catch {
    return false;
  }
}

export function createAdminSession(): string {
  const token = randomBytes(32).toString('base64url');
  adminSessions.set(token, Date.now() + SESSION_DURATION_MS);
  return token;
}

export function isValidAdminSession(token: string | undefined): boolean {
  if (!token) return false;
  const expiresAt = adminSessions.get(token);
  if (expiresAt === undefined) return false;
  if (Date.now() > expiresAt) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

export function destroyAdminSession(token: string | undefined): void {
  if (token) adminSessions.delete(token);
}
