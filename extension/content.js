/**
 * Shopee Realtime Monitor - Content Script
 * Injected into banhang.shopee.vn (Seller Centre) and shopee.vn (Buyer Portal)
 * Enables 0-second instant detection when seller creates or updates products!
 */

console.log('[Shopee Monitor] Content script loaded on:', window.location.href);

// ==========================================
// 1. SELLER CENTRE (banhang.shopee.vn) MONITOR
// ==========================================
if (window.location.hostname.includes('banhang.shopee.vn')) {
  let lastReportedCount = null;
  let lastProductsHash = '';
  const interceptedProducts = new Map();

  // Inject network hook into the page context to intercept Seller Centre API responses
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
              if (url.includes('/product/') || url.includes('get_product_list') || url.includes('/mps/')) {
                const clone = res.clone();
                clone.json().then(data => {
                  const list = data?.data?.products || data?.data?.list || data?.products || [];
                  if (Array.isArray(list) && list.length > 0) {
                    window.postMessage({ type: 'SHOPEE_SELLER_PRODUCTS_INTERCEPTED', data: list }, '*');
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
                if (url.includes('/product/') || url.includes('get_product_list') || url.includes('/mps/')) {
                  const data = JSON.parse(this.responseText);
                  const list = data?.data?.products || data?.data?.list || data?.products || [];
                  if (Array.isArray(list) && list.length > 0) {
                    window.postMessage({ type: 'SHOPEE_SELLER_PRODUCTS_INTERCEPTED', data: list }, '*');
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
      console.warn('[Shopee Monitor] Could not inject network hook:', e);
    }
  }

  injectNetworkHook();

  // Listen to network hook messages
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SHOPEE_SELLER_PRODUCTS_INTERCEPTED') {
      const list = event.data.data;
      for (const p of list) {
        const itemId = String(p.id || p.item_id || p.itemId);
        if (itemId) {
          const priceNum = parseFloat(
            p.price_detail?.selling_price_min ||
            p.price_detail?.price_min ||
            p.price ||
            p.selling_price ||
            0
          );
          const imageId = p.cover_image || p.image || p.images?.[0];
          interceptedProducts.set(itemId, {
            itemId,
            name: p.name || 'Sản phẩm mới',
            price: priceNum > 0 ? priceNum : 0,
            imageUrl: imageId ? (imageId.startsWith('http') ? imageId : `https://down-vn.img.susercontent.com/file/${imageId}`) : undefined,
            url: `https://shopee.vn/product/1368956675/${itemId}`
          });
        }
      }
      scanSellerCentre();
    }
  });

  function scanSellerCentre() {
    try {
      // 1. Detect total active product count
      let activeCount = null;
      const tabElements = document.querySelectorAll('div, span, a, button, p');

      for (const el of tabElements) {
        const text = (el.textContent || '').trim();
        // Matches "Đang hoạt động (17)", "Đang hoạt động 17", "Tất cả (17)"
        const m = text.match(/(?:Đang\s*hoạt\s*động|Còn\s*hàng|Tất\s*cả)[^\d]*(\d+)/i);
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

      // 2. Extract product cards from table / DOM
      const productsMap = new Map(interceptedProducts);

      // Check edit links e.g. /portal/product/edit/123456 or /portal/product/123456
      const links = document.querySelectorAll('a[href*="/product/"]');
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/product\/(?:edit\/)?(\d+)/);
        if (m) {
          const itemId = m[1];
          if (!productsMap.has(itemId)) {
            // Find enclosing container
            let container = a.closest('tr, [class*="row"], [class*="item"], [class*="card"]');
            if (container) {
              const text = container.innerText || '';
              const priceMatch = text.match(/₫\s*([\d.,]+)|([\d.,]+)\s*₫/);
              const price = priceMatch ? parseInt((priceMatch[1] || priceMatch[2]).replace(/[.,]/g, ''), 10) : 0;
              const imgEl = container.querySelector('img');
              const name = a.textContent.trim() || 'Sản phẩm mới';

              productsMap.set(itemId, {
                itemId,
                name: name.length > 5 ? name : 'Sản phẩm Shopee',
                price,
                imageUrl: imgEl ? imgEl.src : undefined,
                url: `https://shopee.vn/product/1368956675/${itemId}`
              });
            }
          }
        }
      }

      // Fallback: search body text for product IDs
      const idMatches = document.body.innerText.matchAll(/(?:ID\s*Sản\s*phẩm|Mã\s*sản\s*phẩm|Mã\s*SP|ID):\s*(\d+)/gi);
      for (const match of idMatches) {
        const itemId = match[1];
        if (!productsMap.has(itemId)) {
          let targetEl = null;
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            if (node.nodeValue && node.nodeValue.includes(itemId)) {
              targetEl = node.parentElement;
              break;
            }
          }

          let rowEl = targetEl;
          for (let i = 0; i < 8 && rowEl; i++) {
            if (
              rowEl.tagName === 'TR' ||
              (rowEl.className && typeof rowEl.className === 'string' && (rowEl.className.includes('row') || rowEl.className.includes('item') || rowEl.className.includes('product')))
            ) {
              break;
            }
            rowEl = rowEl.parentElement;
          }

          if (rowEl) {
            const rowText = rowEl.innerText || '';
            const priceMatch = rowText.match(/₫\s*([\d.,]+)|([\d.,]+)\s*₫/);
            const price = priceMatch ? parseInt((priceMatch[1] || priceMatch[2]).replace(/[.,]/g, ''), 10) : 0;
            const imgEl = rowEl.querySelector('img');

            const nameLinks = rowEl.querySelectorAll('a, [class*="name"], [class*="title"], h3, h4');
            let name = '';
            for (const l of nameLinks) {
              const txt = l.textContent.trim();
              if (txt && !txt.includes('ID') && !txt.includes('₫') && txt.length > 5) {
                name = txt;
                break;
              }
            }

            productsMap.set(itemId, {
              itemId,
              name: name || 'Sản phẩm Seller',
              price,
              imageUrl: imgEl ? imgEl.src : undefined,
              url: `https://shopee.vn/product/1368956675/${itemId}`
            });
          }
        }
      }

      const products = Array.from(productsMap.values());
      const total = activeCount !== null ? activeCount : products.length;
      const currentHash = `${total}_${products.map((p) => `${p.itemId}:${p.price}`).join('|')}`;

      if (total > 0 && (currentHash !== lastProductsHash || total !== lastReportedCount)) {
        lastReportedCount = total;
        lastProductsHash = currentHash;

        console.log('[Shopee Monitor] Seller Centre live update:', { total, productsCount: products.length });

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

  // Scan immediately and poll every 2s
  scanSellerCentre();
  setInterval(scanSellerCentre, 2000);

  const observer = new MutationObserver(() => {
    scanSellerCentre();
  });
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }
}
