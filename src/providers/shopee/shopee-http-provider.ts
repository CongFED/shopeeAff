import https from 'node:https';
import { IShopeeProvider, ShopResolveResult, ProductItem, FetchProductsOptions } from '../types.js';
import { parseShopTarget } from '../../utils/url.js';
import { withRetry } from '../../utils/retry.js';
import { logger } from '../../utils/logger.js';

interface RequestResult {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export class ShopeeHttpProvider implements IShopeeProvider {
  readonly name = 'ShopeeHttpProvider';

  private cookie?: string;
  private afAcEncDat?: string;
  private userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  constructor(cookie?: string, afAcEncDat?: string, userAgent?: string) {
    this.cookie = cookie;
    this.afAcEncDat = afAcEncDat;
    if (userAgent) {
      this.userAgent = userAgent;
    }
  }

  private httpRequest(url: string, extraHeaders: Record<string, string> = {}): Promise<RequestResult> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const headers: Record<string, string> = {
        'User-Agent': this.userAgent,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        Referer: 'https://shopee.vn/',
        'x-shopee-language': 'vi',
        'x-requested-with': 'XMLHttpRequest',
        'x-api-source': 'pc',
        ...extraHeaders,
      };

      if (this.cookie) {
        headers['Cookie'] = this.cookie;
      }

      if (this.afAcEncDat) {
        headers['af-ac-enc-dat'] = this.afAcEncDat;
      }

