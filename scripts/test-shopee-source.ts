import { ShopeeHttpProvider } from '../src/providers/shopee/shopee-http-provider.js';
import { config } from '../src/config/env.js';

async function run() {
  console.log('======================================================');
  console.log('  TESTING LIVE SHOPEE VIETNAM DATA SOURCE (PHASE A)');
  console.log('======================================================');

  const provider = new ShopeeHttpProvider(config.shopeeCookie);
  const testShops = ['coolmate.vn', 'anker_official_store', 'locknlockvn'];

  console.log(`Checking cookie configured: ${config.shopeeCookie ? 'YES (length: ' + config.shopeeCookie.length + ')' : 'NO'}`);

  for (const shop of testShops) {
    console.log(`\n------------------------------------------------------`);
    console.log(`Testing shop: ${shop}`);
    try {
      console.log(`[1] Resolving shop username...`);
      const resolved = await provider.resolveShop(shop);
      console.log(`✅ Shop Resolved:`);
      console.log(`   - Name   : ${resolved.shopName}`);
      console.log(`   - Shop ID: ${resolved.shopId}`);
      console.log(`   - URL    : ${resolved.shopUrl}`);

      console.log(`[2] Fetching recent items for shop ID ${resolved.shopId}...`);
      const items = await provider.getShopProducts(resolved.shopId, { limit: 5 });
      console.log(`✅ Items received: ${items.length} item(s)`);
      if (items.length > 0) {
        console.log(`   Sample item:`);
        console.log(`   - Item ID: ${items[0].itemId}`);
        console.log(`   - Name   : ${items[0].name}`);
        console.log(`   - Price  : ${items[0].price}`);
        console.log(`   - URL    : ${items[0].url}`);
      }
    } catch (err: any) {
      console.log(`❌ Error for shop ${shop}:`);
      console.log(`   Message: ${err.message}`);
      if (err.message.includes('90309999') || err.message.includes('WAF')) {
        console.log(`\n💡 DIAGNOSTIC NOTE:`);
        console.log(`   Shopee VN returned anti-bot code 90309999.`);
        console.log(`   This occurs when Shopee WAF detects a server/script request without a valid browser session cookie.`);
        console.log(`   Remedy: Set SHOPEE_COOKIE in your .env file, or switch to DATA_PROVIDER=mock for simulated testing.`);
      }
    }
  }

  console.log('\n======================================================');
  console.log('  Shopee Source Diagnostic Finished');
  console.log('======================================================');
}

run();
