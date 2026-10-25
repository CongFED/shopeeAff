/**
 * Shopee Realtime Monitor - Content Script
 * 100% CSP Compliant (No inline scripts injected into web page)
 * Safely extracts products from both Seller Centre and Buyer Portal DOM.
 */

console.log('[Shopee Monitor] Content script loaded on:', window.location.href);

let lastReportedCount = null;
let lastProductsHash = '';

function scanCurrentPage() {
  try {
    let activeCount = null;
    const tabElements = document.querySelectorAll('div, span, a, button, p, h1, h2, h3');

    // 1. Detect total product count from tabs or badges
    for (const el of tabElements) {
      const text = (el.textContent || '').trim();
      // Matches: "Đang hoạt động (17)", "Đang hoạt động 17", "Tất cả (17)", "TẤT CẢ SẢN PHẨM (17)"
      const m = text.match(/(?:Đang\s*hoạt\s*động|Còn\s*hàng|Tất\s*cả|TẤT\s*CẢ\s*SẢN\s*PHẨM)[^\d]*(\d+)/i);
      if (m) {
        activeCount = parseInt(m[1], 10);
        break;
      }
    }

    if (activeCount === null) {
      for (const el of tabElements) {
        const text = (el.textContent || '').trim();
        const m = text.match(/^(\d+)\s+sản\s+phẩm$/i);
        if (m && el.children.length === 0) {
          activeCount = parseInt(m[1], 10);
          break;
        }
      }
    }

    // 2. Extract DOM Product Cards (Both Seller Centre and Buyer Shop Page)
    const collectedProducts = new Map();

    // 2.1. Seller Centre Table Row Extractor (banhang.shopee.vn)
    const isSellerCenter = window.location.hostname.includes('banhang.shopee.vn') || window.location.hostname.includes('seller.shopee.vn');
    if (isSellerCenter) {
      const rowElements = document.querySelectorAll('tr, [role="row"], .shopee-table__row, [class*="product-row"], [class*="item-row"]');
      for (const row of rowElements) {
        const rowText = row.innerText || '';
        const idMatch = rowText.match(/(?:ID\s*Sản\s*phẩm|Mã\s*SP|ID):\s*(\d+)/i);
        if (idMatch) {
          const itemId = idMatch[1];
          if (!collectedProducts.has(itemId)) {
            // Price: match ₫... or ...₫
            const priceMatch = rowText.match(/₫\s*([\d.,]+)|([\d.,]+)\s*₫/);
            const price = priceMatch ? parseInt((priceMatch[1] || priceMatch[2]).replace(/[.,]/g, ''), 10) : 0;

            // Product Name: extract lines from rowText before "SKU" or "ID"
            const lines = rowText.split('\n').map(l => l.trim()).filter(Boolean);
            let name = '';
            for (const line of lines) {
              if (
                line.length > 3 &&
                !line.includes('ID Sản phẩm') &&
                !line.includes('SKU') &&
                !line.includes('Model ID') &&
                !line.includes('₫') &&
                !line.includes('Doanh số') &&
                !line.includes('Kho hàng') &&
                !line.includes('Cập nhật') &&
                !line.includes('Thao tác') &&
                !line.includes('Lưu Lượng') &&
                !line.includes('Xem thêm') &&
                !line.includes('Đẩy') &&
                !line.includes('Hết hàng')
              ) {
                name = line;
                break;
              }
            }

            const imgEl = row.querySelector('img');
            const imageUrl = imgEl ? imgEl.src : undefined;

            if (name && itemId) {
              collectedProducts.set(itemId, {
                itemId,
                name,
                price,
                imageUrl,
                url: `https://shopee.vn/product/1368956675/${itemId}`
              });
            }
          }
        }
      }
    }

    // 2.2. Buyer Portal Links Extractor (shopee.vn/shop/...)
    const links = document.querySelectorAll('a[href*="/product/"]');
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/product\/(?:edit\/)?(?:\d+\/)?(\d+)/);
      if (m) {
        const itemId = m[1];
        if (!collectedProducts.has(itemId)) {
          const container = a.closest('tr, [class*="item"], [class*="row"], [class*="card"], [data-sqe="item"]');
          let name = '';
          let price = 0;
          let imageUrl = undefined;

          if (container) {
            const text = container.innerText || '';
            const priceMatch = text.match(/₫\s*([\d.,]+)|([\d.,]+)\s*₫/);
            price = priceMatch ? parseInt((priceMatch[1] || priceMatch[2]).replace(/[.,]/g, ''), 10) : 0;
            const imgEl = container.querySelector('img');
            if (imgEl && imgEl.src) imageUrl = imgEl.src;
            const nameEl = container.querySelector('[data-sqe="name"], [class*="name"], [class*="title"], h3, h4');
            name = (nameEl ? nameEl.textContent : a.textContent).trim();
          } else {
            name = a.textContent.trim();
          }

          if (name.length > 3 && !name.includes('ID') && !name.includes('₫') && !name.includes('Cập nhật')) {
            collectedProducts.set(itemId, {
              itemId,
              name,
              price,
              imageUrl,
              url: `https://shopee.vn/product/1368956675/${itemId}`
            });
          }
        }
      }
    }

    const products = Array.from(collectedProducts.values());
    const total = activeCount !== null ? activeCount : products.length;
    const currentHash = `${total}_${products.map((p) => `${p.itemId}:${p.price}`).join('|')}`;

    if (total > 0 && (currentHash !== lastProductsHash || total !== lastReportedCount)) {
      lastReportedCount = total;
      lastProductsHash = currentHash;

      console.log('[Shopee Monitor] DOM update detected:', { total, productsCount: products.length });

      chrome.runtime.sendMessage({
        action: 'seller_centre_detected',
        totalCount: total,
        products: products
      }).catch(() => {});
    }
  } catch (err) {
    console.warn('[Shopee Monitor] Scan error:', err);
  }
}

// Run scanner safely on page load and every 2.5 seconds
scanCurrentPage();
setInterval(scanCurrentPage, 2500);

if (document.body) {
  const observer = new MutationObserver(() => scanCurrentPage());
  observer.observe(document.body, { childList: true, subtree: true });
}

// 3. Same-Origin API Proxy for Background Scanner
// Executes requests directly inside the buyer tab to bypass anti-bot WAF (90309999)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'fetch_shopee_api') {
    fetch(msg.url, {
      method: msg.method || 'GET',
      credentials: 'include',
      headers: {
        'x-api-source': 'pc',
        'x-requested-with': 'XMLHttpRequest',
        'x-shopee-language': 'vi',
        'referer': msg.referer || window.location.href,
        ...(msg.headers || {})
      },
      body: msg.body ? JSON.stringify(msg.body) : undefined
    })
      .then(async (r) => {
        try {
          const data = await r.json();
          sendResponse({ success: true, status: r.status, data });
        } catch (e) {
          sendResponse({ success: false, status: r.status, error: 'JSON parse error' });
        }
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep message channel open for async response
  }

  if (msg.action === 'ping_buyer_tab') {
    sendResponse({ success: true, url: window.location.href, isBuyerTab: !window.location.hostname.includes('banhang.') });
    return true;
  }
});

// Announce tab readiness to background service worker
try {
  chrome.runtime.sendMessage({
    action: 'shopee_buyer_tab_ready',
    url: window.location.href,
    isBuyerTab: !window.location.hostname.includes('banhang.')
  }).catch(() => {});
} catch (e) {}

