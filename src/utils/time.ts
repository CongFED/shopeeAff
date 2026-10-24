/**
 * Sleep helper with promise
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format date to Vietnam Timezone string: DD/MM/YYYY HH:mm:ss
 */
export function formatVNDateTime(date: Date = new Date()): string {
  // Use Intl.DateTimeFormat for Asia/Ho_Chi_Minh timezone
  const formatter = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  // Example output: "23/10/2026, 21:05:00"
  const formatted = formatter.format(date);
  return formatted.replace(',', '');
}

/**
 * Format price in VND currency
 */
export function formatVNDPrice(amount?: number | null): string {
  if (amount === undefined || amount === null || isNaN(amount)) {
    return 'Liên hệ';
  }
  // Shopee API returns price in cents/100,000 unit depending on endpoint.
  // Standard Shopee price in VND usually is in standard Dong or multiplied by 100,000.
  // If price > 10,000,000,000 it is probably raw micro-units (e.g. 5000000000 = 50,000 VND)
  let normalized = amount;
  if (amount > 100_000_000 && amount % 100_000 === 0) {
    normalized = amount / 100_000;
  }
  return `${new Intl.NumberFormat('vi-VN').format(normalized)} VNĐ`;
}

/**
 * Calculate exponential backoff with jitter
 */
export function calculateBackoff(
  attempt: number,
  baseMs = 1000,
  maxMs = 30000,
  factor = 2
): number {
  const exp = Math.min(maxMs, baseMs * Math.pow(factor, attempt));
  // Add 10-30% random jitter to avoid thundering herd
  const jitter = exp * (0.1 + Math.random() * 0.2);
  return Math.min(maxMs, Math.floor(exp + jitter));
}
