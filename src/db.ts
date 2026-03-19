/**
 * SQLite translation cache using bun:sqlite.
 * Caches translations to avoid redundant API calls.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";

const DB_PATH = join(import.meta.dir, "..", "translations.db");

const db = new Database(DB_PATH, { create: true });

// Initialize schema
db.run(`
  CREATE TABLE IF NOT EXISTS translations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_text TEXT NOT NULL,
    translated_text TEXT NOT NULL,
    source_lang TEXT NOT NULL,
    target_lang TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(source_text, source_lang, target_lang)
  )
`);

db.run(`CREATE INDEX IF NOT EXISTS idx_lookup ON translations(source_text, source_lang, target_lang)`);

const stmtGet = db.prepare<{ translated_text: string }, [string, string, string]>(
  `SELECT translated_text FROM translations WHERE source_text = ? AND source_lang = ? AND target_lang = ?`
);

const stmtInsert = db.prepare(
  `INSERT OR REPLACE INTO translations (source_text, translated_text, source_lang, target_lang) VALUES (?, ?, ?, ?)`
);

/** Look up a cached translation */
export function getCached(text: string, from: string, to: string): string | null {
  const row = stmtGet.get(text, from, to);
  return row ? row.translated_text : null;
}

/** Store a translation in cache */
export function setCache(text: string, translated: string, from: string, to: string): void {
  stmtInsert.run(text, translated, from, to);
}

/** Batch lookup — returns array of cached results (null if not found) */
export function getCachedBatch(texts: string[], from: string, to: string): (string | null)[] {
  return texts.map((t) => getCached(t, from, to));
}

/** Get cache stats */
export function getCacheStats(): { total: number; languages: Array<{ pair: string; count: number }> } {
  const total = db.prepare<{ count: number }, []>(
    `SELECT COUNT(*) as count FROM translations`
  ).get()!.count;

  const languages = db.prepare<{ pair: string; count: number }, []>(
    `SELECT source_lang || ' → ' || target_lang as pair, COUNT(*) as count FROM translations GROUP BY source_lang, target_lang ORDER BY count DESC`
  ).all();

  return { total, languages };
}

/** Clear cache for a specific language pair, or all */
export function clearCache(from?: string, to?: string): number {
  if (from && to) {
    const info = db.run(`DELETE FROM translations WHERE source_lang = ? AND target_lang = ?`, [from, to]);
    return info.changes;
  }
  const info = db.run(`DELETE FROM translations`);
  return info.changes;
}