      const req = https.request(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers,
          timeout: 12000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers,
              body: data,
            });
          });
        }
      );

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Timeout requesting ${parsed.pathname}`));
      });
      req.end();
    });
  }

  async resolveShop(urlOrIdentifier: string): Promise<ShopResolveResult> {
    const parsed = parseShopTarget(urlOrIdentifier);

    // If shopId is directly present in URL
    if (parsed.shopId) {
      // Try resolving shop name from shop_id
      try {
        const info = await this.getShopInfoById(parsed.shopId);
        return {
          shopId: parsed.shopId,
          shopName: info.name || `Shop ${parsed.shopId}`,
          shopUrl: parsed.normalizedUrl,
        };
      } catch {
        return {
          shopId: parsed.shopId,
          shopName: `Shop ${parsed.shopId}`,
          shopUrl: parsed.normalizedUrl,
        };
      }
    }

    if (!parsed.username) {
      throw new Error(`Cannot extract shop username from: "${urlOrIdentifier}"`);
    }

    const username = parsed.username;
    const apiUrl = `https://shopee.vn/api/v4/shop/get_shop_base?username=${encodeURIComponent(username)}`;

    const res = await withRetry(
      () => this.httpRequest(apiUrl, { Referer: parsed.normalizedUrl }),
      {
        maxRetries: 2,
        operationName: `resolveShop(${username})`,
        shouldRetry: (err) => !err.message?.includes('WAF Blocked'),
      }
    );

    if (res.statusCode === 403 || res.body.includes('90309999')) {
      throw new Error(
        `Shopee WAF Blocked (Error 90309999): Anti-bot verification triggered for shop "${username}". Configure SHOPEE_COOKIE in .env or use a supported proxy provider.`
      );
    }

    if (res.statusCode !== 200) {
      throw new Error(`HTTP ${res.statusCode} resolving shop "${username}" from Shopee`);
    }

    let json: any;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new Error(`Invalid JSON response while resolving shop "${username}"`);
    }

    if (json.error) {
      throw new Error(`Shopee error ${json.error}: ${json.error_msg || 'Shop not found'}`);
    }

    const data = json.data;
    if (!data || !data.shopid) {
      throw new Error(`Shop data not found for username "${username}"`);
    }

    return {
      shopId: String(data.shopid),
      shopName: data.name || username,
      shopUrl: parsed.normalizedUrl,
    };
  }

  private async getShopInfoById(shopId: string): Promise<{ name?: string }> {
    const url = `https://shopee.vn/api/v4/pdp/get_shop_info?shop_id=${encodeURIComponent(shopId)}`;
    const res = await this.httpRequest(url);
    if (res.statusCode === 200) {
      const json = JSON.parse(res.body);
      if (json.data?.name) {
        return { name: json.data.name };
      }
    }
    return {};
  }

  async getShopProducts(shopId: string, options: FetchProductsOptions = {}): Promise<ProductItem[]> {
    const limit = options.limit || 30;
    const offset = options.offset || 0;

    // Strategy 1: Try get_shop_seo (returns real item details with name, price, url without WAF block)
    try {
      const seoUrl = `https://shopee.vn/api/v4/shop/get_shop_seo?shopid=${encodeURIComponent(shopId)}`;
      const seoRes = await this.httpRequest(seoUrl);
      if (seoRes.statusCode === 200) {
        const seoJson = JSON.parse(seoRes.body);
        if (seoJson.error === 0 && Array.isArray(seoJson.data?.items) && seoJson.data.items.length > 0) {
          const seoItems: ProductItem[] = [];
          for (const raw of seoJson.data.items) {
            const item = raw.item_basic || raw;
            if (!item || !item.itemid) continue;
            const itemId = String(item.itemid);
            const name = item.name || 'Sản phẩm mới';
            let price = typeof item.price === 'number' ? item.price : undefined;
            if (price && price > 10000000) price = Math.round(price / 100000);
            const imageId = item.image || item.images?.[0];
            const imageUrl = imageId ? `https://down-vn.img.susercontent.com/file/${imageId}` : undefined;
            const itemShopId = String(item.shopid || shopId);
            const url = `https://shopee.vn/product/${itemShopId}/${itemId}`;

            seoItems.push({
              itemId,
              shopId: itemShopId,
              name,
              url,
              price,
              imageUrl,
              ctime: item.ctime,
            });
          }
          if (seoItems.length > 0) {
            return seoItems;
          }
        }
      }
    } catch (err: any) {
      logger.debug(`get_shop_seo failed for shop ${shopId}: ${err.message}`);
    }

    // Strategy 2: search_items
    const searchUrl = `https://shopee.vn/api/v4/shop/search_items?shop_id=${encodeURIComponent(
      shopId
    )}&limit=${limit}&offset=${offset}&order=desc&by=ctime`;

    const res = await withRetry(() => this.httpRequest(searchUrl), {
      maxRetries: 2,
      operationName: `getShopProducts(${shopId})`,
      shouldRetry: (err) => !err.message?.includes('WAF Blocked'),
    });

    if (res.statusCode === 403 || res.body.includes('90309999')) {
      throw new Error(
        `Shopee WAF Blocked (Error 90309999): Anti-bot verification triggered for shopId ${shopId}. Please provide SHOPEE_COOKIE in .env.`
      );
    }

    if (res.statusCode === 429) {
      const err: any = new Error(`Shopee HTTP 429 Rate Limit for shopId ${shopId}`);
      err.statusCode = 429;
      throw err;
    }

    if (res.statusCode !== 200) {
      throw new Error(`HTTP ${res.statusCode} fetching products for shopId ${shopId}`);
    }

    let json: any;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new Error(`Invalid JSON response for shopId ${shopId}`);
    }

    const items: ProductItem[] = [];

    // Format 1: items list from search_items
    if (Array.isArray(json.items)) {
      for (const raw of json.items) {
        const item = raw.item_basic || raw;
        if (!item || !item.itemid) continue;

        const itemId = String(item.itemid);
        const name = item.name || 'Sản phẩm mới';
        let price = typeof item.price === 'number' ? item.price : undefined;
        if (price && price > 10000000) price = Math.round(price / 100000);
        const imageId = item.image || item.images?.[0];
        const imageUrl = imageId ? `https://down-vn.img.susercontent.com/file/${imageId}` : undefined;
        const itemShopId = String(item.shopid || shopId);
        const url = `https://shopee.vn/product/${itemShopId}/${itemId}`;

        items.push({
          itemId,
          shopId: itemShopId,
          name,
          url,
          price,
          imageUrl,
          ctime: item.ctime,
        });
      }
      return items;
    }

    // Format 2: recommend endpoint fallback
    const recommendUrl = `https://shopee.vn/api/v4/recommend/recommend?bundle=shop_page_product_tab_main&limit=${limit}&offset=${offset}&section=shop_page_product_tab_main_sec&shop_id=${encodeURIComponent(
      shopId
    )}&sort_type=1`;

    const resRec = await this.httpRequest(recommendUrl);
    if (resRec.statusCode === 200) {
      const rJson = JSON.parse(resRec.body);
      const recItems = rJson.data?.sections?.[0]?.data?.item;
      if (Array.isArray(recItems)) {
        for (const it of recItems) {
          const itemId = String(it.itemid);
          const name = it.name || 'Sản phẩm mới';
          const price = typeof it.price === 'number' ? it.price : undefined;
          const imageId = it.image;
          const imageUrl = imageId ? `https://down-vn.img.susercontent.com/file/${imageId}` : undefined;
          const itemShopId = String(it.shopid || shopId);
          const url = `https://shopee.vn/product/${itemShopId}/${itemId}`;

          items.push({
            itemId,
            shopId: itemShopId,
            name,
            url,
            price,
            imageUrl,
            ctime: it.ctime,
          });
        }
      }
    }

    return items;
  }
}
