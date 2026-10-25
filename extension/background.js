/**
 * Shopee Realtime Product Monitor - Background Service Worker (Manifest V3)
 * 100% Free, runs directly in authentic Chrome session without DataDome blocks.
 */

const DEFAULT_SETTINGS = {
  isActive: true,
  intervalSeconds: 10,
  teleToken: '8753686508:AAFE8fECmXutzkz3yNw8hI-kt2wmyPG78Ao',
  teleChatId: '-1004358778817',
  vpsUrl: 'http://36.50.26.72:3000',
  shops: [
    {
      id: 1,
      shop_id: '1368956675',
      shop_name: "The Girl's Room",
      shop_url: 'https://shopee.vn/dr07efvzq2',
      is_active: true,
      last_item_count: 12
    }
  ],
  seenItems: [
    '56418741612', '52569814877', '49669842774', '25598676416',
    '28046114233', '52269827470', '54169820627', '53719767706',
    '53369823912', '53019826177', '49819783249', '45018759295'
  ],
  newProductsToday: 0,
  lastCheckTime: null,
  knownProducts: {},
  logs: []
};

// Setup declarativeNetRequest to bypass Shopee cross-origin WAF
async function setupNetRules() {
  if (!chrome.declarativeNetRequest) return;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: [
        {
          id: 1,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Origin', operation: 'set', value: 'https://shopee.vn' },
              { header: 'Referer', operation: 'set', value: 'https://shopee.vn/' }
            ]
          },
          condition: {
            urlFilter: '||shopee.vn/*',
            resourceTypes: ['xmlhttprequest']
          }
        }
      ]
    });
  } catch (e) {
    console.warn('DeclarativeNetRequest rule error:', e);
  }
}
setupNetRules();

// Ensure Offscreen Document runs continuously (Never suspended by Chrome)
let isCreatingOffscreen = false;
async function ensureOffscreen() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) return;
  if (isCreatingOffscreen) return;
  isCreatingOffscreen = true;

  try {
    let hasDoc = false;
    if (typeof chrome.offscreen.hasDocument === 'function') {
      hasDoc = await chrome.offscreen.hasDocument();
    }
    if (!hasDoc) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_SCRAPING'],
        justification: 'Keep 10s background realtime monitor alive'
      });
      addLog('info', 'Đã kích hoạt engine chạy ngầm 24/7 (Offscreen).');
    }
  } catch (e) {
    // Already exists or not supported
  } finally {
    isCreatingOffscreen = false;
  }
}
ensureOffscreen();

// Listen to port connection from Offscreen Document
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'heartbeat_port') {
    port.onMessage.addListener((msg) => {
      if (msg.action === 'heartbeat_tick') {
        runScanCycle();
      }
    });
  }
// Listen to messages from content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'seller_centre_detected') {
    handleSellerCentreUpdate(msg.products, msg.totalCount).catch(console.error);
  }
});

async function handleSellerCentreUpdate(products, totalCount) {
  if (!Array.isArray(products) || products.length === 0) return;
  const state = await chrome.storage.local.get(null);
  const seenSet = new Set(state.seenItems || []);
  const knownProducts = state.knownProducts || {};
  const isFirstRun = !state.hasEstablishedSellerBaseline;

  const newProductsFound = [];
  for (const p of products) {
    if (!p.itemId) continue;
    // Check price changes
    const old = knownProducts[p.itemId];
    if (old && !isFirstRun) {
      if (p.price && old.price && p.price !== old.price) {
        addLog('alert', `🚨 [Kênh Người Bán] SẢN PHẨM ĐỔI GIÁ: ${p.name} (${old.price.toLocaleString('vi-VN')}₫ ➔ ${p.price.toLocaleString('vi-VN')}₫)`);
        await sendProductUpdateAlert(
          state.teleToken,
          state.teleChatId,
          "The Girl's Room",
          p,
          `Đổi giá: ${old.price.toLocaleString('vi-VN')} ₫ ➔ ${p.price.toLocaleString('vi-VN')} ₫`
        );
        showDesktopNotification("The Girl's Room", {
          name: `Đổi giá: ${p.name}`,
          price: p.price
        });
      }
    }
    knownProducts[p.itemId] = { name: p.name, price: p.price, imageUrl: p.imageUrl, url: p.url };

    if (!seenSet.has(p.itemId)) {
      seenSet.add(p.itemId);
      if (!isFirstRun) {
        newProductsFound.push(p);
      }
    }
  }

  await chrome.storage.local.set({
    seenItems: Array.from(seenSet),
    knownProducts,
    hasEstablishedSellerBaseline: true,
    lastSellerCount: totalCount
  });

  if (isFirstRun) {
    addLog('info', `[Kênh Người Bán] Đã thiết lập mốc ban đầu: ${products.length} sản phẩm. Sẵn sàng bắt sản phẩm mới!`);
  } else if (newProductsFound.length > 0) {
    addLog('alert', `🚨 [Kênh Người Bán] PHÁT HIỆN ${newProductsFound.length} SẢN PHẨM MỚI!`);
    for (const np of newProductsFound) {
      await sendTelegramAlert(state.teleToken, state.teleChatId, "The Girl's Room", np);
      showDesktopNotification("The Girl's Room", np);
    }
  }

  // Also auto-sync Shopee cookies to VPS
  syncShopeeCookiesToVps(state.vpsUrl || 'http://36.50.26.72:3002').catch(() => {});
  // Also auto-sync real products to VPS
  syncProductsToVps(state.vpsUrl || 'http://36.50.26.72:3002', '1368956675', products).catch(() => {});
}

