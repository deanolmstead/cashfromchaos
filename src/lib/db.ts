// ============================================================================
// SQLite persistence — a single zero-config file behind the in-memory store.
// The store stays the source of truth at runtime; every mutation write-throughs
// here, and the Map is hydrated from this file on boot. Delete the file (or hit
// Reset demo) to start clean. Kept out of git via .gitignore (data/).
// ============================================================================

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Item } from "@/lib/types";

const g = globalThis as unknown as { __cfc_db?: Database.Database | null };

function open(): Database.Database | null {
  if (g.__cfc_db !== undefined) return g.__cfc_db;
  try {
    const dir = process.env.CFC_DATA_DIR ?? path.join(process.cwd(), "data");
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, "cashfromchaos.db"));
    db.pragma("journal_mode = WAL");
    db.exec(
      `CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL
      )`
    );
    g.__cfc_db = db;
  } catch (err) {
    // Persistence is best-effort: if the native module or filesystem is
    // unavailable (e.g. read-only deploy), the app still runs in-memory.
    console.warn("[db] persistence disabled:", (err as Error).message);
    g.__cfc_db = null;
  }
  return g.__cfc_db;
}

export function dbLoadAll(): Item[] {
  const db = open();
  if (!db) return [];
  const rows = db.prepare("SELECT data FROM items ORDER BY created_at ASC").all() as {
    data: string;
  }[];
  const items: Item[] = [];
  for (const r of rows) {
    try {
      items.push(JSON.parse(r.data) as Item);
    } catch {
      // skip corrupt row
    }
  }
  return items;
}

export function dbUpsert(item: Item): void {
  const db = open();
  if (!db) return;
  db.prepare(
    "INSERT INTO items (id, created_at, data) VALUES (?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, data = excluded.data"
  ).run(item.id, item.createdAt, JSON.stringify(item));
}

export function dbClear(): void {
  const db = open();
  if (!db) return;
  db.prepare("DELETE FROM items").run();
}
