import { config } from './config/env.js';
import { logger } from './utils/logger.js';
import { initDatabase, closeDatabase, getDatabase } from './database/db.js';
import { getProvider } from './providers/factory.js';
import { ShopService } from './modules/shops/shop-service.js';
import { ProductService } from './modules/products/product-service.js';
import { TelegramService } from './telegram/telegram-service.js';
import { MonitorEngine } from './modules/monitoring/monitor-engine.js';
import { MonitorWorker } from './scheduler/monitor-worker.js';

async function bootstrap() {
  logger.setLevel(config.logLevel);

  console.log(`
=====================================================
  SHOPEE NEW PRODUCT MONITOR + TELEGRAM BOT
=====================================================
  Provider        : ${config.dataProvider}
  Database        : ${config.databasePath}
  Poll Interval   : ${config.pollIntervalSeconds} seconds (${config.pollIntervalMinutes}m)
  Max Concurrency : ${config.maxConcurrentRequests}
  Request Delay   : ${config.requestDelayMs}ms
  Telegram Bot    : ${config.telegramBotToken ? 'Configured ✅' : 'Not configured ⚠️ (DRY-RUN)'}
  Telegram Chat ID: ${config.telegramChatId || 'Not set'}
=====================================================
  `);

  // 1. Initialize SQLite Database
  initDatabase(config.databasePath);

  // 2. Initialize Provider & Services
  const provider = getProvider();
  logger.info(`Using data provider: ${provider.name}`);

  const shopService = new ShopService(provider);
  const productService = new ProductService();
  const telegramService = new TelegramService({
    botToken: config.telegramBotToken,
    chatId: config.telegramChatId,
  });

  // Verify Telegram connection if configured
  if (telegramService.isConfigured) {
    const testResult = await telegramService.testConnection();
    if (testResult.ok) {
      logger.info(`Telegram Bot verified: ${testResult.message}`);
    } else {
      logger.warn(`Telegram Bot test failed: ${testResult.message}`);
    }
  } else {
    logger.warn('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is empty. Running in DRY-RUN mode (notifications will be logged to console only).');
  }

  // 3. Status check on database
  const allShops = shopService.listShops(false);
  const activeShops = shopService.listShops(true);
  logger.info(`Database loaded: ${allShops.length} total shops (${activeShops.length} active).`);

  if (allShops.length === 0) {
    logger.warn('No shops currently in database! To add shops:');
    logger.warn('  - Run "pnpm run import:shops <path-to-csv>" to import a list of shops.');
  }

  // 4. Initialize Monitoring Engine & Background Worker
  const monitorEngine = new MonitorEngine(shopService, productService, telegramService, provider);
  const worker = new MonitorWorker(
    monitorEngine,
    config.pollIntervalSeconds,
    config.maxConcurrentRequests,
    config.requestDelayMs
  );

  // 5. Start Dashboard (optional UI & API)
  let dashboardServer: any = null;
  if (config.enableDashboard) {
    const { startDashboard } = await import('./dashboard/server.js');
    dashboardServer = startDashboard(config.dashboardPort, shopService, productService, monitorEngine);
  }

  // 6. Start Polling Worker
  worker.start();

  // 7. Graceful Shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    if (dashboardServer) {
      dashboardServer.close();
    }
    await worker.stop();
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  logger.error('Fatal bootstrap error:', err);
  process.exit(1);
});