async function syncShopeeCookiesToVps(vpsUrl) {
  if (!chrome.cookies || !vpsUrl) return;
  try {
    const cookies = await chrome.cookies.getAll({ domain: 'shopee.vn' });
    if (cookies && cookies.length > 0) {
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      await fetch(`${vpsUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopeeCookie: cookieStr })
      });
    }
  } catch (e) {}
}

// Initialize Storage on install
chrome.runtime.onInstalled.addListener(async () => {
  setupNetRules();
  ensureOffscreen();
  const data = await chrome.storage.local.get(null);
  const initial = { ...DEFAULT_SETTINGS, ...data };
  await chrome.storage.local.set(initial);
  addLog('success', 'Extension đã được cài đặt và kích hoạt thành công!');
  setupAlarm(initial.intervalSeconds);
  startFastLoop();
});

// Setup Alarm and Polling Loop (Fallback)
function setupAlarm(intervalSec) {
  chrome.alarms.clear('shopee_scan_alarm');
  chrome.alarms.create('shopee_scan_alarm', {
    periodInMinutes: Math.max(1, Math.round(intervalSec / 60))
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'shopee_scan_alarm') {
    ensureOffscreen();
    runScanCycle();
  }
});

// Auto-inject content script into already opened Seller Centre tabs
async function injectContentScriptIntoOpenTabs() {
  if (!chrome.tabs || !chrome.scripting) return;
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://banhang.shopee.vn/*', 'https://shopee.vn/*']
    });
    for (const tab of tabs) {
      if (tab.id) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        }).catch(() => {});
      }
    }
  } catch (e) {}
}

// High-speed runner loop (10s interval support)
let isLoopRunning = false;
async function startFastLoop() {
  if (isLoopRunning) return;
  isLoopRunning = true;
  ensureOffscreen();
  injectContentScriptIntoOpenTabs();
  while (isLoopRunning) {
    const { isActive, intervalSeconds } = await chrome.storage.local.get(['isActive', 'intervalSeconds']);
    if (!isActive) {
      isLoopRunning = false;
      break;
    }
    await runScanCycle();
    const waitMs = Math.max(5000, (intervalSeconds || 10) * 1000);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

// Log utility
async function addLog(type, message) {
  const time = new Date().toLocaleTimeString('vi-VN');
  const { logs = [] } = await chrome.storage.local.get('logs');
  const newLogs = [{ time, type, message }, ...logs].slice(0, 80);
  await chrome.storage.local.set({ logs: newLogs });
  chrome.runtime.sendMessage({ action: 'log_added', log: { time, type, message } }).catch(() => {});
}

// Core Shop Scanner
let isScanning = false;
let globalScanTick = 0;
async function runScanCycle() {
  if (isScanning) return;
  isScanning = true;
  globalScanTick++;

  try {
    const data = await chrome.storage.local.get(null);
    if (!data.isActive) return;

    const shops = data.shops || [];
    const activeShops = shops.filter((s) => s.is_active);
    if (activeShops.length === 0) return;

    const nowStr = new Date().toLocaleTimeString('vi-VN');
    await chrome.storage.local.set({ lastCheckTime: nowStr });

    for (const shop of activeShops) {
      await scanSingleShop(shop, data);
    }
  } catch (err) {
    addLog('alert', `Lỗi chu kỳ quét: ${err.message}`);
  } finally {
    isScanning = false;
  }
}

async function scanSingleShop(shop, state) {
  try {
    let numericShopId = shop.shop_id;

    // Resolve shopId if missing
    if (!numericShopId) {
      const match = shop.shop_url.match(/shop\/(\d+)/);
      if (match) numericShopId = match[1];
      else {
        const usernameMatch = shop.shop_url.match(/shopee\.vn\/([^/?#]+)/);
        if (usernameMatch) {
          const uRes = await fetch(`https://shopee.vn/api/v4/pages/is_short_url/?path=${usernameMatch[1]}`);
          const uData = await uRes.json();
          if (uData.data?.shop_id) numericShopId = String(uData.data.shop_id);
        }
      }
    }

    if (!numericShopId) {
      addLog('warn', `Chưa tìm thấy ID của shop: ${shop.shop_name}`);
      return;
    }

    // Step 1: Query both get_categories and get_shop_base_v2
    let categoryTotal = 0;
    let baseTotal = 0;
    let categorySignature = '';
    let categoriesList = [];

    try {
      const catRes = await fetch(`https://shopee.vn/api/v4/shop/get_categories?shopid=${numericShopId}`, {
        credentials: 'include',
        headers: {
          'x-api-source': 'pc',
          'x-requested-with': 'XMLHttpRequest',
          'x-shopee-language': 'vi',
          'referer': shop.shop_url || `https://shopee.vn/shop/${numericShopId}`
        }
      });

      if (catRes.ok) {
        const catData = await catRes.json();
        categoriesList = catData.data?.shop_categories || [];
        categoryTotal = categoriesList.reduce((sum, c) => sum + (c.total || 0), 0);
        categorySignature = categoriesList.map((c) => `${c.shop_category_id}:${c.total}`).join(',');
      }
    } catch (e) {}

    // Also query get_shop_base_v2 (Returns TRUE item_count of entire shop)
    try {
      const usernameMatch = shop.shop_url ? shop.shop_url.match(/shopee\.vn\/([^/?#]+)/) : null;
      const username = usernameMatch ? usernameMatch[1] : '';
      const baseRes = await fetch('https://shopee.vn/api/v4/shop/get_shop_base_v2', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-api-source': 'pc',
          'x-requested-with': 'XMLHttpRequest',
          'x-shopee-language': 'vi',
          'referer': shop.shop_url || `https://shopee.vn/shop/${numericShopId}`
        },
        body: JSON.stringify({
          entry_point: '',
          request_source: 'pc_shop_home_page',
          username: username,
          ...(numericShopId ? { shopid: Number(numericShopId) } : {})
        })
      });

      if (baseRes.ok) {
        const baseData = await baseRes.json();
        baseTotal = baseData.data?.item_count || 0;
      }
    } catch (e) {}

    const liveItemCount = Math.max(categoryTotal, baseTotal);

    const lastItemCount = shop.last_item_count;
    const lastSig = shop.last_category_sig;

    // Check if item count increased OR category signature changed OR first run
    const isFirstRun = lastItemCount === undefined || lastItemCount === null;
    const hasCountIncreased = liveItemCount > (lastItemCount || 0);
    const hasSigChanged = Boolean(lastSig && categorySignature && lastSig !== categorySignature);
    const hasNewItems = hasCountIncreased || hasSigChanged;

    // Fetch current products for new/updated detection
    const products = await fetchShopProducts(numericShopId, shop.shop_url);
    const seenSet = new Set(state.seenItems || []);
    const knownProducts = state.knownProducts || {};
    let hasUpdatedProduct = false;

    // 1. Check for product updates (e.g. price change, name change)
    for (const p of products) {
      const old = knownProducts[p.itemId];
      if (old && !isFirstRun) {
        if (p.price && old.price && p.price !== old.price) {
          hasUpdatedProduct = true;
          addLog(
            'alert',
            `🚨 [${shop.shop_name}] SẢN PHẨM ĐỔI GIÁ: ${p.name} (${old.price.toLocaleString('vi-VN')}₫ ➔ ${p.price.toLocaleString('vi-VN')}₫)`
          );
          await sendProductUpdateAlert(
            state.teleToken,
            state.teleChatId,
            shop.shop_name,
            p,
            `Đổi giá: ${old.price.toLocaleString('vi-VN')} ₫ ➔ ${p.price.toLocaleString('vi-VN')} ₫`
          );
          showDesktopNotification(shop.shop_name, {
            name: `Đổi giá: ${p.name}`,
            price: p.price
          });
        } else if (p.name && old.name && p.name !== old.name) {
          hasUpdatedProduct = true;
          addLog('alert', `🚨 [${shop.shop_name}] SẢN PHẨM ĐỔI TÊN: "${old.name}" ➔ "${p.name}"`);
          await sendProductUpdateAlert(
            state.teleToken,
            state.teleChatId,
            shop.shop_name,
            p,
            `Đổi tên: ${p.name}`
          );
          showDesktopNotification(shop.shop_name, {
            name: `Đổi tên: ${p.name}`,
            price: p.price
          });
        }
      }
      knownProducts[p.itemId] = { name: p.name, price: p.price, imageUrl: p.imageUrl, url: p.url };
    }

    // 2. Check for new products
    const newProductsFound = [];
    for (const p of products) {
      if (!seenSet.has(p.itemId)) {
        seenSet.add(p.itemId);
        newProductsFound.push(p);
      }
    }

    // Update state
    const updatedShops = state.shops.map((s) =>
      s.id === shop.id
        ? {
            ...s,
            shop_id: numericShopId,
            last_item_count: liveItemCount,
            last_category_sig: categorySignature
          }
        : s
    );

    await chrome.storage.local.set({
      shops: updatedShops,
      seenItems: Array.from(seenSet),
      knownProducts
    });

    if (isFirstRun) {
      addLog('info', `[${shop.shop_name}] Đã đồng bộ mốc ban đầu: ${liveItemCount} SP (${products.length} SP đã lưu).`);
    } else if (newProductsFound.length > 0) {
      addLog('alert', `🚨 [${shop.shop_name}] PHÁT HIỆN ${newProductsFound.length} SẢN PHẨM MỚI!`);

      // Send alerts for each new product
      for (const np of newProductsFound) {
        await sendTelegramAlert(state.teleToken, state.teleChatId, shop.shop_name, np);
        showDesktopNotification(shop.shop_name, np);
      }

      // Increment today count
      const todayCount = (state.newProductsToday || 0) + newProductsFound.length;
      await chrome.storage.local.set({ newProductsToday: todayCount });

      // Sync to VPS Server
      syncProductsToVps(state.vpsUrl, numericShopId, products).catch(() => {});
    } else if (hasNewItems) {
      // Find category that has images or newest count
      const targetCat = categoriesList.find((c) => c.image && c.total > 0) || categoriesList[0];
      const newCard = {
        itemId: 'cat_' + (targetCat?.shop_category_id || Date.now()),
        name: targetCat ? `[Sản phẩm mới] Nhóm: "${targetCat.display_name}" (+${liveItemCount - (lastItemCount || 0)} SP)` : `Sản phẩm mới từ ${shop.shop_name}`,
        price: 0,
        url: targetCat ? `https://shopee.vn/shop/${numericShopId}/search?shopCollection=${targetCat.shop_category_id}` : (shop.shop_url || `https://shopee.vn/shop/${numericShopId}`),
        imageUrl: targetCat?.image ? `https://down-vn.img.susercontent.com/file/${targetCat.image}` : undefined
      };

      addLog('alert', `🚨 [${shop.shop_name}] PHÁT HIỆN SẢN PHẨM MỚI (${lastItemCount || 0} ➔ ${liveItemCount} SP)!`);
      await sendTelegramAlert(state.teleToken, state.teleChatId, shop.shop_name, newCard);
      showDesktopNotification(shop.shop_name, newCard);

      const addedCount = Math.max(1, liveItemCount - (lastItemCount || 0));
      const todayCount = (state.newProductsToday || 0) + addedCount;
      await chrome.storage.local.set({ newProductsToday: todayCount });
    } else if (!hasUpdatedProduct) {
      // Heartbeat logging: every 3 cycles (~30s), log a heartbeat so user sees active realtime scanning
      if (globalScanTick % 3 === 0) {
        addLog('info', `[${shop.shop_name}] Giám sát realtime (${liveItemCount} SP) - Chưa có biến động.`);
      }
    }
  } catch (err) {
    addLog('warn', `Lỗi quét shop ${shop.shop_name}: ${err.message}`);
  }
}

