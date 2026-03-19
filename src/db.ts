/**
 * SQLite storage: translation cache + glossary.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";

const DB_PATH = join(import.meta.dir, "..", "translations.db");

const db = new Database(DB_PATH, { create: true });
db.run("PRAGMA journal_mode=WAL");

// ─── Translation cache ──────────────────────────────────────────────

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

export function getCached(text: string, from: string, to: string): string | null {
  const row = stmtGet.get(text, from, to);
  return row ? row.translated_text : null;
}

export function setCache(text: string, translated: string, from: string, to: string): void {
  stmtInsert.run(text, translated, from, to);
}

export function getCachedBatch(texts: string[], from: string, to: string): (string | null)[] {
  return texts.map((t) => getCached(t, from, to));
}

export function getCacheStats(): { total: number; languages: Array<{ pair: string; count: number }> } {
  const total = db.prepare<{ count: number }, []>(
    `SELECT COUNT(*) as count FROM translations`
  ).get()!.count;
  const languages = db.prepare<{ pair: string; count: number }, []>(
    `SELECT source_lang || ' → ' || target_lang as pair, COUNT(*) as count FROM translations GROUP BY source_lang, target_lang ORDER BY count DESC`
  ).all();
  return { total, languages };
}

export function clearCache(from?: string, to?: string): number {
  if (from && to) {
    const info = db.run(`DELETE FROM translations WHERE source_lang = ? AND target_lang = ?`, [from, to]);
    return info.changes;
  }
  const info = db.run(`DELETE FROM translations`);
  return info.changes;
}

// ─── Glossary ────────────────────────────────────────────────────────

db.run(`
  CREATE TABLE IF NOT EXISTS glossary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_term TEXT NOT NULL,
    translated_term TEXT NOT NULL,
    source_lang TEXT NOT NULL,
    target_lang TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(source_term, source_lang, target_lang)
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_glossary ON glossary(source_lang, target_lang)`);

interface GlossaryEntry {
  id: number;
  source_term: string;
  translated_term: string;
  source_lang: string;
  target_lang: string;
}

const stmtGlossaryAll = db.prepare<GlossaryEntry, [string, string]>(
  `SELECT id, source_term, translated_term, source_lang, target_lang FROM glossary WHERE source_lang = ? AND target_lang = ? ORDER BY length(source_term) DESC`
);
const stmtGlossaryAdd = db.prepare(
  `INSERT OR REPLACE INTO glossary (source_term, translated_term, source_lang, target_lang) VALUES (?, ?, ?, ?)`
);
const stmtGlossaryUpdate = db.prepare(
  `UPDATE glossary SET source_term = ?, translated_term = ? WHERE id = ?`
);
const stmtGlossaryDelete = db.prepare(
  `DELETE FROM glossary WHERE id = ?`
);

export function getGlossaryTerms(from: string, to: string): GlossaryEntry[] {
  return stmtGlossaryAll.all(from, to);
}

/** Returns Map sorted longest-first for correct replacement order */
export function getGlossaryMap(from: string, to: string): Map<string, string> {
  const entries = stmtGlossaryAll.all(from, to);
  const map = new Map<string, string>();
  for (const e of entries) {
    map.set(e.source_term, e.translated_term);
  }
  return map;
}

export function addGlossaryTerm(source: string, translated: string, from: string, to: string): void {
  stmtGlossaryAdd.run(source, translated, from, to);
}

export function updateGlossaryTerm(id: number, source: string, translated: string): void {
  stmtGlossaryUpdate.run(source, translated, id);
}

export function deleteGlossaryTerm(id: number): void {
  stmtGlossaryDelete.run(id);
}

export function getGlossaryStats(): number {
  return db.prepare<{ count: number }, []>(`SELECT COUNT(*) as count FROM glossary`).get()!.count;
}
