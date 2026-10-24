import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { initDatabase, closeDatabase, getDatabase } from '../src/database/db.js';
import { MockShopeeProvider } from '../src/providers/mock/mock-provider.js';
import { ShopService } from '../src/modules/shops/shop-service.js';
import { ProductService } from '../src/modules/products/product-service.js';
import { TelegramService, NewProductNotificationPayload } from '../src/telegram/telegram-service.js';
import { MonitorEngine } from '../src/modules/monitoring/monitor-engine.js';
import { parseShopTarget } from '../src/utils/url.js';
import { logger } from '../src/utils/logger.js';

logger.setLevel('ERROR'); // Keep test output clean

// Mock Telegram service that can be toggled to fail or record sent messages
class MockTelegramService extends TelegramService {
  public sentMessages: NewProductNotificationPayload[] = [];
  public shouldFail = false;

  constructor() {
    super({ botToken: 'mock_token', chatId: 'mock_chat_id' });
  }

  get isConfigured(): boolean {
    return true;
  }

  override async sendProductNotification(
    payload: NewProductNotificationPayload
  ): Promise<{ success: boolean; error?: string }> {
    if (this.shouldFail) {
      return { success: false, error: 'Simulated Telegram network failure (500)' };
    }
    this.sentMessages.push(payload);
    return { success: true };
  }
}