// Fetch products from Shopee inside extension
async function fetchShopProducts(shopId, shopUrl) {
  const items = [];
  const seen = new Set();
  const referer = shopUrl || `https://shopee.vn/shop/${shopId}`;

  // 1. rcmd_items (Product tab sorted by newest: sort_type=1)
  try {
    const r = await fetch(
      `https://shopee.vn/api/v4/shop/rcmd_items?bundle=shop_page_product_tab&limit=30&offset=0&shop_id=${shopId}&sort_type=1`,
      {
        credentials: 'include',
        headers: {
          'x-api-source': 'pc',
          'x-requested-with': 'XMLHttpRequest',
          'x-shopee-language': 'vi',
          'referer': referer
        }
      }
    );
    if (r.ok) {
      const data = await r.json();
      const list = data.data?.items || data.items || [];
      for (const it of list) {
        const item = it.item_basic || it;
        if (item && item.itemid && !seen.has(String(item.itemid))) {
          seen.add(String(item.itemid));
          let price = item.price || item.price_min || 0;
          if (price > 10000000) price = Math.round(price / 100000);
          const imageId = item.image || item.images?.[0];
          items.push({
            itemId: String(item.itemid),
            shopId: String(item.shopid || shopId),
            name: item.name || 'Sản phẩm mới',
            url: `https://shopee.vn/product/${item.shopid || shopId}/${item.itemid}`,
            price,
            imageUrl: imageId ? (imageId.startsWith('http') ? imageId : `https://down-vn.img.susercontent.com/file/${imageId}`) : undefined,
            ctime: item.ctime || Math.floor(Date.now() / 1000)
          });
        }
      }
    }
  } catch (e) {}

  // 2. search_items (Sorted by ctime desc - creation time)
  try {
    const r = await fetch(
      `https://shopee.vn/api/v4/search/search_items?by=ctime&limit=30&match_id=${shopId}&newest=0&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2`,
      {
        credentials: 'include',
        headers: {
          'x-api-source': 'pc',
          'x-requested-with': 'XMLHttpRequest',
          'x-shopee-language': 'vi',
          'referer': referer
        }
      }
    );
    if (r.ok) {
      const data = await r.json();
      const list = data.items || [];
      for (const it of list) {
        const item = it.item_basic || it;
        if (item && item.itemid && !seen.has(String(item.itemid))) {
          seen.add(String(item.itemid));
          let price = item.price || item.price_min || 0;
          if (price > 10000000) price = Math.round(price / 100000);
          const imageId = item.image || item.images?.[0];
          items.push({
            itemId: String(item.itemid),
            shopId: String(item.shopid || shopId),
            name: item.name || 'Sản phẩm mới',
            url: `https://shopee.vn/product/${item.shopid || shopId}/${item.itemid}`,
            price,
            imageUrl: imageId ? (imageId.startsWith('http') ? imageId : `https://down-vn.img.susercontent.com/file/${imageId}`) : undefined,
            ctime: item.ctime || Math.floor(Date.now() / 1000)
          });
        }
      }
    }
  } catch (e) {}

  // 3. get_shop_seo (Super reliable, returns latest items without captcha)
  try {
    const r = await fetch(`https://shopee.vn/api/v4/shop/get_shop_seo?shopid=${shopId}`, {
      credentials: 'include',
      headers: {
        'x-api-source': 'pc',
        'x-requested-with': 'XMLHttpRequest',
        'x-shopee-language': 'vi',
        'referer': referer
      }
    });
    if (r.ok) {
      const data = await r.json();
      const list = data.data?.items || [];
      for (const it of list) {
        const item = it.item_basic || it;
        if (item && item.itemid && !seen.has(String(item.itemid))) {
          seen.add(String(item.itemid));
          let price = item.price || item.price_min || 0;
          if (price > 10000000) price = Math.round(price / 100000);
          const imageId = item.image || item.images?.[0];
          items.push({
            itemId: String(item.itemid),
            shopId: String(item.shopid || shopId),
            name: item.name || 'Sản phẩm mới',
            url: `https://shopee.vn/product/${item.shopid || shopId}/${item.itemid}`,
            price,
            imageUrl: imageId ? (imageId.startsWith('http') ? imageId : `https://down-vn.img.susercontent.com/file/${imageId}`) : undefined,
            ctime: item.ctime || Math.floor(Date.now() / 1000)
          });
        }
      }
    }
  } catch (e) {}

  // 4. rcmd_items (Main category tab fallback)
  try {
    const r = await fetch(
      `https://shopee.vn/api/v4/shop/rcmd_items?bundle=shop_page_category_tab_main&limit=30&offset=0&shop_id=${shopId}`,
      {
        credentials: 'include',
        headers: {
          'x-api-source': 'pc',
          'x-requested-with': 'XMLHttpRequest',
          'x-shopee-language': 'vi',
          'referer': referer
        }
      }
    );
    if (r.ok) {
      const data = await r.json();
      const list = data.data?.items || data.items || [];
      for (const it of list) {
        const item = it.item_basic || it;
        if (item && item.itemid && !seen.has(String(item.itemid))) {
          seen.add(String(item.itemid));
          let price = item.price || item.price_min || 0;
          if (price > 10000000) price = Math.round(price / 100000);
          const imageId = item.image || item.images?.[0];
          items.push({
            itemId: String(item.itemid),
            shopId: String(item.shopid || shopId),
            name: item.name || 'Sản phẩm mới',
            url: `https://shopee.vn/product/${item.shopid || shopId}/${item.itemid}`,
            price,
            imageUrl: imageId ? (imageId.startsWith('http') ? imageId : `https://down-vn.img.susercontent.com/file/${imageId}`) : undefined,
            ctime: item.ctime || Math.floor(Date.now() / 1000)
          });
        }
      }
    }
  } catch (e) {}

  return items;
}

