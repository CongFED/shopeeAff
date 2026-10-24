import Database, { Database as DatabaseType } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

let dbInstance: DatabaseType | null = null;

export function initDatabase(dbPath: string): DatabaseType {
  if (dbInstance) {
    return dbInstance;
  }

  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  logger.info(`Opening SQLite database at: ${dbPath}`);
  const db = new Database(dbPath);

  // Enable WAL mode and foreign keys for high reliability & speed
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Load and execute schema
  const schemaPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), 'schema.sql');
  let schemaSql = '';
  if (fs.existsSync(schemaPath)) {
    schemaSql = fs.readFileSync(schemaPath, 'utf8');
  } else {
    // Fallback embedded schema
    schemaSql = `
      CREATE TABLE IF NOT EXISTS shops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT,
        shop_name TEXT NOT NULL,
        shop_url TEXT NOT NULL UNIQUE,
        is_active INTEGER NOT NULL DEFAULT 1,
        last_checked_at TEXT,
        last_success_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_shops_active ON shops (is_active);
      CREATE INDEX IF NOT EXISTS idx_shops_shop_id ON shops (shop_id);

      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shop_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        item_name TEXT NOT NULL,
        product_url TEXT NOT NULL,
        price REAL,
        image_url TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        notification_status TEXT NOT NULL DEFAULT 'PENDING',
        notification_sent_at TEXT,
        notification_error TEXT,
        UNIQUE(shop_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_products_lookup ON products (shop_id, item_id);
      CREATE INDEX IF NOT EXISTS idx_products_notif ON products (notification_status);

      CREATE TABLE IF NOT EXISTS check_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        total_shops INTEGER NOT NULL DEFAULT 0,
        successful_shops INTEGER NOT NULL DEFAULT 0,
        failed_shops INTEGER NOT NULL DEFAULT 0,
        new_products_found INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'RUNNING'
      );

      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `;
  }

  db.exec(schemaSql);
  logger.info('Database schema initialized successfully.');

  dbInstance = db;
  return db;
}

export function getDatabase(): DatabaseType {
  if (!dbInstance) {
    throw new Error('Database has not been initialized. Call initDatabase() first.');
  }
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
      logger.info('Database connection closed.');
    } catch (e: any) {
      logger.error('Error closing database:', e);
    } finally {
      dbInstance = null;
    }
  }
}
