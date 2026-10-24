export interface ShopResolveResult {
  shopId: string;
  shopName: string;
  shopUrl: string;
}

export interface ProductItem {
  itemId: string;
  shopId: string;
  name: string;
  url: string;
  price?: number;
  imageUrl?: string;
  ctime?: number; // Creation timestamp if available
}

export interface FetchProductsOptions {
  limit?: number;
  offset?: number;
}

export interface IShopeeProvider {
  readonly name: string;

  /**
   * Resolves a shop URL or username into an official shopId and shopName.
   */
  resolveShop(urlOrIdentifier: string): Promise<ShopResolveResult>;

  /**
   * Fetches the latest products for a given shopId.
   */
  getShopProducts(shopId: string, options?: FetchProductsOptions): Promise<ProductItem[]>;
}