// Telegram Dispatcher
async function sendTelegramAlert(botToken, chatId, shopName, item) {
  if (!botToken || !chatId) {
    addLog('warn', 'Thiếu Telegram Bot Token hoặc Chat ID.');
    return;
  }

  const timeStr = new Date().toLocaleString('vi-VN');
  const priceFormatted = item.price ? `${item.price.toLocaleString('vi-VN')} ₫` : 'Liên hệ';

  const caption = 
    `🚨 <b>SẢN PHẨM MỚI PHÁT HIỆN!</b>\n\n` +
    `🏪 <b>Shop:</b> ${escapeHtml(shopName)}\n` +
    `📦 <b>Sản phẩm:</b> ${escapeHtml(item.name)}\n` +
    `💰 <b>Giá:</b> <code>${priceFormatted}</code>\n` +
    `⏰ <b>Thời gian:</b> ${timeStr}\n\n` +
    `🔗 <a href="${item.url}"><b>XEM NGAY TRÊN SHOPEE</b></a>`;

  try {
    if (item.imageUrl) {
      const photoUrl = `https://api.telegram.org/bot${botToken}/sendPhoto`;
      const res = await fetch(photoUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          photo: item.imageUrl,
          caption: caption,
          parse_mode: 'HTML'
        })
      });
      if (res.ok) {
        addLog('success', `Đã bắn thông báo Telegram kèm ảnh: ${item.name}`);
        return;
      }
    }

    // Fallback: send text message
    const msgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(msgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: caption,
        parse_mode: 'HTML',
        disable_web_page_preview: false
      })
    });
    if (res.ok) {
      addLog('success', `Đã bắn thông báo Telegram: ${item.name}`);
    } else {
      const errJson = await res.json().catch(() => ({}));
      addLog('alert', `Lỗi gửi Telegram: ${errJson.description || res.status}`);
    }
  } catch (err) {
    addLog('alert', `Lỗi mạng khi gửi Telegram: ${err.message}`);
  }
}

