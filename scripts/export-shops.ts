import path from 'node:path';
import { config } from '../src/config/env.js';
import { initDatabase, closeDatabase } from '../src/database/db.js';
import { getProvider } from '../src/providers/factory.js';
import { ShopService } from '../src/modules/shops/shop-service.js';

async function run() {
  const args = process.argv.slice(2);
  const targetFile = args[0] || 'data/exported-shops.csv';

  initDatabase(config.databasePath);
  const provider = getProvider();
  const shopService = new ShopService(provider);

  try {
    const fullPath = path.resolve(targetFile);
    const count = shopService.exportToCsv(fullPath);
    console.log(`✅ Successfully exported ${count} shops to: ${fullPath}`);
  } catch (err: any) {
    console.error('Export failed:', err.message);
  } finally {
    closeDatabase();
  }
}

run();
