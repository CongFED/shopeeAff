import { IShopeeProvider } from './types.js';
import { MockShopeeProvider } from './mock/mock-provider.js';
import { ShopeeHttpProvider } from './shopee/shopee-http-provider.js';
import { ShopeeBrowserProvider } from './shopee/shopee-browser-provider.js';
import { ZenRowsShopeeProvider } from './zenrows/zenrows-provider.js';
import { config } from '../config/env.js';
import { SettingsService } from '../modules/settings/settings-service.js';

let defaultProvider: IShopeeProvider | null = null;

export function getProvider(overrideType?: 'mock' | 'shopee-http' | 'browser' | 'zenrows'): IShopeeProvider {
  if (defaultProvider && !overrideType) {
    return defaultProvider;
  }

  const type = overrideType || config.dataProvider;

  let cookie = config.shopeeCookie;
  let afAc = config.shopeeAfAcEncDat;
  let ua = config.userAgent;
  let zenrowsApiKey = config.zenrowsApiKey;

  try {
    const settingsService = new SettingsService();
    const s = settingsService.getAllSettings();
    if (s.shopeeCookie) cookie = s.shopeeCookie;
    if (s.shopeeAfAcEncDat) afAc = s.shopeeAfAcEncDat;
    if (s.userAgent) ua = s.userAgent;
    if ((s as any).zenrowsApiKey) zenrowsApiKey = (s as any).zenrowsApiKey;
  } catch {}

  if (type === 'mock') {
    defaultProvider = new MockShopeeProvider();
  } else if (type === 'zenrows') {
    defaultProvider = new ZenRowsShopeeProvider(zenrowsApiKey);
  } else if (type === 'browser') {
    defaultProvider = new ShopeeBrowserProvider(cookie, ua);
  } else {
    // Default: Free high-speed Shopee HTTP provider
    defaultProvider = new ShopeeHttpProvider(cookie, afAc, ua);
  }

  return defaultProvider;
}

export function setCustomProvider(provider: IShopeeProvider): void {
  defaultProvider = provider;
}
