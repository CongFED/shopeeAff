import { getDatabase } from '../../database/db.js';
import { ShopService, ShopRecord } from '../shops/shop-service.js';
import { ProductService, ProductRecord } from '../products/product-service.js';
import { SettingsService } from '../settings/settings-service.js';
import { TelegramService } from '../../telegram/telegram-service.js';
import { IShopeeProvider } from '../../providers/types.js';
import { logger } from '../../utils/logger.js';
import { sleep, calculateBackoff } from '../../utils/time.js';

export interface MonitorOptions {
  concurrency?: number;
  delayMs?: number;
}

export interface CheckRunSummary {
  runId: number;
  totalShops: number;
  successfulShops: number;
  failedShops: number;
  newProductsCount: number;
  durationMs: number;
}

export class MonitorEngine {
  private shopService: ShopService;
  private productService: ProductService;
  private telegramService: TelegramService;
  private provider: IShopeeProvider;
  private isRunning = false;

  constructor(
    shopService: ShopService,
    productService: ProductService,
    telegramService: TelegramService,
    provider: IShopeeProvider
  ) {
    this.shopService = shopService;
    this.productService = productService;
    this.telegramService = telegramService;
    this.provider = provider;
  }

  setProvider(provider: IShopeeProvider) {
    this.provider = provider;
  }

  get isBusy(): boolean {
    return this.isRunning;
  }

  /**
   * Run one complete monitoring cycle across all active shops with concurrency limit.
   */
  async runCycle(options: MonitorOptions = {}): Promise<CheckRunSummary> {
    if (this.isRunning) {
      logger.warn('A monitoring cycle is already in progress. Skipping overlapping run.');
      return {
        runId: -1,
        totalShops: 0,
        successfulShops: 0,
        failedShops: 0,
        newProductsCount: 0,
        durationMs: 0,
      };
    }

    this.isRunning = true;
    const startTime = Date.now();
    const db = getDatabase();

    const startIso = new Date().toISOString();
    const runInsert = db
      .prepare('INSERT INTO check_runs (started_at, status) VALUES (?, ?)')
      .run(startIso, 'RUNNING');
    const runId = Number(runInsert.lastInsertRowid);

    const concurrency = options.concurrency || 3;
    const delayMs = options.delayMs || 1000;

    const activeShops = this.shopService.listShops(true);
    logger.info(`Starting check cycle #${runId} for ${activeShops.length} active shops (concurrency: ${concurrency}).`);

    let successfulShops = 0;
    let failedShops = 0;
    let totalNewProducts = 0;

    // Process shops in controlled batches / concurrency pool
    const queue = [...activeShops];

    const worker = async (workerId: number) => {
      while (queue.length > 0) {
        const shop = queue.shift();
        if (!shop) break;

        try {
          const newItemsCount = await this.checkSingleShop(shop);
          successfulShops++;
          totalNewProducts += newItemsCount;
        } catch (err: any) {
          failedShops++;
          logger.error(`[Worker ${workerId}] Error checking shop "${shop.shop_name}" (ID ${shop.id}): ${err.message}`);
          this.shopService.updateCheckStatus(shop.id, false, err.message);
        }

        // Delay with small random jitter between requests
        if (queue.length > 0 && delayMs > 0) {
          const jitter = Math.floor(Math.random() * 500);
          await sleep(delayMs + jitter);
        }
      }
    };

    const workerPromises: Promise<void>[] = [];
    for (let i = 0; i < Math.min(concurrency, activeShops.length); i++) {
      workerPromises.push(worker(i + 1));
    }

    await Promise.all(workerPromises);

    // Process any pending Telegram notifications (including failed retries)
    await this.dispatchPendingNotifications();

    const durationMs = Date.now() - startTime;
    const finishIso = new Date().toISOString();

    db.prepare(`
      UPDATE check_runs 
      SET finished_at = ?, total_shops = ?, successful_shops = ?, failed_shops = ?, new_products_found = ?, status = 'COMPLETED'
      WHERE id = ?
    `).run(finishIso, activeShops.length, successfulShops, failedShops, totalNewProducts, runId);

    logger.info(
      `Check cycle #${runId} finished in ${(durationMs / 1000).toFixed(1)}s: ` +
      `${successfulShops} succeeded, ${failedShops} failed, ${totalNewProducts} new products detected.`
    );

    this.isRunning = false;

    return {
      runId,
      totalShops: activeShops.length,
      successfulShops,
      failedShops,
      newProductsCount: totalNewProducts,
      durationMs,
    };
  }

