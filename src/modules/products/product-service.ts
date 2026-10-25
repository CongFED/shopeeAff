import { getDatabase } from '../../database/db.js';
import { ProductItem } from '../../providers/types.js';

export interface ProductRecord {
  id: number;
  shop_id: string;
  item_id: string;
  item_name: string;
  product_url: string;
  price: number | null;
  image_url: string | null;
  first_seen_at: string;
  last_seen_at: string;
  notification_status: 'BASELINE' | 'PENDING' | 'SENT' | 'FAILED';
  notification_sent_at: string | null;
  notification_error: string | null;
}

export interface PriceChangeRecord {
  productId: number;
  shopId: string;
  itemId: string;
  itemName: string;
  productUrl: string;
  oldPrice: number;
  newPrice: number;
  imageUrl?: string;
  updatedAt: string;
}

export interface ProcessResult {
  newProducts: ProductRecord[];
  priceChanges: PriceChangeRecord[];
  baselineCount: number;
  existingCount: number;
}

export class ProductService {
  /**
   * Check if a shop already has products recorded in database (baseline established).
   */
  hasBaseline(shopId: string): boolean {
    const db = getDatabase();
    const row = db
      .prepare('SELECT COUNT(*) as cnt FROM products WHERE shop_id = ?')
      .get(shopId) as { cnt: number } | undefined;
    return Boolean(row && row.cnt > 0);
  }

  /**
   * Process items returned for a shop.
   * If isBaseline is true, products are inserted as 'BASELINE' (no notifications).
   * Otherwise, previously unseen items are inserted as 'PENDING'.
   */
  processShopProducts(shopId: string, items: ProductItem[], forceBaseline = false): ProcessResult {
    const db = getDatabase();
    const now = new Date().toISOString();

    const isBaseline = forceBaseline || !this.hasBaseline(shopId);

    const selectStmt = db.prepare('SELECT id, price, item_name, image_url, product_url FROM products WHERE shop_id = ? AND item_id = ?');
    const insertStmt = db.prepare(`
      INSERT INTO products (
        shop_id, item_id, item_name, product_url, price, image_url,
        first_seen_at, last_seen_at, notification_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateStmt = db.prepare(`
      UPDATE products 
      SET last_seen_at = ?, price = coalesce(?, price), item_name = coalesce(?, item_name), image_url = coalesce(?, image_url)
      WHERE id = ?
    `);

    const newProducts: ProductRecord[] = [];
    const priceChanges: PriceChangeRecord[] = [];
    let baselineCount = 0;
    let existingCount = 0;

    // Wrap in a transaction for fast bulk processing
    const runTransaction = db.transaction(() => {
      for (const item of items) {
        const existing = selectStmt.get(shopId, item.itemId) as {
          id: number;
          price: number | null;
          item_name: string;
          image_url: string | null;
          product_url: string;
        } | undefined;

        if (existing) {
          existingCount++;
          const oldPrice = existing.price;
          const newPrice = item.price;

          // Check if price changed
          if (
            !isBaseline &&
            oldPrice !== null &&
            oldPrice !== undefined &&
            newPrice !== null &&
            newPrice !== undefined &&
            Math.abs(newPrice - oldPrice) > 0.001
          ) {
            priceChanges.push({
              productId: existing.id,
              shopId,
              itemId: item.itemId,
              itemName: item.name || existing.item_name,
              productUrl: item.url || existing.product_url,
              oldPrice,
              newPrice,
              imageUrl: item.imageUrl || existing.image_url || undefined,
              updatedAt: now,
            });
          }

          updateStmt.run(now, item.price ?? null, item.name, item.imageUrl ?? null, existing.id);
        } else {
          // New product!
          if (isBaseline) {
            baselineCount++;
            insertStmt.run(
              shopId,
              item.itemId,
              item.name,
              item.url,
              item.price ?? null,
              item.imageUrl ?? null,
              now,
              now,
              'BASELINE'
            );
          } else {
            const insertResult = insertStmt.run(
              shopId,
              item.itemId,
              item.name,
              item.url,
              item.price ?? null,
              item.imageUrl ?? null,
              now,
              now,
              'PENDING'
            );

            const insertedProduct: ProductRecord = {
              id: Number(insertResult.lastInsertRowid),
              shop_id: shopId,
              item_id: item.itemId,
              item_name: item.name,
              product_url: item.url,
              price: item.price ?? null,
              image_url: item.imageUrl ?? null,
              first_seen_at: now,
              last_seen_at: now,
              notification_status: 'PENDING',
              notification_sent_at: null,
              notification_error: null,
            };

            newProducts.push(insertedProduct);
          }
        }
      }
    });

    runTransaction();

    return {
      newProducts,
      priceChanges,
      baselineCount,
      existingCount,
    };
  }

  getPendingNotifications(limit = 50): ProductRecord[] {
    const db = getDatabase();
    return db
      .prepare(`
        SELECT * FROM products 
        WHERE notification_status IN ('PENDING', 'FAILED') 
        ORDER BY id ASC 
        LIMIT ?
      `)
      .all(limit) as ProductRecord[];
  }

  markNotificationSuccess(productId: number): void {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE products 
      SET notification_status = 'SENT', notification_sent_at = ?, notification_error = NULL 
      WHERE id = ?
    `).run(now, productId);
  }

  markNotificationFailure(productId: number, error: string): void {
    const db = getDatabase();
    db.prepare(`
      UPDATE products 
      SET notification_status = 'FAILED', notification_error = ? 
      WHERE id = ?
    `).run(error, productId);
  }

  getNewProductsTodayCount(): number {
    const db = getDatabase();
    // Beginning of today in ISO
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayIso = today.toISOString();

    const row = db
      .prepare(`
        SELECT COUNT(*) as count FROM products 
        WHERE notification_status IN ('PENDING', 'SENT') 
          AND first_seen_at >= ?
      `)
      .get(todayIso) as { count: number } | undefined;

    return row?.count || 0;
  }
}
