import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { CHUNK_FORMAT_VERSION, encodeChunk } from '@game/shared';
import { classifyImage, type ImportConfig } from './classify.js';
import { buildWorldGrid } from './worldGrid.js';
import { renderDiffPng } from './diffRender.js';

/**
 * School map importer entry point (PLAN.md Phase 7).
 *
 * Usage:
 *   npm run import-map -w tools                                 # classify + diff-PNG only (safe default)
 *   npm run import-map -w tools -- --write /path/to/data-dir     # also writes world.db's chunks table
 *
 * Never run --write against a live server's data dir — PLAN.md's own
 * "Applying to production" policy: back up first (VACUUM INTO), run
 * locally against a throwaway copy, review the diff-PNG, only then apply
 * with the service stopped.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MAP_PATH = path.join(REPO_ROOT, 'school map.png');
const CONFIG_PATH = path.join(REPO_ROOT, 'tools', 'import-config.json');

async function main() {
  const args = process.argv.slice(2);
  const writeIdx = args.indexOf('--write');
  const writeDataDir = writeIdx >= 0 ? args[writeIdx + 1] : undefined;
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1]! : path.join(REPO_ROOT, 'tools', 'diff.png');

  const config: ImportConfig = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));

  console.log('Classifying', MAP_PATH, '...');
  const classified = await classifyImage(MAP_PATH, config);
  console.log(`  ${classified.width}x${classified.height}px, unclassified: ${classified.unclassifiedCount} px`);

  console.log('Building world grid...');
  const grid = buildWorldGrid(classified, config);
  const pctUnclassified = ((grid.unclassifiedBlocks / grid.blockGrid.length) * 100).toFixed(2);
  console.log(`  imported area: ${grid.importedWidthBlocks} x ${grid.importedDepthBlocks} blocks`);
  console.log(`  world: ${grid.worldChunks}x${grid.worldChunks} chunks (${grid.worldSize}x${grid.worldSize} blocks, square)`);
  console.log(`  unclassified blocks: ${grid.unclassifiedBlocks} (${pctUnclassified}%) — rendered magenta in the diff-PNG`);
  console.log(`  spawn: (${grid.spawnX}, ${grid.spawnZ})`);

  console.log('Rendering diff-PNG to', outPath);
  await renderDiffPng(grid.blockGrid, grid.importedWidthBlocks, grid.importedDepthBlocks, outPath);

  if (!writeDataDir) {
    console.log('\nNo --write given — nothing written to any database. Review the diff-PNG next.');
    return;
  }

  const dbPath = path.join(writeDataDir, 'world.db');
  console.log(`\n--write given: writing ${grid.worldChunks * grid.worldChunks} chunks to ${dbPath}`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      chunk_x        INTEGER NOT NULL,
      chunk_z        INTEGER NOT NULL,
      format_version INTEGER NOT NULL DEFAULT 1,
      block_data     BLOB NOT NULL,
      updated_at     INTEGER NOT NULL,
      PRIMARY KEY (chunk_x, chunk_z)
    );
  `);
  const insert = db.prepare(`
    INSERT INTO chunks (chunk_x, chunk_z, format_version, block_data, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (chunk_x, chunk_z) DO UPDATE SET
      format_version = excluded.format_version,
      block_data = excluded.block_data,
      updated_at = excluded.updated_at
  `);
  const writeAll = db.transaction(() => {
    for (let cx = 0; cx < grid.worldChunks; cx++) {
      for (let cz = 0; cz < grid.worldChunks; cz++) {
        const blocks = grid.getChunkBlocks(cx, cz);
        const encoded = Buffer.from(encodeChunk(blocks));
        insert.run(cx, cz, CHUNK_FORMAT_VERSION, encoded, Date.now());
      }
    }
  });
  writeAll();
  db.close();
  console.log('Done. Remember: server/src/world.ts WORLD_CHUNKS must match', grid.worldChunks, 'for the server to load this.');
}

main();
