import fs from 'node:fs';
import readline from 'node:readline';
import { getDatabase } from '../../database/db.js';
import { parseShopTarget } from '../../utils/url.js';
import { IShopeeProvider } from '../../providers/types.js';
import { logger } from '../../utils/logger.js';

export interface ShopRecord {
  id: number;
  shop_id: string | null;
  shop_name: string;
  shop_url: string;
  is_active: number;
  last_checked_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImportSummary {
  totalProcessed: number;
  added: number;
  skippedDuplicates: number;
  errors: Array<{ line: number; row: string; error: string }>;
}

export class ShopService {
  private provider: IShopeeProvider;

  constructor(provider: IShopeeProvider) {
    this.provider = provider;
  }

  setProvider(provider: IShopeeProvider) {
    this.provider = provider;
  }

  async addShop(urlOrIdentifier: string, customName?: string): Promise<ShopRecord> {
    const db = getDatabase();
    const parsed = parseShopTarget(urlOrIdentifier);

    // Check duplicate URL
    const existing = db
      .prepare('SELECT * FROM shops WHERE shop_url = ?')
      .get(parsed.normalizedUrl) as ShopRecord | undefined;

    if (existing) {
      throw new Error(`Shop already exists with URL "${parsed.normalizedUrl}" (ID: ${existing.id})`);
    }

    // Resolve shop info from provider
    let resolvedShopId: string | null = parsed.shopId || null;
    let resolvedName = customName || parsed.username || `Shop ${parsed.shopId || 'New'}`;

    try {
      const resolved = await this.provider.resolveShop(parsed.normalizedUrl);
      resolvedShopId = resolved.shopId;
      if (!customName && resolved.shopName) {
        resolvedName = resolved.shopName;
      }
    } catch (err: any) {
      logger.warn(`Could not resolve shop metadata online for "${urlOrIdentifier}": ${err.message}. Using URL name.`);
    }

    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO shops (shop_id, shop_name, shop_url, is_active, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
    `);

    const result = stmt.run(resolvedShopId, resolvedName, parsed.normalizedUrl, now, now);
    const newId = Number(result.lastInsertRowid);

    return this.getShopById(newId)!;
  }

  getShopById(id: number): ShopRecord | undefined {
    const db = getDatabase();
    return db.prepare('SELECT * FROM shops WHERE id = ?').get(id) as ShopRecord | undefined;
  }

  getShopByUrl(url: string): ShopRecord | undefined {
    const db = getDatabase();
    return db.prepare('SELECT * FROM shops WHERE shop_url = ?').get(url) as ShopRecord | undefined;
  }

  listShops(activeOnly = false): ShopRecord[] {
    const db = getDatabase();
    if (activeOnly) {
      return db.prepare('SELECT * FROM shops WHERE is_active = 1 ORDER BY id ASC').all() as ShopRecord[];
    }
    return db.prepare('SELECT * FROM shops ORDER BY id ASC').all() as ShopRecord[];
  }

  toggleShop(id: number, isActive: boolean): boolean {
    const db = getDatabase();
    const now = new Date().toISOString();
    const res = db
      .prepare('UPDATE shops SET is_active = ?, updated_at = ? WHERE id = ?')
      .run(isActive ? 1 : 0, now, id);
    return res.changes > 0;
  }

  deleteShop(id: number): boolean {
    const db = getDatabase();
    const res = db.prepare('DELETE FROM shops WHERE id = ?').run(id);
    return res.changes > 0;
  }

  updateCheckStatus(id: number, success: boolean, errorMsg?: string, detectedShopId?: string): void {
    const db = getDatabase();
    const now = new Date().toISOString();

    if (success) {
      if (detectedShopId) {
        db.prepare(`
          UPDATE shops 
          SET last_checked_at = ?, last_success_at = ?, last_error = NULL, shop_id = coalesce(shop_id, ?), updated_at = ?
          WHERE id = ?
        `).run(now, now, detectedShopId, now, id);
      } else {
        db.prepare(`
          UPDATE shops 
          SET last_checked_at = ?, last_success_at = ?, last_error = NULL, updated_at = ?
          WHERE id = ?
        `).run(now, now, now, id);
      }
    } else {
      db.prepare(`
        UPDATE shops 
        SET last_checked_at = ?, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(now, errorMsg || 'Unknown error', now, id);
    }
  }

  async importFromCsv(filePath: string): Promise<ImportSummary> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`CSV file not found at: ${filePath}`);
    }

    const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    const summary: ImportSummary = {
      totalProcessed: 0,
      added: 0,
      skippedDuplicates: 0,
      errors: [],
    };

    let lineNumber = 0;
    let urlColumnIndex = 0;
    let nameColumnIndex = -1;
    let isFirstLine = true;

    for await (const rawLine of rl) {
      lineNumber++;
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      summary.totalProcessed++;

      // Simple CSV split supporting comma or semicolon
      const separator = line.includes(';') ? ';' : ',';
      const parts = line.split(separator).map((p) => p.replace(/^["']|["']$/g, '').trim());

      if (isFirstLine) {
        isFirstLine = false;
        const lowerParts = parts.map((p) => p.toLowerCase());
        // Check for URL column first (prioritize 'url' or 'link' over 'shop_name')
        let foundUrlCol = lowerParts.findIndex((p) => p === 'shop_url' || p === 'url' || p === 'link' || p.includes('url') || p.includes('link'));
        if (foundUrlCol === -1) {
          foundUrlCol = lowerParts.findIndex((p) => p === 'shop' || p === 'shopid');
        }

        // Check for Name column
        let foundNameCol = lowerParts.findIndex((p) => p === 'shop_name' || p === 'name' || p.includes('name') || p.includes('ten'));

        if (foundUrlCol !== -1) {
          urlColumnIndex = foundUrlCol;
          nameColumnIndex = foundNameCol !== foundUrlCol ? foundNameCol : -1;
          continue; // Skip header row
        }
      }

      const shopUrl = parts[urlColumnIndex];
      const customName = nameColumnIndex >= 0 ? parts[nameColumnIndex] : undefined;

      if (!shopUrl) {
        summary.errors.push({ line: lineNumber, row: line, error: 'Empty URL column' });
        continue;
      }

      try {
        const parsed = parseShopTarget(shopUrl);
        const existing = this.getShopByUrl(parsed.normalizedUrl);
        if (existing) {
          summary.skippedDuplicates++;
          continue;
        }

        await this.addShop(shopUrl, customName);
        summary.added++;
      } catch (err: any) {
        summary.errors.push({ line: lineNumber, row: line, error: err.message });
      }
    }

    return summary;
  }

  exportToCsv(filePath: string): number {
    const shops = this.listShops(false);
    const headers = ['id', 'shop_id', 'shop_name', 'shop_url', 'is_active', 'last_checked_at', 'last_success_at', 'last_error'];
    const rows = [headers.join(',')];

    for (const s of shops) {
      const escape = (val: any) => `"${String(val ?? '').replace(/"/g, '""')}"`;
      rows.push([
        s.id,
        escape(s.shop_id),
        escape(s.shop_name),
        escape(s.shop_url),
        s.is_active,
        escape(s.last_checked_at),
        escape(s.last_success_at),
        escape(s.last_error),
      ].join(','));
    }

    fs.writeFileSync(filePath, rows.join('\n'), 'utf8');
    return shops.length;
  }
}
