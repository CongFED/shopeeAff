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
  logs: []
};

// Initialize Storage on install
chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(null);
  const initial = { ...DEFAULT_SETTINGS, ...data };
  await chrome.storage.local.set(initial);
  addLog('success', 'Extension đã được cài đặt và kích hoạt thành công!');
  setupAlarm(initial.intervalSeconds);
});

// Setup Alarm and Polling Loop
function setupAlarm(intervalSec) {
  chrome.alarms.clear('shopee_scan_alarm');
  // Chrome alarms have 1 min min resolution, but we also use setTimeout loop while active
  chrome.alarms.create('shopee_scan_alarm', {
    periodInMinutes: Math.max(1, Math.round(intervalSec / 60))
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'shopee_scan_alarm') {
    runScanCycle();
  }
});

// High-speed runner loop (10s interval support)
let isLoopRunning = false;
async function startFastLoop() {
  if (isLoopRunning) return;
  isLoopRunning = true;
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
async function runScanCycle() {
  if (isScanning) return;
  isScanning = true;

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

    // Step 1: Ultra-fast base check (returns item_count)
    const baseRes = await fetch(`https://shopee.vn/api/v4/shop/get_shop_base_v2?shopid=${numericShopId}`, {
      headers: {
        'x-api-source': 'pc',
        'x-requested-with': 'XMLHttpRequest',
        'x-shopee-language': 'vi'
      }
    });

    if (!baseRes.ok) {
      addLog('warn', `Shop ${shop.shop_name} phản hồi HTTP ${baseRes.status}`);
      return;
    }

    const baseData = await baseRes.json();
    const liveItemCount = baseData.data?.item_count || 0;
    const lastItemCount = shop.last_item_count;

    // If item count increased OR first check -> Fetch products!
    const isFirstRun = lastItemCount === undefined || lastItemCount === null;
    const hasNewItems = liveItemCount > (lastItemCount || 0);

    if (hasNewItems || isFirstRun) {
      addLog('info', `[${shop.shop_name}] Phát hiện số lượng thay đổi: ${lastItemCount || 0} ➔ ${liveItemCount} SP. Đang lấy chi tiết...`);

      // Fetch products using rcmd_items & get_shop_seo
      const products = await fetchShopProducts(numericShopId, shop.shop_url);
      const seenSet = new Set(state.seenItems || []);

      const newProductsFound = [];

      for (const p of products) {
        if (!seenSet.has(p.itemId)) {
          seenSet.add(p.itemId);
          newProductsFound.push(p);
        }
      }

      // Update state
      const updatedShops = state.shops.map((s) =>
        s.id === shop.id ? { ...s, shop_id: numericShopId, last_item_count: liveItemCount } : s
      );

      await chrome.storage.local.set({
        shops: updatedShops,
        seenItems: Array.from(seenSet)
      });

      if (isFirstRun) {
        addLog('info', `[${shop.shop_name}] Đã đồng bộ mốc ban đầu: ${products.length} sản phẩm.`);
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

  // 1. rcmd_items (Main category tab)
  try {
    const r = await fetch(
      `https://shopee.vn/api/v4/shop/rcmd_items?bundle=shop_page_category_tab_main&limit=30&offset=0&shop_id=${shopId}`,
      {
        headers: {
          'x-api-source': 'pc',
          'x-requested-with': 'XMLHttpRequest',
          'x-shopee-language': 'vi'
        }
      }
    );
    const data = await r.json();
    const list = data.data?.items || data.items || [];
    for (const it of list) {
      const item = it.item_basic || it;
      if (item && item.itemid && !seen.has(String(item.itemid))) {
        seen.add(String(item.itemid));
        let price = item.price || item.price_min || 0;
        if (price > 1000000) price = Math.round(price / 100000);
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
  } catch (e) {}

  // 2. get_shop_seo (Featured items)
  try {
    const r = await fetch(`https://shopee.vn/api/v4/shop/get_shop_seo?shopid=${shopId}`, {
      headers: {
        'x-api-source': 'pc',
        'x-requested-with': 'XMLHttpRequest',
        'x-shopee-language': 'vi'
      }
    });
    const data = await r.json();
    const list = data.data?.items || [];
    for (const it of list) {
      const item = it.item_basic || it;
      if (item && item.itemid && !seen.has(String(item.itemid))) {
        seen.add(String(item.itemid));
        let price = item.price || item.price_min || 0;
        if (price > 1000000) price = Math.round(price / 100000);
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

// Message Listener from Popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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

// Start fast runner loop
startFastLoop();