// Instant Shop Count Telegram Alert (Fires when quantity changes)
async function sendShopCountAlert(botToken, chatId, shopName, shopUrl, oldCount, newCount) {
  if (!botToken || !chatId) {
    addLog('warn', 'Thiếu Telegram Bot Token hoặc Chat ID.');
    return;
  }

  const timeStr = new Date().toLocaleString('vi-VN');
  const added = newCount - (oldCount || 0);
  const targetUrl = shopUrl || 'https://shopee.vn';

  const text =
    `🚨 <b>PHÁT HIỆN SHOP VỪA ĐĂNG SẢN PHẨM MỚI!</b>\n\n` +
    `🏪 <b>Shop:</b> ${escapeHtml(shopName)}\n` +
    `📦 <b>Biến động:</b> <code>${oldCount || 0}</code> ➔ <code>${newCount}</code> SP (<b>+${added > 0 ? added : 1} sản phẩm mới</b>)\n` +
    `⏰ <b>Thời gian:</b> ${timeStr}\n\n` +
    `🔗 <a href="${targetUrl}"><b>BẤM VÀO ĐÂY ĐỂ XEM SHOP NGAY TRÊN SHOPEE</b></a>`;

  try {
    const msgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(msgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false
      })
    });
    if (res.ok) {
      addLog('success', `Đã bắn thông báo Telegram: [${shopName}] biến động +${added > 0 ? added : 1} SP`);
    } else {
      const errJson = await res.json().catch(() => ({}));
      addLog('alert', `Lỗi gửi Telegram: ${errJson.description || res.status}`);
    }
  } catch (err) {
    addLog('alert', `Lỗi mạng khi gửi Telegram: ${err.message}`);
  }
}

