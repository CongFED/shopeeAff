/**
 * Shopee Realtime Monitor - Content Script
 * Injected into banhang.shopee.vn (Seller Centre) and shopee.vn (Buyer Portal)
 * Enables 0-second instant detection when seller creates or updates products!
 */

console.log('[Shopee Monitor] Content script loaded on:', window.location.href);

const isSellerCentre = window.location.hostname.includes('banhang.shopee.vn') || window.location.hostname.includes('seller.shopee.vn');
const isBuyerPortal = window.location.hostname.includes('shopee.vn') && !isSellerCentre;

// ==========================================
// 1. IN-PAGE NETWORK INTERCEPTOR (Both Portals)
// ==========================================
function injectNetworkHook() {
  try {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        const origFetch = window.fetch;
        window.fetch = async function(...args) {
          const res = await origFetch.apply(this, args);
          try {
            const url = (args[0] && args[0].url) || (typeof args[0] === 'string' ? args[0] : '');
            if (
              url.includes('/product/') ||
              url.includes('get_product_list') ||
              url.includes('rcmd_items') ||
              url.includes('search_items') ||
              url.includes('get_shop_base') ||
              url.includes('/mps/')
            ) {
              const clone = res.clone();
              clone.json().then(data => {
                const list = data?.data?.products ||
                             data?.data?.items ||
                             data?.data?.list ||
                             data?.data?.product_list ||
                             data?.items ||
                             data?.products ||
                             (data?.data?.id ? [data.data] : []);
                if (Array.isArray(list) && list.length > 0) {
                  window.postMessage({ type: 'SHOPEE_PRODUCTS_INTERCEPTED', data: list }, '*');
                }
              }).catch(() => {});
            }
          } catch (e) {}
          return res;
        };

        const origXhrOpen = XMLHttpRequest.prototype.open;
        const origXhrSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
          this._shopeeUrl = url;
          return origXhrOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function() {
          this.addEventListener('load', function() {
            try {
              const url = this._shopeeUrl || '';
              if (
                url.includes('/product/') ||
                url.includes('get_product_list') ||
                url.includes('rcmd_items') ||
                url.includes('search_items') ||
                url.includes('get_shop_base') ||
                url.includes('/mps/')
              ) {
                const data = JSON.parse(this.responseText);
                const list = data?.data?.products ||
                             data?.data?.items ||
                             data?.data?.list ||
                             data?.data?.product_list ||
                             data?.items ||
                             data?.products ||
                             (data?.data?.id ? [data.data] : []);
                if (Array.isArray(list) && list.length > 0) {
                  window.postMessage({ type: 'SHOPEE_PRODUCTS_INTERCEPTED', data: list }, '*');
                }
              }
            } catch (e) {}
          });
          return origXhrSend.apply(this, arguments);
        };
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  } catch (e) {
    console.warn('[Shopee Monitor] Network hook error:', e);
  }
}

injectNetworkHook();

// Global product collector
let lastReportedCount = null;
let lastProductsHash = '';
const collectedProducts = new Map();

window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SHOPEE_PRODUCTS_INTERCEPTED') {
    const list = event.data.data;
    for (const raw of list) {
      const it = raw.item_basic || raw;
      const itemId = String(it.itemid || it.id || it.item_id || it.itemId || '');
      if (itemId) {
        let price = it.price || it.price_min || it.selling_price || 0;
        if (typeof price === 'string') price = parseFloat(price.replace(/[^\d.]/g, '')) || 0;
        if (price > 10000000) price = Math.round(price / 100000);

        const imageId = it.image || it.cover_image || it.images?.[0];
        const imageUrl = imageId
          ? (imageId.startsWith('http') ? imageId : `https://down-vn.img.susercontent.com/file/${imageId}`)
          : undefined;

        const shopId = String(it.shopid || it.shop_id || '1368956675');

        collectedProducts.set(itemId, {
          itemId,
          name: it.name || 'Sản phẩm mới',
          price,
          imageUrl,
          url: `https://shopee.vn/product/${shopId}/${itemId}`
        });
      }
    }
    scanCurrentPage();
  }
});

// ==========================================
// 2. DOM SCANNER (Dual Portal Support)
// ==========================================
function scanCurrentPage() {
  try {
    let activeCount = null;
    const tabElements = document.querySelectorAll('div, span, a, button, p');

    // 1. Check tab header for total active product count
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
        const m = text.match(/(\d+)\s+sản\s+phẩm/i);
        if (m && el.children.length === 0) {
          activeCount = parseInt(m[1], 10);
          break;
        }
      }
    }

    // 2. Extract DOM Product Cards (Both Seller Centre and Buyer Portal)
    const links = document.querySelectorAll('a[href*="/product/"]');
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      // Matches /product/1368956675/56418741612 or /product/edit/56418741612
      const m = href.match(/\/product\/(?:edit\/)?(?:\d+\/)?(\d+)/);
      if (m) {
        const itemId = m[1];
        if (!collectedProducts.has(itemId)) {
          const container = a.closest('tr, [class*="item"], [class*="row"], [class*="card"], [data-sqe="item"]');
          if (container) {
            const text = container.innerText || '';
            const priceMatch = text.match(/₫\s*([\d.,]+)|([\d.,]+)\s*₫/);
            const price = priceMatch ? parseInt((priceMatch[1] || priceMatch[2]).replace(/[.,]/g, ''), 10) : 0;
            const imgEl = container.querySelector('img');
            const nameEl = container.querySelector('[data-sqe="name"], [class*="name"], [class*="title"], h3, h4');
            const name = (nameEl ? nameEl.textContent : a.textContent).trim();

            collectedProducts.set(itemId, {
              itemId,
              name: name.length > 3 ? name : 'Sản phẩm Shopee',
              price,
              imageUrl: imgEl ? imgEl.src : undefined,
              url: `https://shopee.vn/product/1368956675/${itemId}`
            });
          }
        }
      }
    }

    // Fallback: check "ID Sản phẩm: 123456" in body text
    const idMatches = document.body.innerText.matchAll(/(?:ID\s*Sản\s*phẩm|Mã\s*sản\s*phẩm|Mã\s*SP|ID):\s*(\d+)/gi);
    for (const match of idMatches) {
      const itemId = match[1];
      if (!collectedProducts.has(itemId)) {
        collectedProducts.set(itemId, {
          itemId,
          name: 'Sản phẩm mới (Kênh Người Bán)',
          price: 0,
          url: `https://shopee.vn/product/1368956675/${itemId}`
        });
      }
    }

    const products = Array.from(collectedProducts.values());
    const total = activeCount !== null ? activeCount : products.length;
    const currentHash = `${total}_${products.map((p) => `${p.itemId}:${p.price}`).join('|')}`;

    if (total > 0 && (currentHash !== lastProductsHash || total !== lastReportedCount)) {
      lastReportedCount = total;
      lastProductsHash = currentHash;

      console.log('[Shopee Monitor] Browser live update captured:', { total, productsCount: products.length });

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

// Start continuous polling and observer
scanCurrentPage();
setInterval(scanCurrentPage, 2000);

if (document.body) {
  const observer = new MutationObserver(() => scanCurrentPage());
  observer.observe(document.body, { childList: true, subtree: true });
}
