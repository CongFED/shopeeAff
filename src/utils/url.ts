export interface ParsedShopTarget {
  raw: string;
  normalizedUrl: string;
  username?: string;
  shopId?: string;
}

/**
 * Normalizes and extracts shop identifier (username or shopId) from various Shopee URL styles.
 */
export function parseShopTarget(input: string): ParsedShopTarget {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Empty shop URL or identifier');
  }

  // Prepend https:// if missing
  let withProtocol = trimmed;
  if (!/^https?:\/\//i.test(withProtocol)) {
    // If it starts with shopee.vn/
    if (withProtocol.startsWith('shopee.vn/')) {
      withProtocol = `https://${withProtocol}`;
    } else {
      // If not starting with shopee.vn/, check if it is a valid username format or number
      if (/^\d+$/.test(withProtocol)) {
        return {
          raw: trimmed,
          normalizedUrl: `https://shopee.vn/shop/${withProtocol}`,
          shopId: withProtocol,
        };
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(withProtocol)) {
        throw new Error(`Invalid shop identifier or URL format: "${trimmed}"`);
      }
      withProtocol = `https://shopee.vn/${withProtocol}`;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch (e: any) {
    throw new Error(`Invalid URL format: "${trimmed}"`);
  }

  // Validate that hostname is shopee.vn
  if (!parsed.hostname.endsWith('shopee.vn') && !parsed.hostname.endsWith('shp.ee')) {
    throw new Error(`Invalid domain "${parsed.hostname}". URL must belong to shopee.vn.`);
  }

  // Strip query parameters and hash to normalize
  const pathname = parsed.pathname.replace(/\/+$/, ''); // Remove trailing slashes

  // Match /shop/<shopId>
  const shopIdMatch = pathname.match(/^\/shop\/(\d+)/i);
  if (shopIdMatch) {
    const shopId = shopIdMatch[1];
    return {
      raw: trimmed,
      normalizedUrl: `https://shopee.vn/shop/${shopId}`,
      shopId,
    };
  }

  // Match /<username>
  const usernameMatch = pathname.match(/^\/([a-zA-Z0-9._-]+)/);
  if (usernameMatch) {
    const username = usernameMatch[1];
    // Filter out common reserved paths
    const reserved = ['cart', 'buyer', 'user', 'search', 'mall', 'daily_discover', 'api'];
    if (reserved.includes(username.toLowerCase())) {
      throw new Error(`URL points to a reserved Shopee page, not a shop: "${trimmed}"`);
    }

    return {
      raw: trimmed,
      normalizedUrl: `https://shopee.vn/${username}`,
      username,
    };
  }

  throw new Error(`Could not parse a valid Shopee shop username or ID from "${trimmed}"`);
}