// Product Update Telegram Alert (Fires when price, name or info is edited)
async function sendProductUpdateAlert(botToken, chatId, shopName, item, updateDetail) {
  if (!botToken || !chatId) return;

  const timeStr = new Date().toLocaleString('vi-VN');
  const priceFormatted = item.price ? `${item.price.toLocaleString('vi-VN')} ₫` : 'Liên hệ';

  const caption =
    `🔔 <b>SẢN PHẨM CẬP NHẬT THÔNG TIN!</b>\n\n` +
    `🏪 <b>Shop:</b> ${escapeHtml(shopName)}\n` +
    `📦 <b>Sản phẩm:</b> ${escapeHtml(item.name)}\n` +
    `📝 <b>Chi tiết cập nhật:</b> <code>${escapeHtml(updateDetail)}</code>\n` +
    `💰 <b>Giá hiện tại:</b> <code>${priceFormatted}</code>\n` +
    `⏰ <b>Thời gian:</b> ${timeStr}\n\n` +
    `🔗 <a href="${item.url}"><b>XEM SẢN PHẨM TRÊN SHOPEE</b></a>`;

  try {
    if (item.imageUrl) {
      const photoUrl = `https://api.telegram.org/bot${botToken}/sendPhoto`;
      const res = await fetch(photoUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          photo: item.imageUrl,
          caption: caption,
          parse_mode: 'HTML'
        })
      });
      if (res.ok) {
        addLog('success', `Đã bắn thông báo cập nhật Telegram: ${item.name}`);
        return;
      }
    }

    const msgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(msgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: caption,
        parse_mode: 'HTML',
        disable_web_page_preview: false
      })
    });
    if (res.ok) {
      addLog('success', `Đã bắn thông báo cập nhật Telegram: ${item.name}`);
    }
  } catch (err) {
    addLog('alert', `Lỗi gửi Telegram khi cập nhật SP: ${err.message}`);
  }
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function showDesktopNotification(shopName, item) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `Sản phẩm mới từ ${shopName}`,
    message: `${item.name} - Giá: ${item.price ? item.price.toLocaleString('vi-VN') + ' đ' : 'Liên hệ'}`,
    priority: 2
  });
}

