import Database from 'better-sqlite3';
import { CHUNK_FORMAT_VERSION, decodeChunk, encodeChunk } from '@game/shared';
import {
  SESSION_EXPIRY_MS,
  generateJoinCode,
  generateSessionToken,
  hashWithPepper,
  normalizeCode,
} from './auth.js';

/**
 * SQLite persistence: `chunks` + `block_changes` (Phase 1), `chat_log`
 * (Phase 3), `join_codes` + `sessions` (Phase 4).
 *
 * `block_changes` and `chat_log` still key identity by `display_name` alone
 * rather than the `code_hash` FK PLAN.md §6's full schema calls for —
 * that's a follow-up migration, not done here, since it's not required for
 * Phase 4's "done when" criteria and touches already-shipped tables.
 *
 * Pure write-through (PLAN.md C6): every block change rewrites the whole
 * chunk blob and appends to block_changes in one transaction. No in-memory
 * dirty buffer, so there's nothing to lose on an ungraceful shutdown — the
 * dirty-chunk flush optimization is Phase 6 scope.
 */

export interface BlockChangeParams {
  chunkX: number;
  chunkZ: number;
  blockData: Uint8Array;
  x: number;
  y: number;
  z: number;
  oldBlockId: number;
  newBlockId: number;
  displayName: string;
}

