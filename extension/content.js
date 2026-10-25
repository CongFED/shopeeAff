/**
 * Shopee Realtime Monitor - Content Script
 * Injected into banhang.shopee.vn (Seller Centre) and shopee.vn (Buyer Portal)
 * Enables 0-second detection when seller adds or updates products in Seller Centre!
 */

console.log('[Shopee Monitor] Content script loaded on:', window.location.href);

// ==========================================
// 1. SELLER CENTRE (banhang.shopee.vn) MONITOR
// ==========================================
if (window.location.hostname.includes('banhang.shopee.vn')) {
  let lastReportedCount = null;
  let lastProductsHash = '';

  function scanSellerCentre() {
    try {
      // 1. Detect total active product count
      let activeCount = null;

      // Check tab header e.g. "Đang hoạt động (17)"
      const tabElements = document.querySelectorAll('div, span, a, button, p');
      for (const el of tabElements) {
        const text = el.textContent || '';
        const m = text.match(/Đang hoạt động\s*\(\s*(\d+)\s*\)/i);
        if (m) {
          activeCount = parseInt(m[1], 10);
          break;
        }
      }

      // Fallback: search for "17 Sản phẩm"
      if (activeCount === null) {
        for (const el of tabElements) {
          const text = el.textContent || '';
          const m = text.match(/(\d+)\s+Sản\s+phẩm/i);
          if (m && el.children.length === 0) {
            activeCount = parseInt(m[1], 10);
            break;
          }
        }
      }

      // 2. Extract product cards from table
      const products = [];
      const idMatches = document.body.innerText.matchAll(/ID\s*Sản\s*phẩm:\s*(\d+)/gi);
      const seenIds = new Set();

      for (const match of idMatches) {
        const itemId = match[1];
        if (seenIds.has(itemId)) continue;
        seenIds.add(itemId);

        // Find enclosing container
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
          const priceMatch = rowText.match(/₫\s*([\d.,]+)/);
          let price = priceMatch ? parseInt(priceMatch[1].replace(/[.,]/g, ''), 10) : 0;

          // Find product name
          let name = '';
          const links = rowEl.querySelectorAll('a, [class*="name"], [class*="title"], h3, h4');
          for (const l of links) {
            const txt = l.textContent.trim();
            if (txt && !txt.includes('ID Sản phẩm') && !txt.includes('₫') && txt.length > 5) {
              name = txt;
              break;
            }
          }
          if (!name) {
            const lines = rowText.split('\n').map((s) => s.trim()).filter((s) => s.length > 5 && !s.includes('ID Sản phẩm') && !s.includes('₫'));
            name = lines[0] || 'Sản phẩm Seller';
          }

          const imgEl = rowEl.querySelector('img');
          const imageUrl = imgEl ? imgEl.src : undefined;

          products.push({
            itemId,
            name,
            price,
            imageUrl,
            url: `https://shopee.vn/product/1368956675/${itemId}`
          });
        }
      }

      const currentHash = `${activeCount || 0}_${products.map((p) => `${p.itemId}:${p.price}`).join('|')}`;

      if (activeCount !== null && (currentHash !== lastProductsHash || activeCount !== lastReportedCount)) {
        lastReportedCount = activeCount;
        lastProductsHash = currentHash;

        console.log('[Shopee Monitor] Seller Centre detected:', { activeCount, productsCount: products.length });

        chrome.runtime.sendMessage({
          action: 'seller_centre_detected',
          totalCount: activeCount,
          products: products
        }).catch(() => {});
      }
    } catch (err) {
      console.warn('[Shopee Monitor] Scan error:', err);
    }
  }

  // Scan immediately on page load, then poll every 2.5s
  scanSellerCentre();
  setInterval(scanSellerCentre, 2500);

  // Also trigger scan on DOM mutations
  const observer = new MutationObserver(() => {
    scanSellerCentre();
  });
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }
}
