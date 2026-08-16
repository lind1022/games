import Database from 'better-sqlite3';
import { CHUNK_FORMAT_VERSION, decodeChunk, encodeChunk } from '@game/shared';

/**
 * SQLite persistence — Phase 1 scope only: `chunks` + `block_changes`.
 *
 * `block_changes` deliberately omits the `code_hash` FK to `join_codes`
 * from PLAN.md §6's full schema — join codes don't exist until Phase 4.
 * `display_name` is the only identity available during the dev-stub join
 * (Phases 1-3); Phase 4 adds `code_hash` via a migration once join_codes
 * exists.
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

      -- Like block_changes, deliberately omits the code_hash FK to
      -- join_codes from PLAN.md §6's full schema — join codes don't exist
      -- until Phase 4. display_name is the only identity available now.
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
    `);
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

  close(): void {
    this.db.close();
  }
}