export class GameDb {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        chunk_x        INTEGER NOT NULL,
        chunk_z        INTEGER NOT NULL,
        format_version INTEGER NOT NULL DEFAULT 1,
        block_data     BLOB NOT NULL,
        updated_at     INTEGER NOT NULL,
        PRIMARY KEY (chunk_x, chunk_z)
      );

      CREATE TABLE IF NOT EXISTS block_changes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           INTEGER NOT NULL,
        chunk_x      INTEGER NOT NULL,
        chunk_z      INTEGER NOT NULL,
        x            INTEGER NOT NULL,
        y            INTEGER NOT NULL,
        z            INTEGER NOT NULL,
        old_block_id INTEGER NOT NULL,
        new_block_id INTEGER NOT NULL,
        display_name TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bc_ts ON block_changes(ts);
      CREATE INDEX IF NOT EXISTS idx_bc_chunk_ts ON block_changes(chunk_x, chunk_z, ts);

      CREATE TABLE IF NOT EXISTS chat_log (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        ts               INTEGER NOT NULL,
        display_name     TEXT NOT NULL,
        message          TEXT NOT NULL,
        filtered_message TEXT NOT NULL,
        flagged          INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0,1)),
        flag_reason      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_chat_ts ON chat_log(ts);

      CREATE TABLE IF NOT EXISTS join_codes (
        code_hash    TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        disabled     INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
        revoked_at   INTEGER,
        -- Admin mute (Phase 5): lives on the code, not the session, so it
        -- survives reconnects. Not in PLAN.md §6's original schema sketch,
        -- but "mute" is one of the four named moderation actions and has
        -- to be stored somewhere durable.
        muted        INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0,1))
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash    TEXT PRIMARY KEY,
        code_hash     TEXT NOT NULL REFERENCES join_codes(code_hash),
        display_name  TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        last_seen     INTEGER NOT NULL,
        revoked       INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
        revoke_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_code ON sessions(code_hash);
      -- Enforces C5's invariant (at most one active session per code) even
      -- if the application-level takeover logic in index.ts has a bug.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_one_active
        ON sessions(code_hash) WHERE revoked = 0;
    `);

    // CREATE TABLE IF NOT EXISTS is a no-op on a table that already exists —
    // it does NOT add new columns to it. `join_codes` shipped in Phase 4
    // without `muted`; Phase 5 added the column to the CREATE TABLE above,
    // which only takes effect for a brand-new DB file. Anyone upgrading an
    // existing world.db needs this explicit migration or every muted/unmute
    // call fails with "no such column: muted".
    this.ensureColumn('join_codes', 'muted', 'muted INTEGER NOT NULL DEFAULT 0');
  }

  private ensureColumn(table: string, column: string, addColumnDef: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${addColumnDef}`);
    }
  }

  loadChunk(chunkX: number, chunkZ: number): Uint8Array | undefined {
    const row = this.db
      .prepare('SELECT block_data FROM chunks WHERE chunk_x = ? AND chunk_z = ?')
      .get(chunkX, chunkZ) as { block_data: Buffer } | undefined;
    if (!row) return undefined;
    return decodeChunk(row.block_data);
  }

  saveChunk(chunkX: number, chunkZ: number, blocks: Uint8Array): void {
    const encoded = Buffer.from(encodeChunk(blocks));
    this.db
      .prepare(
        `INSERT INTO chunks (chunk_x, chunk_z, format_version, block_data, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (chunk_x, chunk_z) DO UPDATE SET
           format_version = excluded.format_version,
           block_data = excluded.block_data,
           updated_at = excluded.updated_at`
      )
      .run(chunkX, chunkZ, CHUNK_FORMAT_VERSION, encoded, Date.now());
  }

  private recordBlockChange(params: Omit<BlockChangeParams, 'blockData'>): void {
    this.db
      .prepare(
        `INSERT INTO block_changes
           (ts, chunk_x, chunk_z, x, y, z, old_block_id, new_block_id, display_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        Date.now(),
        params.chunkX,
        params.chunkZ,
        params.x,
        params.y,
        params.z,
        params.oldBlockId,
        params.newBlockId,
        params.displayName
      );
  }

  /** Rewrites the chunk blob and appends the change record in one transaction. */
  persistBlockUpdate(params: BlockChangeParams): void {
    const tx = this.db.transaction(() => {
      this.saveChunk(params.chunkX, params.chunkZ, params.blockData);
      this.recordBlockChange(params);
    });
    tx();
  }

  /** Always logs the raw (pre-filter) text — never only the masked/broadcast form. */
  insertChatMessage(params: {
    displayName: string;
    message: string;
    filteredMessage: string;
    flagged: boolean;
    flagReason: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO chat_log (ts, display_name, message, filtered_message, flagged, flag_reason)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        Date.now(),
        params.displayName,
        params.message,
        params.filteredMessage,
        params.flagged ? 1 : 0,
        params.flagReason
      );
  }

  /** Returns the plaintext code — the ONLY time it's ever available; only the hash is stored. */
  createJoinCode(displayName: string): string {
    const code = generateJoinCode();
    this.db
      .prepare(
        `INSERT INTO join_codes (code_hash, display_name, created_at)
         VALUES (?, ?, ?)`
      )
      .run(hashWithPepper(code), displayName, Date.now());
    return code;
  }

  /** Resolves a plaintext code to its identity, or undefined if invalid/disabled. */
  lookupJoinCode(code: string): { codeHash: string; displayName: string } | undefined {
    const codeHash = hashWithPepper(normalizeCode(code));
    const row = this.db
      .prepare('SELECT display_name FROM join_codes WHERE code_hash = ? AND disabled = 0')
      .get(codeHash) as { display_name: string } | undefined;
    if (!row) return undefined;
    return { codeHash, displayName: row.display_name };
  }

  /**
   * Session takeover (PLAN.md C5): in one transaction, revoke any existing
   * active session for this code (reason 'superseded'), then insert the
   * new one. The partial unique index backs this up even if this method is
   * ever bypassed. Returns the plaintext token — the only time it's ever
   * available.
   */
  createSession(codeHash: string, displayName: string): string {
    const token = generateSessionToken();
    const tokenHash = hashWithPepper(token);
    const now = Date.now();

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE sessions SET revoked = 1, revoke_reason = 'superseded'
           WHERE code_hash = ? AND revoked = 0`
        )
        .run(codeHash);
      this.db
        .prepare(
          `INSERT INTO sessions (token_hash, code_hash, display_name, created_at, last_seen)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(tokenHash, codeHash, displayName, now, now);
    });
    tx();

    return token;
  }

  /** Resolves a plaintext session token, or undefined if invalid/revoked/expired. */
  lookupSession(token: string): { tokenHash: string; codeHash: string; displayName: string } | undefined {
    const tokenHash = hashWithPepper(token);
    const row = this.db
      .prepare('SELECT code_hash, display_name, last_seen FROM sessions WHERE token_hash = ? AND revoked = 0')
      .get(tokenHash) as { code_hash: string; display_name: string; last_seen: number } | undefined;
    if (!row) return undefined;
    if (Date.now() - row.last_seen > SESSION_EXPIRY_MS) return undefined;
    return { tokenHash, codeHash: row.code_hash, displayName: row.display_name };
  }

  /** Sliding expiry: call whenever a session is actively used. */
  touchSession(tokenHash: string): void {
    this.db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(Date.now(), tokenHash);
  }

  // -------------------------------------------------------------------
  // Admin (PLAN.md Phase 5)
  // -------------------------------------------------------------------

  listJoinCodes(): { codeHash: string; displayName: string; createdAt: number; disabled: boolean; muted: boolean }[] {
    const rows = this.db
      .prepare('SELECT code_hash, display_name, created_at, disabled, muted FROM join_codes ORDER BY created_at DESC')
      .all() as { code_hash: string; display_name: string; created_at: number; disabled: number; muted: number }[];
    return rows.map((r) => ({
      codeHash: r.code_hash,
      displayName: r.display_name,
      createdAt: r.created_at,
      disabled: r.disabled === 1,
      muted: r.muted === 1,
    }));
  }

  isMuted(codeHash: string): boolean {
    const row = this.db.prepare('SELECT muted FROM join_codes WHERE code_hash = ?').get(codeHash) as
      | { muted: number }
      | undefined;
    return row?.muted === 1;
  }

  setCodeMuted(codeHash: string, muted: boolean): void {
    this.db.prepare('UPDATE join_codes SET muted = ? WHERE code_hash = ?').run(muted ? 1 : 0, codeHash);
  }

  /** Revoke (PLAN.md Phase 5): disables the code and kills its active session in one transaction. */
  revokeJoinCode(codeHash: string): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare('UPDATE join_codes SET disabled = 1, revoked_at = ? WHERE code_hash = ?')
        .run(Date.now(), codeHash);
      this.db
        .prepare(`UPDATE sessions SET revoked = 1, revoke_reason = 'admin' WHERE code_hash = ? AND revoked = 0`)
        .run(codeHash);
    });
    tx();
  }

  getChatLog(filter: { flaggedOnly?: boolean; displayName?: string; limit?: number }): {
    ts: number;
    displayName: string;
    message: string;
    filteredMessage: string;
    flagged: boolean;
    flagReason: string | null;
  }[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (filter.flaggedOnly) conditions.push('flagged = 1');
    if (filter.displayName) {
      conditions.push('display_name = ?');
      params.push(filter.displayName);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT ts, display_name, message, filtered_message, flagged, flag_reason
                FROM chat_log ${where} ORDER BY ts DESC LIMIT ?`)
      .all(...params, limit) as {
      ts: number;
      display_name: string;
      message: string;
      filtered_message: string;
      flagged: number;
      flag_reason: string | null;
    }[];
    return rows.map((r) => ({
      ts: r.ts,
      displayName: r.display_name,
      message: r.message,
      filteredMessage: r.filtered_message,
      flagged: r.flagged === 1,
      flagReason: r.flag_reason,
    }));
  }

  /** Rollback (PLAN.md Phase 5): a player's block edits in the last N minutes, most recent first. */
  getRecentBlockChanges(
    displayName: string,
    sinceMs: number
  ): { x: number; y: number; z: number; oldBlockId: number }[] {
    const rows = this.db
      .prepare(
        `SELECT x, y, z, old_block_id FROM block_changes
         WHERE display_name = ? AND ts >= ? ORDER BY ts DESC`
      )
      .all(displayName, sinceMs) as { x: number; y: number; z: number; old_block_id: number }[];
    return rows.map((r) => ({ x: r.x, y: r.y, z: r.z, oldBlockId: r.old_block_id }));
  }

  close(): void {
    this.db.close();
  }
}
