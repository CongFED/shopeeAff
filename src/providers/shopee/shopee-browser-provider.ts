import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page } from 'puppeteer-core';
import fs from 'node:fs';
import { IShopeeProvider, ShopResolveResult, ProductItem, FetchProductsOptions } from '../types.js';
import { parseShopTarget } from '../../utils/url.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/time.js';

// Apply Stealth plugin to defeat Shopee Anti-Bot WAF (90309999)
(puppeteer as any).use(StealthPlugin());

export class ShopeeBrowserProvider implements IShopeeProvider {
  readonly name = 'ShopeeBrowserProvider';

  private cookieString?: string;
  private userAgent?: string;
  private chromePath: string;
  private browser: any | null = null;
  private activePage: any | null = null;
  private sellerApiUrl: string | null = null;
  private shopUrlCache = new Map<string, string>();

  private isSellerCentreAvailable: boolean = true;

  constructor(cookieString?: string, userAgent?: string, chromePath?: string) {
    this.cookieString = cookieString;
    this.userAgent = userAgent;
    this.chromePath = chromePath || this.detectChromePath();
  }

  updateCredentials(cookieString?: string, userAgent?: string): void {
    this.cookieString = cookieString;
    if (userAgent) {
      this.userAgent = userAgent;
    }
    this.sellerApiUrl = null;
    this.isSellerCentreAvailable = true;
    if (this.browser) {
      this.close().catch(() => {});
    }
    logger.info('ShopeeBrowserProvider credentials updated.');
  }

  private detectChromePath(): string {
    const candidates = [
      process.env.CHROME_PATH,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ].filter(Boolean) as string[];

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }

  private parseCookies(): Array<{ name: string; value: string; domain: string; path: string }> {
    if (!this.cookieString) return [];
    return this.cookieString
      .split(';')
      .map((part) => {
        const [name, ...val] = part.trim().split('=');
        return {
          name,
          value: val.join('='),
          domain: '.shopee.vn',
          path: '/',
        };
      })
      .filter((c) => c.name && c.value);
  }

