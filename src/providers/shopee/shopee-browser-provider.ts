import puppeteer, { Browser, Page } from 'puppeteer-core';
import fs from 'node:fs';
import { IShopeeProvider, ShopResolveResult, ProductItem, FetchProductsOptions } from '../types.js';
import { parseShopTarget } from '../../utils/url.js';
import { logger } from '../../utils/logger.js';
import { sleep } from '../../utils/time.js';

export class ShopeeBrowserProvider implements IShopeeProvider {
  readonly name = 'ShopeeBrowserProvider';

  private cookieString?: string;
  private userAgent?: string;
  private chromePath: string;
  private browser: Browser | null = null;
  private activePage: Page | null = null;
  private sellerApiUrl: string | null = null;

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

  private async ensureBrowser(): Promise<{ browser: Browser; page: Page }> {
    if (this.browser && this.activePage && !this.activePage.isClosed()) {
      return { browser: this.browser, page: this.activePage };
    }

    logger.info(`Starting headless Chrome (${this.chromePath})...`);
    const browser = await puppeteer.launch({
      executablePath: this.chromePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1280,800',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });

    // Blazing-fast performance: Block images, fonts, media, and 3rd party trackers
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      const u = req.url();
      if (
        type === 'image' ||
        type === 'font' ||
        type === 'media' ||
        u.includes('google-analytics') ||
        u.includes('googletagmanager') ||
        u.includes('facebook.net') ||
        u.includes('doubleclick')
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(
      this.userAgent ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    const cookies = this.parseCookies();
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
    }

    // Capture seller API URL with SPC_CDS dynamically (avoid education_visible_info matching)
    page.on('response', (res) => {
      const u = res.url();
      if (/\/get_product_list(\?|$)/.test(u) && u.includes('SPC_CDS=')) {
        this.sellerApiUrl = u;
      }
    });

    try {
      if (this.cookieString && this.cookieString.includes('SPC_SC_SESSION') && this.isSellerCentreAvailable) {
        await page.goto('https://banhang.shopee.vn/portal/product/list/all', { waitUntil: 'domcontentloaded', timeout: 12000 });
        if (page.url().includes('vn-onboarding')) {
          this.isSellerCentreAvailable = false;
          logger.info('Account is not a registered seller. Directing to buyer strategy.');
        }
      } else {
        await page.goto('https://shopee.vn/', { waitUntil: 'domcontentloaded', timeout: 8000 });
      }
    } catch (e: any) {
      logger.debug(`Initial warm-up completed: ${e.message}`);
    }

    this.browser = browser;
    this.activePage = page;

    return { browser, page };
  }

  async resolveShop(urlOrIdentifier: string): Promise<ShopResolveResult> {
    const parsed = parseShopTarget(urlOrIdentifier);

    if (parsed.shopId) {
      return {
        shopId: parsed.shopId,
        shopName: `Shop ${parsed.shopId}`,
        shopUrl: parsed.normalizedUrl,
      };
    }

    const { page } = await this.ensureBrowser();
    logger.info(`Browser resolving shop URL: ${parsed.normalizedUrl}`);

    await page.goto(parsed.normalizedUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
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

    return {
      shopId: finalShopId,
      shopName: parsed.username || shopInfo.title || `Shop ${finalShopId}`,
      shopUrl: parsed.normalizedUrl,
    };
  }

  async getShopProducts(shopId: string, options: FetchProductsOptions = {}): Promise<ProductItem[]> {
    const { page } = await this.ensureBrowser();

    // Strategy 1: Seller Centre API query (Only for shop owner accounts with SPC_SC_SESSION)
    if (this.isSellerCentreAvailable && this.cookieString && this.cookieString.includes('SPC_SC_SESSION')) {
      try {
        let sellerProducts: any[] = [];

        // Fast path: In-page fetch using existing session & captured SPC_CDS url (<150ms)
        if (this.sellerApiUrl) {
          try {
            const data: any = await page.evaluate(async (url) => {
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
    const buyerItems: ProductItem[] = [];
    const onBuyerResponse = async (res: any) => {
      const u = res.url();
      if (
        (u.includes('get_shop_seo') || u.includes('search_items') || u.includes('rcmd_items')) &&
        res.status() === 200
      ) {
        try {
          const json = await res.json();
          // Case A: get_shop_seo format
          if (Array.isArray(json.data?.items)) {
            for (const item of json.data.items) {
              const itemId = String(item.itemid || item.item_id);
              const name = item.name || 'Sản phẩm mới';
              let priceNum = parseFloat(String(item.price || 0));
              if (priceNum > 10000000) {
                priceNum = priceNum / 100000;
              }
              const imageId = item.image;
              const imageUrl = imageId ? `https://down-vn.img.susercontent.com/file/${imageId}` : undefined;
              const url = `https://shopee.vn/product/${shopId}/${itemId}`;

              buyerItems.push({
                itemId,
                shopId,
                name,
                url,
                price: priceNum > 0 ? priceNum : undefined,
                imageUrl,
                ctime: Math.floor(Date.now() / 1000),
              });
            }
          }
          // Case B: search_items or rcmd_items format
          const rawItems = json.items || json.data?.items || [];
          if (Array.isArray(rawItems)) {
            for (const it of rawItems) {
              const basic = it.item_basic || it;
              if (!basic || !basic.itemid) continue;
              const itemId = String(basic.itemid);
              const name = basic.name || 'Sản phẩm mới';
              let priceNum = parseFloat(String(basic.price || 0));
              if (priceNum > 10000000) {
                priceNum = priceNum / 100000;
              }
              const imageId = basic.image;
              const imageUrl = imageId ? `https://down-vn.img.susercontent.com/file/${imageId}` : undefined;
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
    const shopPageUrl = `https://shopee.vn/shop/${shopId}`;
    await page.goto(shopPageUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await sleep(1000);
    page.off('response', onBuyerResponse);

    if (buyerItems.length > 0) {
      return buyerItems;
    }

    // DOM fallback if API didn't return
    const domItems = await page.evaluate((sId: string) => {
      const anchors = Array.from(document.querySelectorAll('a[href*="-i."]'));
      return anchors.slice(0, 30).map((a) => {
        const href = (a as HTMLAnchorElement).href;
        const match = href.match(/-i\.(\d+)\.(\d+)/);
        const nameEl = a.querySelector('div, span, img');
        const name = (a as HTMLElement).innerText.trim() || nameEl?.getAttribute('alt') || 'Sản phẩm mới';
        return {
          itemId: match ? match[2] : Math.random().toString(),
          shopId: sId,
          name,
          url: href,
        };
      });
    }, shopId);

    return domItems;
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