async function runTestSuite() {
  console.log('===========================================================');
  console.log('  RUNNING COMPREHENSIVE TEST SUITE (PHASE C - 9 SCENARIOS) ');
  console.log('===========================================================');

  const testDbPath = path.resolve('./data/test-suite.db');
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  initDatabase(testDbPath);
  const db = getDatabase();

  let passedTests = 0;
  let totalTests = 0;

  function runTest(title: string, fn: () => void | Promise<void>) {
    totalTests++;
    return (async () => {
      try {
        await fn();
        console.log(`✅ [PASS] Scenario ${totalTests}: ${title}`);
        passedTests++;
      } catch (err: any) {
        console.error(`❌ [FAIL] Scenario ${totalTests}: ${title}`);
        console.error(`   Error: ${err.message}`);
        console.error(err.stack);
      }
    })();
  }

  const mockProvider = new MockShopeeProvider();
  const shopService = new ShopService(mockProvider);
  const productService = new ProductService();
  const mockTelegram = new MockTelegramService();
  const engine = new MonitorEngine(shopService, productService, mockTelegram, mockProvider);

  // -------------------------------------------------------------
  // Scenario 1: Shop mới có sản phẩm cũ (Baseline)
  // -------------------------------------------------------------
  await runTest('Shop mới có sản phẩm cũ: Lần đầu lưu BASELINE, không gửi thông báo', async () => {
    // Register shop with 2 existing items
    mockProvider.registerMockShop('shop_1', 'Shop One', 'https://shopee.vn/shop_one', [
      {
        itemId: 'item_101',
        shopId: 'shop_1',
        name: 'Item 101 Existing',
        url: 'https://shopee.vn/product/shop_1/item_101',
        price: 150000,
      },
      {
        itemId: 'item_102',
        shopId: 'shop_1',
        name: 'Item 102 Existing',
        url: 'https://shopee.vn/product/shop_1/item_102',
        price: 250000,
      },
    ]);

    await shopService.addShop('https://shopee.vn/shop_one', 'Shop One');

    // Run cycle
    mockTelegram.sentMessages = [];
    const summary = await engine.runCycle();

    assert.strictEqual(summary.totalShops, 1);
    assert.strictEqual(summary.successfulShops, 1);
    assert.strictEqual(summary.newProductsCount, 0, 'Baseline items must not be counted as new');
    assert.strictEqual(mockTelegram.sentMessages.length, 0, 'No Telegram notifications should be sent for baseline');

    // Verify DB records have 'BASELINE' status
    const products = db.prepare('SELECT * FROM products WHERE shop_id = ?').all('shop_1') as any[];
    assert.strictEqual(products.length, 2);
    assert.strictEqual(products[0].notification_status, 'BASELINE');
    assert.strictEqual(products[1].notification_status, 'BASELINE');
  });

  // -------------------------------------------------------------
  // Scenario 2: Shop xuất hiện sản phẩm mới
  // -------------------------------------------------------------
  await runTest('Shop xuất hiện sản phẩm mới: Phát hiện và gửi Telegram thành công', async () => {
    // Add a brand new item to shop_1
    mockProvider.addProduct('shop_1', {
      itemId: 'item_103',
      shopId: 'shop_1',
      name: 'Item 103 Brand New',
      url: 'https://shopee.vn/product/shop_1/item_103',
      price: 350000,
      imageUrl: 'https://shopee.vn/images/103.jpg',
    });

    mockTelegram.sentMessages = [];
    const summary = await engine.runCycle();

    assert.strictEqual(summary.newProductsCount, 1, 'Should detect exactly 1 new product');
    assert.strictEqual(mockTelegram.sentMessages.length, 1, 'Should send exactly 1 Telegram message');
    assert.strictEqual(mockTelegram.sentMessages[0].itemName, 'Item 103 Brand New');

    // Verify DB status is 'SENT'
    const newProd = db
      .prepare('SELECT * FROM products WHERE shop_id = ? AND item_id = ?')
      .get('shop_1', 'item_103') as any;
    assert.strictEqual(newProd.notification_status, 'SENT');
    assert.ok(newProd.notification_sent_at);
  });

  // -------------------------------------------------------------
  // Scenario 3: Một sản phẩm được trả về nhiều lần (Không trùng lặp)
  // -------------------------------------------------------------
  await runTest('Một sản phẩm được trả về nhiều lần: Không lưu trùng, không gửi lại', async () => {
    // Run cycle again without changes
    mockTelegram.sentMessages = [];
    const summary = await engine.runCycle();

    assert.strictEqual(summary.newProductsCount, 0, 'No new products should be detected on re-check');
    assert.strictEqual(mockTelegram.sentMessages.length, 0, 'No notifications should be resent');

    // Total products in DB must still be 3
    const countRow = db.prepare('SELECT COUNT(*) as cnt FROM products WHERE shop_id = ?').get('shop_1') as any;
    assert.strictEqual(countRow.cnt, 3);
  });

  // -------------------------------------------------------------
  // Scenario 4: Đổi giá, đổi tên sản phẩm cũ không coi là mới
  // -------------------------------------------------------------
  await runTest('Đổi giá sản phẩm cũ: Không tạo sản phẩm mới, không gửi thông báo', async () => {
    mockProvider.updateProductPrice('shop_1', 'item_101', 99000);

    mockTelegram.sentMessages = [];
    const summary = await engine.runCycle();

    assert.strictEqual(summary.newProductsCount, 0, 'Price update must not count as new product');
    assert.strictEqual(mockTelegram.sentMessages.length, 0, 'No notification on price change');

    // Check DB updated price
    const prod = db.prepare('SELECT price FROM products WHERE item_id = ?').get('item_101') as any;
    assert.strictEqual(prod.price, 99000);
  });

  // -------------------------------------------------------------
  // Scenario 5: Telegram lỗi rồi hoạt động trở lại (Retry an toàn)
  // -------------------------------------------------------------
  await runTest('Telegram lỗi rồi hoạt động trở lại: Lưu trạng thái FAILED, retry thành công chuyển sang SENT', async () => {
    // Add item_104
    mockProvider.addProduct('shop_1', {
      itemId: 'item_104',
      shopId: 'shop_1',
      name: 'Item 104 With Telegram Error',
      url: 'https://shopee.vn/product/shop_1/item_104',
      price: 450000,
    });

    // Simulate Telegram failure
    mockTelegram.shouldFail = true;
    mockTelegram.sentMessages = [];

    await engine.runCycle();

    // Verify status is FAILED in DB
    const failedProd = db.prepare('SELECT * FROM products WHERE item_id = ?').get('item_104') as any;
    assert.strictEqual(failedProd.notification_status, 'FAILED');
    assert.ok(failedProd.notification_error);

    // Now Telegram recovers
    mockTelegram.shouldFail = false;
    await engine.runCycle(); // Next cycle will dispatch pending/failed

    const recoveredProd = db.prepare('SELECT * FROM products WHERE item_id = ?').get('item_104') as any;
    assert.strictEqual(recoveredProd.notification_status, 'SENT');
    assert.strictEqual(mockTelegram.sentMessages.length, 1);
    assert.strictEqual(mockTelegram.sentMessages[0].itemName, 'Item 104 With Telegram Error');
  });

  // -------------------------------------------------------------
  // Scenario 6: Nguồn dữ liệu trả về lỗi hoặc timeout
  // -------------------------------------------------------------
  await runTest('Nguồn dữ liệu trả về lỗi/timeout: Ghi nhận last_error, hệ thống không crash, shop khác vẫn chạy', async () => {
    // Register shop_2 that will fail
    mockProvider.registerMockShop('shop_2', 'Shop Broken', 'https://shopee.vn/shop_broken', []);
    await shopService.addShop('https://shopee.vn/shop_broken', 'Shop Broken');

    mockProvider.setFailure('shop_2', 'network', 1);

    const summary = await engine.runCycle();
    assert.strictEqual(summary.failedShops, 1);
    assert.ok(summary.successfulShops >= 1, 'Other shops should still succeed');

    const brokenShop = db.prepare('SELECT * FROM shops WHERE shop_id = ?').get('shop_2') as any;
    assert.ok(brokenShop.last_error?.includes('network timeout'));
  });

  // -------------------------------------------------------------
  // Scenario 7: Rate limit HTTP 429
  // -------------------------------------------------------------
  await runTest('Xử lý Rate Limit 429 từ nguồn dữ liệu: Bắt lỗi 429, ghi log và lưu trạng thái shop', async () => {
    mockProvider.setFailure('shop_2', 'rate_limit', 1);
    const summary = await engine.runCycle();
    assert.strictEqual(summary.failedShops, 1);

    const brokenShop = db.prepare('SELECT * FROM shops WHERE shop_id = ?').get('shop_2') as any;
    assert.ok(brokenShop.last_error?.includes('429'));
  });

  // -------------------------------------------------------------
  // Scenario 8: Worker restart giữa chừng (Trạng thái bền vững trong SQLite)
  // -------------------------------------------------------------
  await runTest('Worker restart giữa chừng: SQLite giữ nguyên trạng thái, không gửi lại sản phẩm cũ', async () => {
    // Close DB and simulate process restart
    closeDatabase();

    // Reopen DB
    initDatabase(testDbPath);
    const newShopService = new ShopService(mockProvider);
    const newProductService = new ProductService();
    const newEngine = new MonitorEngine(newShopService, newProductService, mockTelegram, mockProvider);

    mockTelegram.sentMessages = [];
    const summary = await newEngine.runCycle();

    assert.strictEqual(summary.newProductsCount, 0, 'No products re-notified after restart');
    assert.strictEqual(mockTelegram.sentMessages.length, 0);
  });

  // -------------------------------------------------------------
  // Scenario 9: Nhập CSV có URL trùng và chuẩn hóa URL
  // -------------------------------------------------------------
  await runTest('Nhập CSV có URL trùng và chuẩn hóa URL: Tự động loại bỏ trùng, nhận diện đúng URL', async () => {
    const csvContent = `
shop_name,shop_url
Test Shop A,https://shopee.vn/coolmate.vn?sp_atk=12345
Test Shop A Dup,https://shopee.vn/coolmate.vn
Test Shop B,shopee.vn/anker_store
Test Shop B Dup,https://shopee.vn/anker_store/
Invalid Shop,https://invalid.url.xyz/some/path
`;
    const tempCsvPath = path.resolve('./data/test-import.csv');
    fs.writeFileSync(tempCsvPath, csvContent.trim(), 'utf8');

    const result = await shopService.importFromCsv(tempCsvPath);

    assert.strictEqual(result.added, 2, 'Only 2 unique shops should be added (coolmate and anker)');
    assert.strictEqual(result.skippedDuplicates, 2, '2 duplicate URLs should be skipped');
    assert.strictEqual(result.errors.length, 1, '1 invalid URL should be recorded as error');

    fs.unlinkSync(tempCsvPath);
  });

  console.log('\n===========================================================');
  console.log(`  TEST RESULTS: ${passedTests}/${totalTests} SCENARIOS PASSED (${Math.round((passedTests/totalTests)*100)}%)`);
  console.log('===========================================================');

  closeDatabase();
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  if (passedTests < totalTests) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
