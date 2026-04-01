import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import "@/lib/load-env";

declare global {
  // eslint-disable-next-line no-var
  var __arbiterDb__: DatabaseSync | undefined;
  // eslint-disable-next-line no-var
  var __arbiterDbInitialized__: boolean | undefined;
}

const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "arbiter.sqlite");

function resolveDatabasePath(): string {
  const configured = process.env.ARBITER_DB_PATH?.trim();
  return configured ? path.resolve(process.cwd(), configured) : DEFAULT_DB_PATH;
}

function initializeSchema(db: DatabaseSync) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      ask_price REAL NOT NULL,
      currency TEXT NOT NULL,
      source TEXT NOT NULL,
      source_url TEXT NOT NULL,
      location TEXT,
      category TEXT NOT NULL,
      condition TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      ingested_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_items_domain_ingested_at
      ON items(domain, ingested_at DESC);

    CREATE TABLE IF NOT EXISTS comps (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      query_text TEXT,
      title TEXT,
      price REAL NOT NULL,
      sold_date TEXT,
      condition TEXT,
      confidence TEXT NOT NULL,
      source_url TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_comps_item_id
      ON comps(item_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS anomalies (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
      domain TEXT NOT NULL,
      anomaly_score REAL NOT NULL,
      gross_spread_pct REAL NOT NULL,
      net_spread_pct REAL NOT NULL,
      confidence_score REAL NOT NULL,
      velocity_score REAL NOT NULL,
      freshness_score REAL NOT NULL,
      volume_score REAL NOT NULL,
      estimated_fees_pct REAL NOT NULL,
      comp_count INTEGER NOT NULL,
      summary TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_anomalies_created_at
      ON anomalies(created_at DESC);

    CREATE TABLE IF NOT EXISTS evaluations (
      id TEXT PRIMARY KEY,
      anomaly_id TEXT NOT NULL REFERENCES anomalies(id) ON DELETE CASCADE,
      verdict TEXT,
      confidence REAL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      decision TEXT NOT NULL,
      notes TEXT,
      outcome TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS domain_configs (
      domain TEXT PRIMARY KEY,
      settings TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export function getDb() {
  if (!global.__arbiterDb__) {
    const databasePath = resolveDatabasePath();
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    global.__arbiterDb__ = new DatabaseSync(databasePath);
  }

  if (!global.__arbiterDbInitialized__) {
    initializeSchema(global.__arbiterDb__);
    global.__arbiterDbInitialized__ = true;
  }

  return global.__arbiterDb__;
}

export function withTransaction<T>(work: () => T): T {
  const db = getDb();
  db.exec("BEGIN");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