  /**
   * Check a single shop: resolves shopId if missing, fetches products, detects new items.
   */
  async checkSingleShop(shop: ShopRecord): Promise<number> {
    logger.debug(`Checking shop: "${shop.shop_name}" (${shop.shop_url})`);

    let targetShopId = shop.shop_id;

    // If shop_id is not yet stored, resolve it first
    if (!targetShopId) {
      const resolved = await this.provider.resolveShop(shop.shop_url);
      targetShopId = resolved.shopId;
    }

    if (!targetShopId) {
      throw new Error(`Unable to determine shop_id for shop ${shop.shop_name}`);
    }

    // Fetch latest products from provider (prefer official shop URL if known)
    const products = await this.provider.getShopProducts(shop.shop_url || targetShopId, { limit: 30 });

    // Process products: first time is baseline, subsequent checks detect new products
    const processResult = this.productService.processShopProducts(targetShopId, products);

    // Update shop success status
    this.shopService.updateCheckStatus(shop.id, true, undefined, targetShopId);

    if (processResult.baselineCount > 0) {
      logger.info(
        `[Baseline] Initialized ${processResult.baselineCount} existing products for shop "${shop.shop_name}". No notifications sent.`
      );
    }

    if (processResult.newProducts.length > 0) {
      logger.info(
        `🚨 Found ${processResult.newProducts.length} NEW product(s) for shop "${shop.shop_name}"!`
      );
    }

    if (processResult.priceChanges.length > 0) {
      let shouldNotifyUpdates = true;
      try {
        const settingsSvc = new SettingsService();
        shouldNotifyUpdates = settingsSvc.getSetting('NOTIFY_ON_PRODUCT_UPDATE', 'true') !== 'false';
      } catch {}

      if (shouldNotifyUpdates) {
        logger.info(
          `🔔 Found ${processResult.priceChanges.length} PRICE CHANGE(s) for shop "${shop.shop_name}"!`
        );
        for (const pc of processResult.priceChanges) {
          await this.telegramService.sendPriceUpdateNotification({
            shopName: shop.shop_name,
            itemName: pc.itemName,
            productUrl: pc.productUrl,
            oldPrice: pc.oldPrice,
            newPrice: pc.newPrice,
            imageUrl: pc.imageUrl,
            updatedAt: new Date(pc.updatedAt),
          });
        }
      } else {
        logger.info(
          `ℹ️ Detected ${processResult.priceChanges.length} price change(s) for shop "${shop.shop_name}", but notifications for product updates are disabled on dashboard.`
        );
      }
    }

    return processResult.newProducts.length;
  }

  /**
   * Send Telegram notifications for any pending or previously failed new products.
   */
  async dispatchPendingNotifications(limit = 50): Promise<void> {
    const pending = this.productService.getPendingNotifications(limit);
    if (pending.length === 0) return;

    logger.info(`Dispatching ${pending.length} pending Telegram notification(s)...`);

    for (const prod of pending) {
      // Find shop name for message
      const shop = this.shopService.listShops(false).find((s) => s.shop_id === prod.shop_id);
      const shopName = shop ? shop.shop_name : `Shop ${prod.shop_id}`;

      const res = await this.telegramService.sendProductNotification({
        shopName,
        itemName: prod.item_name,
        productUrl: prod.product_url,
        price: prod.price ?? undefined,
        imageUrl: prod.image_url ?? undefined,
        discoveredAt: new Date(prod.first_seen_at),
      });

      if (res.success) {
        this.productService.markNotificationSuccess(prod.id);
      } else {
        this.productService.markNotificationFailure(prod.id, res.error || 'Failed to send notification');
      }
    }
  }
}