  private async ensureBrowser(): Promise<any> {
    if (this.browser && this.browser.connected) {
      return this.browser;
    }

    logger.info(`Starting Stealth Chrome (${this.chromePath})...`);
    this.browser = await (puppeteer as any).launch({
      executablePath: this.chromePath,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1440,900',
        '--lang=vi-VN,vi',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    return this.browser;
  }

  private async createPage(): Promise<any> {
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    await page.setUserAgent(
      this.userAgent ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    const cookies = this.parseCookies();
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
    }

    return page;
  }

  async resolveShop(urlOrIdentifier: string): Promise<ShopResolveResult> {
    const parsed = parseShopTarget(urlOrIdentifier);

    if (parsed.shopId) {
      this.shopUrlCache.set(parsed.shopId, parsed.normalizedUrl);
      return {
        shopId: parsed.shopId,
        shopName: `Shop ${parsed.shopId}`,
        shopUrl: parsed.normalizedUrl,
      };
    }

    const page = await this.createPage();
    try {
      logger.info(`Browser resolving shop URL: ${parsed.normalizedUrl}`);

      await page.goto(parsed.normalizedUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });

      // Extract shopid and shop name from page context
      const shopInfo = await page.evaluate(() => {
        const title = document.title || '';
        // Look for shopid in window state or scripts
        const html = document.documentElement.innerHTML;
        const m = html.match(/"shopid":\s*(\d+)/i) || html.match(/"shop_id":\s*(\d+)/i);
        return {
          title,
          shopId: m ? m[1] : null,
        };
      });

      const finalShopId = shopInfo.shopId || (parsed.shopId as string);
      if (!finalShopId) {
        throw new Error(`Could not resolve shopId for URL "${urlOrIdentifier}" via browser`);
      }

      this.shopUrlCache.set(finalShopId, parsed.normalizedUrl);

      return {
        shopId: finalShopId,
        shopName: parsed.username || shopInfo.title || `Shop ${finalShopId}`,
        shopUrl: parsed.normalizedUrl,
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async getShopProducts(shopId: string, options: FetchProductsOptions = {}): Promise<ProductItem[]> {
    const page = await this.createPage();
    try {

    // Strategy 1: Seller Centre API query (Only for shop owner accounts with SPC_SC_SESSION)
    if (this.isSellerCentreAvailable && this.cookieString && this.cookieString.includes('SPC_SC_SESSION')) {
      try {
        let sellerProducts: any[] = [];

        // Fast path: In-page fetch using existing session & captured SPC_CDS url (<150ms)
        if (this.sellerApiUrl) {
          try {
            const data: any = await page.evaluate(async (url: string) => {
              const fetchUrl = url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now();
              const res = await fetch(fetchUrl, { cache: 'no-store' });
              return await res.json();
            }, this.sellerApiUrl);

            if (data?.code === 0 && Array.isArray(data?.data?.products)) {
              sellerProducts = data.data.products;
            }
          } catch (e: any) {
            logger.debug(`In-page fast fetch failed: ${e.message}`);
          }
        }

        // Quick fallback: Reload once if sellerApiUrl not yet captured
        if (sellerProducts.length === 0 && !this.sellerApiUrl) {
          const onResponse = async (res: any) => {
            const u = res.url();
            if (/\/get_product_list(\?|$)/.test(u) && res.status() === 200) {
              try {
                const json = await res.json();
                if (Array.isArray(json.data?.products)) {
                  sellerProducts = json.data.products;
                }
              } catch {}
            }
          };

          page.on('response', onResponse);
          await page.goto('https://banhang.shopee.vn/portal/product/list/all', {
            waitUntil: 'domcontentloaded',
            timeout: 10000,
          });
          page.off('response', onResponse);

          if (page.url().includes('vn-onboarding')) {
            this.isSellerCentreAvailable = false;
          }
        }

        if (sellerProducts.length > 0) {
          const items: ProductItem[] = [];
          for (const p of sellerProducts) {
            const itemId = String(p.id);
            const name = p.name || 'Sản phẩm mới';
            const priceNum = parseFloat(p.price_detail?.selling_price_min || p.price_detail?.price_min || '0');
            const imageId = p.cover_image;
            const imageUrl = imageId ? `https://down-vn.img.susercontent.com/file/${imageId}` : undefined;
            const url = `https://shopee.vn/product/${shopId}/${itemId}`;

            items.push({
              itemId,
              shopId,
              name,
              url,
              price: priceNum > 0 ? priceNum : undefined,
              imageUrl,
              ctime: p.create_time || Math.floor(Date.now() / 1000),
            });
          }
          return items;
        } else {
          // If sellerProducts is 0, don't keep checking Seller Centre in subsequent cycles
          this.isSellerCentreAvailable = false;
        }
      } catch (err: any) {
        logger.debug(`Seller Centre product fetch fallback: ${err.message}`);
        this.isSellerCentreAvailable = false;
      }
    }



    // Strategy 2: Buyer shop page navigation & API / DOM extraction (Works with any normal buyer account)
    let targetUrl: string;
    if (shopId.startsWith('http') || shopId.includes('shopee.vn')) {
      targetUrl = shopId;
    } else if (this.shopUrlCache.has(shopId)) {
      targetUrl = this.shopUrlCache.get(shopId)!;
    } else {
      targetUrl = `https://shopee.vn/shop/${shopId}`;
    }

    logger.info(`Browser scraping shop products: ${targetUrl}`);

    const buyerItems: ProductItem[] = [];
    const seenItemIds = new Set<string>();

    const onBuyerResponse = async (res: any) => {
      const u = res.url();
      if (
        (u.includes('get_shop_seo') || u.includes('search_items') || u.includes('rcmd_items') || u.includes('get_shop_tab')) &&
        res.status() === 200
      ) {
        try {
          const json = await res.json();
          const rawItems = json.items || json.data?.items || json.data?.sections?.[0]?.data?.item || [];
          if (Array.isArray(rawItems)) {
            for (const it of rawItems) {
              const basic = it.item_basic || it;
              if (!basic || !basic.itemid) continue;
              const itemId = String(basic.itemid);
              if (seenItemIds.has(itemId)) continue;
              seenItemIds.add(itemId);

              const name = basic.name || 'Sản phẩm mới';
              let priceNum = parseFloat(String(basic.price || 0));
              if (priceNum > 10000000) {
                priceNum = priceNum / 100000;
              }
              const imageId = basic.image || basic.images?.[0];
              const imageUrl = imageId ? (imageId.startsWith('http') ? imageId : `https://down-vn.img.susercontent.com/file/${imageId}`) : undefined;
              const url = `https://shopee.vn/product/${shopId}/${itemId}`;

              buyerItems.push({
                itemId,
                shopId,
                name,
                url,
                price: priceNum > 0 ? priceNum : undefined,
                imageUrl,
                ctime: basic.ctime || Math.floor(Date.now() / 1000),
              });
            }
          }
        } catch {}
      }
    };

    page.on('response', onBuyerResponse);

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(3000);

      // Determine numeric shopId from context if not already known
      let targetShopNumericId = /^\d+$/.test(shopId) ? shopId : '';
      if (!targetShopNumericId) {
        const found = await page.evaluate(() => {
          const m = document.documentElement.innerHTML.match(/"shopid":\s*(\d+)/i) ||
                    document.documentElement.innerHTML.match(/"shop_id":\s*(\d+)/i);
          return m ? m[1] : null;
        });
        if (found) {
          targetShopNumericId = found;
          this.shopUrlCache.set(found, targetUrl);
        }
      }

      // In-page fast fetch of rcmd_items & get_shop_seo (100% free, runs inside browser origin)
      if (targetShopNumericId) {
        const inPageItems: any[] = await page.evaluate(async (sId: string) => {
          const resItems: any[] = [];
          const seen = new Set<string>();

          // 1. rcmd_items (Shopee shop category tab main product list)
          try {
            const r = await fetch(
              '/api/v4/shop/rcmd_items?bundle=shop_page_category_tab_main&limit=60&offset=0&shop_id=' + sId,
              {
                headers: {
                  'x-api-source': 'pc',
                  'x-requested-with': 'XMLHttpRequest',
                  'x-shopee-language': 'vi',
                },
              }
            );
            const data = await r.json();
            const list = data?.data?.items || data?.items || [];
            for (const it of list) {
              const item = it.item_basic || it;
              if (item && item.itemid && !seen.has(String(item.itemid))) {
                seen.add(String(item.itemid));
                let priceNum = parseFloat(String(item.price || 0));
                if (priceNum > 10000000) {
                  priceNum = priceNum / 100000;
                }
                const imageId = item.image || item.images?.[0];
                const imageUrl = imageId
                  ? imageId.startsWith('http')
                    ? imageId
                    : `https://down-vn.img.susercontent.com/file/${imageId}`
                  : undefined;

                resItems.push({
                  itemId: String(item.itemid),
                  shopId: String(item.shopid || sId),
                  name: item.name || 'Sản phẩm mới',
                  url: `https://shopee.vn/product/${item.shopid || sId}/${item.itemid}`,
                  price: priceNum > 0 ? priceNum : undefined,
                  imageUrl,
                  ctime: item.ctime || Math.floor(Date.now() / 1000),
                });
              }
            }
          } catch (e) {}

          // 2. get_shop_seo fallback
          try {
            const r = await fetch('/api/v4/shop/get_shop_seo?shopid=' + sId, {
              headers: {
                'x-api-source': 'pc',
                'x-requested-with': 'XMLHttpRequest',
                'x-shopee-language': 'vi',
              },
            });
            const data = await r.json();
            const list = data?.data?.items || [];
            for (const it of list) {
              const item = it.item_basic || it;
              if (item && item.itemid && !seen.has(String(item.itemid))) {
                seen.add(String(item.itemid));
                let priceNum = parseFloat(String(item.price || 0));
                if (priceNum > 10000000) {
                  priceNum = priceNum / 100000;
                }
                const imageId = item.image || item.images?.[0];
                const imageUrl = imageId
                  ? imageId.startsWith('http')
                    ? imageId
                    : `https://down-vn.img.susercontent.com/file/${imageId}`
                  : undefined;

                resItems.push({
                  itemId: String(item.itemid),
                  shopId: String(item.shopid || sId),
                  name: item.name || 'Sản phẩm mới',
                  url: `https://shopee.vn/product/${item.shopid || sId}/${item.itemid}`,
                  price: priceNum > 0 ? priceNum : undefined,
                  imageUrl,
                  ctime: item.ctime || Math.floor(Date.now() / 1000),
                });
              }
            }
          } catch (e) {}

          return resItems;
        }, targetShopNumericId);

        for (const it of inPageItems) {
          if (!seenItemIds.has(it.itemId)) {
            seenItemIds.add(it.itemId);
            buyerItems.push(it);
          }
        }
      }

      // If inPageItems found products, we don't even need to wait for DOM clicks
      if (buyerItems.length === 0) {
        // Click "TẤT CẢ SẢN PHẨM" tab (#product_list) if present on shop front
        const tabEl = await page.$('a[href*="#product_list"]');
        if (tabEl) {
          await tabEl.click();
          await sleep(2000);
        }

        // Scroll down slightly to trigger lazy-load rendering
        await page.evaluate(() => window.scrollBy(0, 1000));
        await sleep(1500);
      }
    } catch (e: any) {
      logger.debug(`Navigation step notice: ${e.message}`);
    } finally {
      page.off('response', onBuyerResponse);
    }

    // Extract all product cards from the DOM
    const domProducts = await page.evaluate((sId: string) => {
      const anchors = Array.from(document.querySelectorAll('a')).filter((a) =>
        a.href && (a.href.includes('-i.') || (a.href.includes('/product/') && !a.href.includes('/portal/')))
      );
      const items: any[] = [];
      const seen = new Set<string>();

      for (const a of anchors) {
        const href = (a as HTMLAnchorElement).href;
        const match = href.match(/-i\.(\d+)\.(\d+)/);
        const itId = match ? match[2] : '';
        if (!itId || seen.has(itId)) continue;
        seen.add(itId);

        const text = (a as HTMLElement).innerText || '';
        const img = a.querySelector('img');
        const imgSrc = img?.getAttribute('src') || '';
        const altName = img?.getAttribute('alt') || '';

        // Extract title
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        const name = altName || lines[0] || 'Sản phẩm mới';

        // Extract price (e.g. 130.000 ₫)
        let price: number | undefined;
        const priceMatch = text.match(/([\d.]+)\s*₫/);
        if (priceMatch) {
          const clean = priceMatch[1].replace(/\./g, '');
          const pNum = parseInt(clean, 10);
          if (!isNaN(pNum) && pNum > 0) price = pNum;
        }

        items.push({
          itemId: itId,
          shopId: match ? match[1] : sId,
          name,
          url: `https://shopee.vn/product/${match ? match[1] : sId}/${itId}`,
          price,
          imageUrl: imgSrc || undefined,
          ctime: Math.floor(Date.now() / 1000),
        });
      }
      return items;
    }, shopId);

    // Merge DOM items and intercepted API items
    for (const item of domProducts) {
      if (!seenItemIds.has(item.itemId)) {
        seenItemIds.add(item.itemId);
        buyerItems.push(item);
      }
    }

    logger.info(`Browser provider extracted ${buyerItems.length} products for shop ${shopId}.`);
    return buyerItems;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
      this.browser = null;
      this.activePage = null;
      this.sellerApiUrl = null;
    }
  }
}
