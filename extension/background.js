/**
 * Shopee Realtime Product Monitor - Background Service Worker (Manifest V3)
 * High-speed 10s-20s realtime monitoring supporting up to 200+ shops.
 * Executes requests via open Shopee buyer tab to guarantee 0% WAF blocks.
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
      last_item_count: 18
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

// 1. Setup declarativeNetRequest to inject headers for all fetch calls
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
              { header: 'Referer', operation: 'set', value: 'https://shopee.vn/' },
              { header: 'x-api-source', operation: 'set', value: 'pc' },
              { header: 'x-shopee-language', operation: 'set', value: 'vi' }
            ]
          },
          condition: {
            urlFilter: '||shopee.vn/*',
            resourceTypes: ['xmlhttprequest', 'other', 'sub_frame', 'main_frame']
          }
        }
      ]
    });
  } catch (e) {
    console.warn('DeclarativeNetRequest rule error:', e);
  }
}
setupNetRules();

// 2. Ensure Offscreen Document runs continuously (Never suspended by Chrome)
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
});

// 3. Delegate API calls through open Shopee Buyer Tab (Same-origin credentials)
async function fetchViaBuyerTab(url, referer, options = {}) {
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.shopee.vn/*' });
    if (!tabs || tabs.length === 0) return null;
    const buyerTab = tabs.find((t) => !t.url.includes('banhang.') && !t.url.includes('seller.')) || tabs[0];
    if (!buyerTab || !buyerTab.id) return null;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 5000);
      chrome.tabs.sendMessage(
        buyerTab.id,
        {
          action: 'fetch_shopee_api',
          url,
          referer: referer || 'https://shopee.vn/',
          method: options.method || 'GET',
          headers: options.headers,
          body: options.body
        },
        (res) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError || !res || !res.success) {
            resolve(null);
          } else {
            resolve(res.data);
          }
        }
      );
    });
  } catch (e) {
    return null;
  }
}

// 4. Initialize Storage on install
chrome.runtime.onInstalled.addListener(async () => {
  setupNetRules();
  ensureOffscreen();
  const data = await chrome.storage.local.get(null);
  const initial = { ...DEFAULT_SETTINGS, ...data };
  await chrome.storage.local.set(initial);
  addLog('success', 'Shopee Realtime Monitor PRO đã kích hoạt thành công!');
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

// Auto-inject content script into already opened Shopee tabs
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
  const newLogs = [{ time, type, message }, ...logs].slice(0, 100);
  await chrome.storage.local.set({ logs: newLogs });
  chrome.runtime.sendMessage({ action: 'log_added', log: { time, type, message } }).catch(() => {});
}

// 5. Core Shop Scanner (Supports scaling to 200 shops with batching)
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

    // Concurrent batch scanning: 8 shops per batch to process 200 shops in ~6-8 seconds
    const BATCH_SIZE = 8;
    for (let i = 0; i < activeShops.length; i += BATCH_SIZE) {
      const batch = activeShops.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map((shop) => scanSingleShop(shop, data)));
    }
  } catch (err) {
    addLog('alert', `Lỗi chu kỳ quét: ${err.message}`);
  } finally {
    isScanning = false;
  }
}

// Scan single shop for new products and price updates
async function scanSingleShop(shop, state) {
  try {
    let numericShopId = shop.shop_id;

    // Resolve numeric shop ID if not yet resolved
    if (!numericShopId) {
      const match = shop.shop_url.match(/shop\/(\d+)/);
      if (match) numericShopId = match[1];
      else {
        const usernameMatch = shop.shop_url.match(/shopee\.vn\/([^/?#]+)/);
        if (usernameMatch) {
          try {
            const uRes = await fetch(`https://shopee.vn/api/v4/pages/is_short_url/?path=${usernameMatch[1]}`);
            const uData = await uRes.json();
            if (uData.data?.shop_id) numericShopId = String(uData.data.shop_id);
          } catch (e) {}
        }
      }
    }

    if (!numericShopId) {
      addLog('warn', `Chưa tìm thấy ID của shop: ${shop.shop_name}`);
      return;
    }

    // Step 1: Query get_categories to detect total items in real-time (~50ms)
    let liveItemCount = 0;
    let categorySignature = '';
    const referer = shop.shop_url || `https://shopee.vn/shop/${numericShopId}`;

    // Try buyer tab first, then fallback to direct fetch
    let catData = await fetchViaBuyerTab(`https://shopee.vn/api/v4/shop/get_categories?shopid=${numericShopId}`, referer);
    if (!catData || !catData.data?.shop_categories) {
      try {
        const catRes = await fetch(`https://shopee.vn/api/v4/shop/get_categories?shopid=${numericShopId}`, {
          credentials: 'include',
          headers: {
            'x-api-source': 'pc',
            'x-requested-with': 'XMLHttpRequest',
            'x-shopee-language': 'vi',
            'referer': referer
          }
        });
        if (catRes.ok) catData = await catRes.json();
      } catch (e) {}
    }

    if (catData?.data?.shop_categories) {
      const categoriesList = catData.data.shop_categories;
      liveItemCount = categoriesList.reduce((sum, c) => sum + (c.total || 0), 0);
      categorySignature = categoriesList.map((c) => `${c.shop_category_id}:${c.total}`).join(',');
    }

    const lastItemCount = shop.last_item_count;
    const lastSig = shop.last_category_sig;
    const isFirstRun = lastItemCount === undefined || lastItemCount === null;
    const hasCountIncreased = liveItemCount > (lastItemCount || 0);
    const hasSigChanged = Boolean(lastSig && categorySignature && lastSig !== categorySignature);

    // Fetch products
    let products = await fetchShopProducts(numericShopId, shop.shop_url);
    const seenSet = new Set(state.seenItems || []);
    const knownProducts = state.knownProducts || {};

    // 1. Check for product updates (price change, name change)
    for (const p of products) {
      const old = knownProducts[p.itemId];
      if (old && !isFirstRun) {
        if (p.price && old.price && p.price !== old.price) {
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
    let newProductsFound = products.filter((p) => !seenSet.has(p.itemId));

    // If item count increased but search_items hasn't indexed the new product yet:
    // Retry up to 2 times with 2.5s delay to let Shopee index catch up!
    if (newProductsFound.length === 0 && hasCountIncreased && !isFirstRun) {
      addLog('info', `[${shop.shop_name}] Phát hiện số lượng tăng (${lastItemCount} ➔ ${liveItemCount} SP). Đang lấy chi tiết sản phẩm mới...`);
      for (let attempt = 1; attempt <= 2; attempt++) {
        await new Promise((r) => setTimeout(r, 2500));
        products = await fetchShopProducts(numericShopId, shop.shop_url);
        newProductsFound = products.filter((p) => !seenSet.has(p.itemId));
        if (newProductsFound.length > 0) break;
      }
    }

    // Update storage state
    const currentCount = liveItemCount > 0 ? liveItemCount : (lastItemCount || products.length);
    const updatedShops = (state.shops || []).map((s) =>
      s.id === shop.id
        ? {
            ...s,
            shop_id: numericShopId,
            last_item_count: currentCount,
            last_category_sig: categorySignature || s.last_category_sig
          }
        : s
    );

    // Save seen items and known products
    if (isFirstRun) {
      for (const p of products) {
        seenSet.add(p.itemId);
        knownProducts[p.itemId] = { name: p.name, price: p.price, imageUrl: p.imageUrl, url: p.url };
      }
      await chrome.storage.local.set({
        shops: updatedShops,
        seenItems: Array.from(seenSet),
        knownProducts
      });
      addLog('info', `[${shop.shop_name}] Đã đồng bộ mốc ban đầu: ${currentCount} SP (${products.length} SP đã lập chỉ mục). Sẵn sàng bắt biến động!`);
      return;
    }

    // If new products found: Send REAL Telegram alert with direct product link, name & price!
    if (newProductsFound.length > 0) {
      addLog('alert', `🚨 [${shop.shop_name}] PHÁT HIỆN ${newProductsFound.length} SẢN PHẨM MỚI!`);

      for (const np of newProductsFound) {
        seenSet.add(np.itemId);
        knownProducts[np.itemId] = { name: np.name, price: np.price, imageUrl: np.imageUrl, url: np.url };
        await sendTelegramAlert(state.teleToken, state.teleChatId, shop.shop_name, np);
        showDesktopNotification(shop.shop_name, np);
      }

      const todayCount = (state.newProductsToday || 0) + newProductsFound.length;
      await chrome.storage.local.set({
        shops: updatedShops,
        seenItems: Array.from(seenSet),
        knownProducts,
        newProductsToday: todayCount
      });

      // Sync to VPS Server
      syncProductsToVps(state.vpsUrl, numericShopId, products).catch(() => {});
    } else {
      await chrome.storage.local.set({
        shops: updatedShops,
        knownProducts
      });

      // Heartbeat logging every 3 cycles
      if (globalScanTick % 3 === 0) {
        addLog('info', `[${shop.shop_name}] Giám sát thời gian thực (${currentCount} SP) - Hệ thống ổn định.`);
      }
    }
  } catch (err) {
    addLog('warn', `Lỗi quét shop ${shop.shop_name}: ${err.message}`);
  }
}

// 6. Fetch products from Shopee (delegating via open buyer tab)
async function fetchShopProducts(shopId, shopUrl) {
  const items = [];
  const seen = new Set();
  const referer = shopUrl || `https://shopee.vn/shop/${shopId}`;

  // Method 1: search_items (Sorted by ctime desc = creation time descending)
  // This is the fastest way to get newly created products!
  const searchUrl = `https://shopee.vn/api/v4/search/search_items?by=ctime&limit=30&match_id=${shopId}&newest=0&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2`;
  let searchData = await fetchViaBuyerTab(searchUrl, referer);
  if (!searchData || !searchData.items) {
    try {
      const r = await fetch(searchUrl, {
        credentials: 'include',
        headers: {
          'x-api-source': 'pc',
          'x-requested-with': 'XMLHttpRequest',
          'x-shopee-language': 'vi',
          'referer': referer
        }
      });
      if (r.ok) searchData = await r.json();
    } catch (e) {}
  }

  if (searchData && searchData.items) {
    for (const it of searchData.items) {
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

  // Method 2: rcmd_items (sort_type=1: Newest items on product tab)
  const rcmdUrl = `https://shopee.vn/api/v4/shop/rcmd_items?bundle=shop_page_product_tab&limit=30&offset=0&shop_id=${shopId}&sort_type=1`;
  let rcmdData = await fetchViaBuyerTab(rcmdUrl, referer);
  if (!rcmdData || (!rcmdData.data?.items && !rcmdData.items)) {
    try {
      const r = await fetch(rcmdUrl, {
        credentials: 'include',
        headers: {
          'x-api-source': 'pc',
          'x-requested-with': 'XMLHttpRequest',
          'x-shopee-language': 'vi',
          'referer': referer
        }
      });
      if (r.ok) rcmdData = await r.json();
    } catch (e) {}
  }

  const rcmdList = rcmdData?.data?.items || rcmdData?.items || [];
  for (const it of rcmdList) {
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

  return items;
}

// 7. Telegram Dispatcher (Real product alert with direct URL, name & price)
async function sendTelegramAlert(botToken, chatId, shopName, item) {
  if (!botToken || !chatId) {
    addLog('warn', 'Thiếu Telegram Bot Token hoặc Chat ID.');
    return;
  }

  const timeStr = new Date().toLocaleString('vi-VN');
  const priceFormatted = item.price > 0 ? `${item.price.toLocaleString('vi-VN')} ₫` : 'Đang cập nhật giá';

  const caption = 
    `🚨 <b>SẢN PHẨM MỚI PHÁT HIỆN!</b>\n\n` +
    `🏪 <b>Shop:</b> ${escapeHtml(shopName)}\n` +
    `📦 <b>Sản phẩm:</b> ${escapeHtml(item.name)}\n` +
    `💰 <b>Giá:</b> <code>${priceFormatted}</code>\n` +
    `⏰ <b>Thời gian:</b> ${timeStr}\n\n` +
    `🔗 <a href="${item.url}"><b>XEM NGAY TRÊN SHOPEE</b></a>\n` +
    `🌐 <code>${item.url}</code>`;

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

// 8. Product Update Telegram Alert (Fires when price, name or info is edited)
async function sendProductUpdateAlert(botToken, chatId, shopName, item, updateDetail) {
  if (!botToken || !chatId) return;

  const timeStr = new Date().toLocaleString('vi-VN');
  const priceFormatted = item.price > 0 ? `${item.price.toLocaleString('vi-VN')} ₫` : 'Đang cập nhật';

  const caption =
    `🔔 <b>SẢN PHẨM CẬP NHẬT THÔNG TIN!</b>\n\n` +
    `🏪 <b>Shop:</b> ${escapeHtml(shopName)}\n` +
    `📦 <b>Sản phẩm:</b> ${escapeHtml(item.name)}\n` +
    `📝 <b>Chi tiết:</b> <b>${escapeHtml(updateDetail)}</b>\n` +
    `💰 <b>Giá hiện tại:</b> <code>${priceFormatted}</code>\n` +
    `⏰ <b>Thời gian:</b> ${timeStr}\n\n` +
    `🔗 <a href="${item.url}"><b>XEM NGAY TRÊN SHOPEE</b></a>\n` +
    `🌐 <code>${item.url}</code>`;

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
        addLog('success', `Đã bắn thông báo Telegram cập nhật SP: ${item.name}`);
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
      addLog('success', `Đã bắn thông báo Telegram cập nhật SP: ${item.name}`);
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

// 9. Sync to VPS Server
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

// 10. Real-time Handler for Seller Centre DOM update (if open on same profile)
async function handleSellerCentreSync(liveTotal, products) {
  try {
    const data = await chrome.storage.local.get(null);
    const shop = (data.shops || []).find((s) => s.id === 1) || data.shops?.[0];
    if (!shop) return;

    const lastCount = shop.last_item_count || 0;
    const seenSet = new Set(data.seenItems || []);
    const knownProducts = data.knownProducts || {};
    const newProductsFound = [];

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

      if (!seenSet.has(p.itemId)) {
        seenSet.add(p.itemId);
        newProductsFound.push(p);
      }
    }

    if (newProductsFound.length > 0) {
      addLog('alert', `⚡ [Kênh Người Bán] Phát hiện ${newProductsFound.length} sản phẩm mới!`);
      for (const np of newProductsFound) {
        await sendTelegramAlert(data.teleToken, data.teleChatId, shop.shop_name, np);
        showDesktopNotification(shop.shop_name, np);
      }

      const todayCount = (data.newProductsToday || 0) + newProductsFound.length;
      const updatedShops = (data.shops || []).map((s) =>
        s.id === shop.id ? { ...s, last_item_count: liveTotal } : s
      );

      await chrome.storage.local.set({
        shops: updatedShops,
        seenItems: Array.from(seenSet),
        knownProducts,
        newProductsToday: todayCount
      });
    }
  } catch (err) {
    console.warn('Seller Centre sync error:', err);
  }
}

// 11. Message Listener from Popup & Content Scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'shopee_buyer_tab_ready') {
    addLog('info', '🌐 Đã kết nối phiên người mua Shopee từ tab trình duyệt.');
    sendResponse({ success: true });
    return true;
  }
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
        shopId: '1368956675',
        name: 'Kẹp Tóc Càng Cua Nữ – Nhựa Cao Cấp Phong Cách Hàn Quốc (Test)',
        price: 29000,
        url: 'https://shopee.vn/product/1368956675/56418741612',
        imageUrl: 'https://down-vn.img.susercontent.com/file/vn-11134207-81ztc-mtwidlde8wed3c'
      }
    ).then(() => sendResponse({ success: true }));
    return true;
  }
});

// Start fast runner loop
startFastLoop();
