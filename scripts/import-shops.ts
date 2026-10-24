import path from 'node:path';
import fs from 'node:fs';
import { config } from '../src/config/env.js';
import { initDatabase, closeDatabase } from '../src/database/db.js';
import { getProvider } from '../src/providers/factory.js';
import { ShopService } from '../src/modules/shops/shop-service.js';
import { logger } from '../src/utils/logger.js';

async function run() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`
Usage:
  Import CSV:
    pnpm run import:shops <path-to-csv>
    Example: pnpm run import:shops data/sample-shops.csv

  Add Single Shop:
    pnpm run import:shops <shop-url-or-username> [custom-shop-name]
    Example: pnpm run import:shops https://shopee.vn/coolmate.vn "Coolmate Store"
    `);
    process.exit(0);
  }

  initDatabase(config.databasePath);
  const provider = getProvider();
  const shopService = new ShopService(provider);

  const target = args[0];

  try {
    // Check if target is a file
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      console.log(`📂 Importing shops from CSV file: ${target}...`);
      const summary = await shopService.importFromCsv(path.resolve(target));
      console.log(`
✅ CSV Import Completed:
- Total lines processed: ${summary.totalProcessed}
- Successfully added   : ${summary.added}
- Skipped duplicates   : ${summary.skippedDuplicates}
- Errors               : ${summary.errors.length}
      `);

      if (summary.errors.length > 0) {
        console.log('Errors encountered:');
        summary.errors.slice(0, 10).forEach((e) => {
          console.log(`  Line ${e.line}: ${e.error} (Row: "${e.row}")`);
        });
        if (summary.errors.length > 10) {
          console.log(`  ...and ${summary.errors.length - 10} more errors.`);
        }
      }
    } else {
      // Add single shop
      const customName = args[1];
      console.log(`🔍 Adding single shop: ${target}...`);
      const shop = await shopService.addShop(target, customName);
      console.log(`✅ Shop added successfully!`);
      console.log(`- ID: ${shop.id}`);
      console.log(`- Name: ${shop.shop_name}`);
      console.log(`- Shopee Shop ID: ${shop.shop_id || 'Pending online resolve'}`);
      console.log(`- URL: ${shop.shop_url}`);
    }
  } catch (err: any) {
    logger.error('Failed to import/add shop:', err.message);
  } finally {
    closeDatabase();
  }
}

run();
