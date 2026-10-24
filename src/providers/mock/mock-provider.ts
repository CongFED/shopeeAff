import { IShopeeProvider, ShopResolveResult, ProductItem, FetchProductsOptions } from '../types.js';
import { parseShopTarget } from '../../utils/url.js';

export class MockShopeeProvider implements IShopeeProvider {
  readonly name = 'MockShopeeProvider';

  private shops: Map<string, { shopId: string; shopName: string; shopUrl: string }> = new Map();
  private products: Map<string, ProductItem[]> = new Map();
  private failureFlags: Map<string, { failTimes: number; errorType: 'network' | 'rate_limit' | '500' }> = new Map();

  constructor() {
    this.seedDefaultMockData();
  }

  private seedDefaultMockData() {
    // Add default mock shops
    this.registerMockShop('469064007', 'Coolmate Official Store', 'https://shopee.vn/coolmate.vn', [
      {
        itemId: '1001',
        shopId: '469064007',
        name: 'Áo Thun Nam Cotton Compact Coolmate',
        url: 'https://shopee.vn/product/469064007/1001',
        price: 199000,
        imageUrl: 'https://cf.shopee.vn/file/mock-img-1001.jpg',
        ctime: 1700000000,
      },
      {
        itemId: '1002',
        shopId: '469064007',
        name: 'Quần Lót Nam Boxer Modal Coolmate',
        url: 'https://shopee.vn/product/469064007/1002',
        price: 89000,
        imageUrl: 'https://cf.shopee.vn/file/mock-img-1002.jpg',
        ctime: 1700000100,
      },
    ]);

    this.registerMockShop('123456789', 'Anker Store Vietnam', 'https://shopee.vn/anker_store', [
      {
        itemId: '2001',
        shopId: '123456789',
        name: 'Củ sạc nhanh Anker 20W PD Nano Pro',
        url: 'https://shopee.vn/product/123456789/2001',
        price: 320000,
        imageUrl: 'https://cf.shopee.vn/file/mock-img-2001.jpg',
        ctime: 1700000200,
      },
    ]);
  }

  registerMockShop(shopId: string, shopName: string, shopUrl: string, initialProducts: ProductItem[] = []) {
    this.shops.set(shopId, { shopId, shopName, shopUrl });
    this.products.set(shopId, [...initialProducts]);
  }

  setFailure(shopId: string, errorType: 'network' | 'rate_limit' | '500', failTimes = 1) {
    this.failureFlags.set(shopId, { failTimes, errorType });
  }

  addProduct(shopId: string, product: ProductItem) {
    const list = this.products.get(shopId) || [];
    // Prepend as newest
    this.products.set(shopId, [product, ...list]);
  }

  updateProductPrice(shopId: string, itemId: string, newPrice: number) {
    const list = this.products.get(shopId) || [];
    const item = list.find((p) => p.itemId === itemId);
    if (item) {
      item.price = newPrice;
    }
  }

  async resolveShop(urlOrIdentifier: string): Promise<ShopResolveResult> {
    const parsed = parseShopTarget(urlOrIdentifier);

    // Check if we have a match by shopId
    if (parsed.shopId && this.shops.has(parsed.shopId)) {
      return this.shops.get(parsed.shopId)!;
    }

    // Check by username in URL
    for (const shop of this.shops.values()) {
      if (
        (parsed.username && shop.shopUrl.toLowerCase().includes(parsed.username.toLowerCase())) ||
        shop.shopUrl.toLowerCase() === parsed.normalizedUrl.toLowerCase()
      ) {
        return shop;
      }
    }

    // If not found in seed, dynamically register a mock shop for testing
    const generatedShopId = parsed.shopId || Math.floor(100000000 + Math.random() * 900000000).toString();
    const generatedName = parsed.username
      ? parsed.username.charAt(0).toUpperCase() + parsed.username.slice(1) + ' Shop'
      : `Shop ${generatedShopId}`;

    const newShop = {
      shopId: generatedShopId,
      shopName: generatedName,
      shopUrl: parsed.normalizedUrl,
    };
    this.shops.set(generatedShopId, newShop);
    if (!this.products.has(generatedShopId)) {
      this.products.set(generatedShopId, []);
    }

    return newShop;
  }

  async getShopProducts(shopId: string, options: FetchProductsOptions = {}): Promise<ProductItem[]> {
    // Check failure simulation
    const failure = this.failureFlags.get(shopId);
    if (failure && failure.failTimes > 0) {
      failure.failTimes--;
      if (failure.errorType === 'network') {
        throw new Error(`Mock network timeout connecting to shop ${shopId}`);
      } else if (failure.errorType === 'rate_limit') {
        const err: any = new Error('HTTP 429 Too Many Requests from Shopee mock');
        err.statusCode = 429;
        throw err;
      } else {
        throw new Error(`HTTP 500 Internal Server Error for shop ${shopId}`);
      }
    }

    const list = this.products.get(shopId) || [];
    const limit = options.limit || 30;
    const offset = options.offset || 0;
    return list.slice(offset, offset + limit);
  }
}
