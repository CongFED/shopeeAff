import { IShopeeProvider, ShopResolveResult, ProductItem, FetchProductsOptions } from '../types.js';
import { parseShopTarget } from '../../utils/url.js';
import { logger } from '../../utils/logger.js';

export class ZenRowsShopeeProvider implements IShopeeProvider {
  readonly name = 'ZenRowsShopeeProvider';
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.ZENROWS_API_KEY || '';
    if (!this.apiKey) {
      logger.warn('ZenRowsShopeeProvider created without ZENROWS_API_KEY!');
    }
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  /**
   * Fetches rendered HTML of a URL via ZenRows with antibot and JS rendering.
   */
  private async fetchRenderedHtml(targetUrl: string, waitMs = 3500): Promise<string> {
    if (!this.apiKey) {
      throw new Error('ZENROWS_API_KEY is not configured in .env or settings');
    }

    const zenrowsUrl = `https://api.zenrows.com/v1/?apikey=${this.apiKey}&url=${encodeURIComponent(targetUrl)}&js_render=true&antibot=true&premium_proxy=true&proxy_country=vn&wait=${waitMs}`;
    
    logger.debug(`Fetching via ZenRows: ${targetUrl}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const res = await fetch(zenrowsUrl, { signal: controller.signal });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`ZenRows request failed [${res.status}]: ${errText.substring(0, 200)}`);
      }
      return await res.text();
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Extracts initial state JSON embedded by Shopee in <script type="text/mfe-initial-data">
   */
  private extractMfeData(html: string): any | null {
    const scriptMatch = html.match(/<script type="text\/mfe-initial-data"[^>]*>([\s\S]*?)<\/script>/i);
    if (!scriptMatch) return null;
    try {
      return JSON.parse(scriptMatch[1]);
    } catch (e: any) {
      logger.warn(`Failed to parse mfe-initial-data: ${e.message}`);
      return null;
    }
  }

  private shopUrlCache = new Map<string, string>();

  async resolveShop(urlOrIdentifier: string): Promise<ShopResolveResult> {
    const parsed = parseShopTarget(urlOrIdentifier);
    const targetUrl = parsed.username
      ? `https://shopee.vn/${parsed.username}`
      : `https://shopee.vn/shop/${parsed.shopId}`;

    logger.info(`Resolving shop via ZenRows: ${targetUrl}`);
    const html = await this.fetchRenderedHtml(targetUrl, 3000);
    const mfe = this.extractMfeData(html);

    if (mfe?.storeState?.shopBase?.data) {
      const sb = mfe.storeState.shopBase.data;
      const shopId = String(sb.shopid || parsed.shopId || '');
      const shopName = sb.name || sb.shop_name || parsed.username || `Shop ${shopId}`;
      const officialUrl = sb.account?.username
        ? `https://shopee.vn/${sb.account.username}`
        : `https://shopee.vn/shop/${shopId}`;

      this.shopUrlCache.set(shopId, officialUrl);

      return {
        shopId,
        shopName,
        shopUrl: officialUrl,
      };
    }

    // Fallback if shopId was already known
    if (parsed.shopId) {
      this.shopUrlCache.set(parsed.shopId, parsed.normalizedUrl);
      return {
        shopId: parsed.shopId,
        shopName: parsed.username || `Shop ${parsed.shopId}`,
        shopUrl: parsed.normalizedUrl,
      };
    }

    throw new Error(`Could not resolve shop details from ${urlOrIdentifier}`);
  }

  async getShopProducts(shopIdOrUrl: string, options?: FetchProductsOptions): Promise<ProductItem[]> {
    let targetUrl: string;
    let shopId = shopIdOrUrl;

    if (shopIdOrUrl.startsWith('http') || shopIdOrUrl.includes('shopee.vn')) {
      targetUrl = shopIdOrUrl;
    } else if (this.shopUrlCache.has(shopIdOrUrl)) {
      targetUrl = this.shopUrlCache.get(shopIdOrUrl)!;
    } else {
      targetUrl = `https://shopee.vn/shop/${shopIdOrUrl}`;
    }

    logger.info(`Scraping shop products via ZenRows: ${targetUrl}`);

    const html = await this.fetchRenderedHtml(targetUrl, 4000);
    const mfe = this.extractMfeData(html);

    const products: ProductItem[] = [];
    const seenIds = new Set<string>();

    if (mfe?.storeState) {
      // 1. Check shopSeo
      const shopSeo = mfe.storeState.shopSeo;
      if (shopSeo && typeof shopSeo === 'object') {
        for (const k of Object.keys(shopSeo)) {
          const items = shopSeo[k]?.data?.items;
          if (Array.isArray(items)) {
            for (const it of items) {
              const itemId = String(it.itemid || it.itemId || '');
              if (itemId && !seenIds.has(itemId)) {
                seenIds.add(itemId);
                const rawPrice = it.price || it.price_min || it.price_before_discount;
                const price = typeof rawPrice === 'number' && rawPrice > 1000000
                  ? Math.round(rawPrice / 100000)
                  : rawPrice;

                products.push({
                  itemId,
                  shopId: String(it.shopid || shopId),
                  name: it.name || 'Sản phẩm Shopee',
                  url: `https://shopee.vn/product/${it.shopid || shopId}/${itemId}`,
                  price,
                  imageUrl: it.image
                    ? (it.image.startsWith('http') ? it.image : `https://down-vn.img.susercontent.com/file/${it.image}`)
                    : undefined,
                  ctime: it.ctime,
                });
              }
            }
          }
        }
      }

      // 2. Check shopCategory / shopTab
      const shopTab = mfe.storeState.shopCategoryTab || mfe.storeState.shopCustomTab;
      if (shopTab && typeof shopTab === 'object') {
        for (const k of Object.keys(shopTab)) {
          const items = shopTab[k]?.data?.items || shopTab[k]?.items;
          if (Array.isArray(items)) {
            for (const it of items) {
              const itemId = String(it.itemid || it.itemId || '');
              if (itemId && !seenIds.has(itemId)) {
                seenIds.add(itemId);
                const rawPrice = it.price || it.price_min;
                const price = typeof rawPrice === 'number' && rawPrice > 1000000
                  ? Math.round(rawPrice / 100000)
                  : rawPrice;

                products.push({
                  itemId,
                  shopId: String(it.shopid || shopId),
                  name: it.name || 'Sản phẩm Shopee',
                  url: `https://shopee.vn/product/${it.shopid || shopId}/${itemId}`,
                  price,
                  imageUrl: it.image
                    ? (it.image.startsWith('http') ? it.image : `https://down-vn.img.susercontent.com/file/${it.image}`)
                    : undefined,
                  ctime: it.ctime,
                });
              }
            }
          }
        }
      }
    }

    // 3. Fallback: Parse DOM anchors for product links
    if (products.length === 0) {
      const anchorRegex = /href="\/([^"]*-i\.(\d+)\.(\d+)[^"]*)"/gi;
      let match;
      while ((match = anchorRegex.exec(html)) !== null) {
        const path = match[1];
        const sId = match[2];
        const itemId = match[3];
        if (sId === shopId && !seenIds.has(itemId)) {
          seenIds.add(itemId);
          products.push({
            itemId,
            shopId,
            name: decodeURIComponent(path.split('-i.')[0].replace(/-/g, ' ')),
            url: `https://shopee.vn/product/${shopId}/${itemId}`,
          });
        }
      }
    }

    logger.info(`ZenRows extracted ${products.length} products for shop ${shopId}.`);
    return products;
  }
}