// Sync to VPS Server
async function syncProductsToVps(vpsUrl, shopId, products) {
  if (!vpsUrl) return;
  try {
    const res = await fetch(`${vpsUrl}/api/sync/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopId, products })
    });
    if (res.ok) {
      addLog('info', `Đã đồng bộ ${products.length} sản phẩm lên VPS (${vpsUrl})`);
    }
  } catch (e) {}
}

// Message Listener from Popup & Content Scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'seller_centre_detected') {
    handleSellerCentreSync(request.totalCount, request.products || []);
    sendResponse({ success: true });
    return true;
  }
  if (request.action === 'trigger_scan_now') {
    runScanCycle().then(() => sendResponse({ success: true }));
    return true;
  }
  if (request.action === 'start_monitoring') {
    startFastLoop();
    sendResponse({ success: true });
    return true;
  }
  if (request.action === 'stop_monitoring') {
    isLoopRunning = false;
    sendResponse({ success: true });
    return true;
  }
  if (request.action === 'test_telegram') {
    sendTelegramAlert(
      request.token,
      request.chatId,
      "The Girl's Room (Test Bot)",
      {
        itemId: '56418741612',
        name: 'Kẹp Tóc Càng Cua Nữ – Nhựa Cao Cấp Phong Cách Hàn Quốc (Test)',
        price: 29000,
        url: 'https://shopee.vn/product/1368956675/56418741612',
        imageUrl: 'https://down-vn.img.susercontent.com/file/vn-11134207-81ztc-mtwidlde8wed3c'
      }
    ).then(() => sendResponse({ success: true }));
    return true;
  }
});

// Real-time Handler for Seller Centre (banhang.shopee.vn)
async function handleSellerCentreSync(liveTotal, products) {
  try {
    const data = await chrome.storage.local.get(null);
    const shop = (data.shops || []).find((s) => s.id === 1) || data.shops?.[0];
    if (!shop) return;

    const lastCount = shop.last_item_count || 0;
    const seenSet = new Set(data.seenItems || []);
    const knownProducts = data.knownProducts || {};

    const newProductsFound = [];

    // 1. Check for product updates (price or name edit)
    for (const p of products) {
      const old = knownProducts[p.itemId];
      if (old) {
        if (p.price && old.price && p.price !== old.price) {
          addLog(
            'alert',
            `🚨 [Kênh Người Bán] ĐỔI GIÁ: ${p.name} (${old.price.toLocaleString('vi-VN')}₫ ➔ ${p.price.toLocaleString('vi-VN')}₫)`
          );
          await sendProductUpdateAlert(
            data.teleToken,
            data.teleChatId,
            shop.shop_name,
            p,
            `Đổi giá: ${old.price.toLocaleString('vi-VN')} ₫ ➔ ${p.price.toLocaleString('vi-VN')} ₫`
          );
        } else if (p.name && old.name && p.name !== old.name) {
          addLog('alert', `🚨 [Kênh Người Bán] ĐỔI TÊN: "${old.name}" ➔ "${p.name}"`);
          await sendProductUpdateAlert(
            data.teleToken,
            data.teleChatId,
            shop.shop_name,
            p,
            `Đổi tên: ${p.name}`
          );
        }
      }
      knownProducts[p.itemId] = { name: p.name, price: p.price, imageUrl: p.imageUrl, url: p.url };

      // 2. Check for new items
      if (!seenSet.has(p.itemId)) {
        seenSet.add(p.itemId);
        newProductsFound.push(p);
      }
    }

    // Check count increase (e.g. 15 -> 17)
    const countIncreased = liveTotal > lastCount;

    if (countIncreased || newProductsFound.length > 0) {
      addLog('alert', `⚡ [Kênh Người Bán] Phát hiện số lượng thay đổi: ${lastCount} ➔ ${liveTotal} SP!`);

      if (newProductsFound.length > 0) {
        for (const np of newProductsFound) {
          await sendTelegramAlert(data.teleToken, data.teleChatId, shop.shop_name, np);
          showDesktopNotification(shop.shop_name, np);
        }
      } else if (products.length > 0) {
        const np = products[0];
        await sendTelegramAlert(data.teleToken, data.teleChatId, shop.shop_name, np);
        showDesktopNotification(shop.shop_name, np);
      } else {
        await sendShopCountAlert(
          data.teleToken,
          data.teleChatId,
          shop.shop_name,
          shop.shop_url,
          lastCount,
          liveTotal
        );
        showDesktopNotification(shop.shop_name, {
          name: `Shop vừa đăng sản phẩm mới! (${lastCount} ➔ ${liveTotal} SP)`,
          price: 0
        });
      }

      const added = Math.max(newProductsFound.length, liveTotal - lastCount);
      const todayCount = (data.newProductsToday || 0) + added;

      const updatedShops = (data.shops || []).map((s) =>
        s.id === shop.id ? { ...s, last_item_count: liveTotal } : s
      );

      await chrome.storage.local.set({
        shops: updatedShops,
        seenItems: Array.from(seenSet),
        knownProducts,
        newProductsToday: todayCount
      });
    } else {
      await chrome.storage.local.set({ knownProducts });
    }
  } catch (err) {
    console.warn('Seller Centre sync error:', err);
  }
}

// Start fast runner loop
startFastLoop();
