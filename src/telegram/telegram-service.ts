import https from 'node:https';
import { formatVNDateTime, formatVNDPrice, sleep } from '../utils/time.js';
import { logger } from '../utils/logger.js';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface NewProductNotificationPayload {
  shopName: string;
  itemName: string;
  productUrl: string;
  price?: number;
  imageUrl?: string;
  ctime?: number;
  discoveredAt?: Date;
}

export interface PriceUpdateNotificationPayload {
  shopName: string;
  itemName: string;
  productUrl: string;
  oldPrice: number;
  newPrice: number;
  imageUrl?: string;
  updatedAt?: Date;
}

export class TelegramService {
  private botToken: string;
  private chatId: string;
  private lastSendTime = 0;
  private minIntervalMs = 1000; // 1 second throttle to respect Telegram per-chat limits

  constructor(config: TelegramConfig) {
    this.botToken = config.botToken;
    this.chatId = config.chatId;
  }

  get isConfigured(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  private async rateLimitThrottle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastSendTime;
    if (elapsed < this.minIntervalMs) {
      await sleep(this.minIntervalMs - elapsed);
    }
    this.lastSendTime = Date.now();
  }

  private postTelegramApi(method: string, payload: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.botToken) {
        return reject(new Error('Telegram bot token is not configured'));
      }

      const bodyData = JSON.stringify(payload);
      const req = https.request(
        {
          hostname: 'api.telegram.org',
          path: `/bot${this.botToken}/${method}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyData),
          },
          timeout: 15000,
        },
        (res) => {
          let chunks = '';
          res.on('data', (c) => (chunks += c));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(chunks);
              if (res.statusCode === 200 && parsed.ok) {
                resolve(parsed.result);
              } else {
                const err: any = new Error(
                  `Telegram API error: [${res.statusCode}] ${parsed.description || chunks}`
                );
                err.statusCode = res.statusCode;
                err.retryAfter = parsed.parameters?.retry_after;
                reject(err);
              }
            } catch (err) {
              reject(new Error(`Failed to parse Telegram API response: ${chunks}`));
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Telegram API timeout on ${method}`));
      });
      req.write(bodyData);
      req.end();
    });
  }

  formatProductMessage(payload: NewProductNotificationPayload): string {
    const postDate = payload.ctime ? new Date(payload.ctime * 1000) : (payload.discoveredAt || new Date());
    const detectedTime = formatVNDateTime(postDate);
    const formattedPrice = formatVNDPrice(payload.price);

    // Escape or clean text to avoid breaking HTML
    const cleanShopName = escapeHtml(payload.shopName);
    const cleanItemName = escapeHtml(payload.itemName);

    return (
      `🆕 <b>PHÁT HIỆN SẢN PHẨM MỚI!</b>\n\n` +
      `🏪 <b>Shop:</b> ${cleanShopName}\n` +
      `📦 <b>Sản phẩm:</b> ${cleanItemName}\n` +
      `💰 <b>Giá:</b> ${formattedPrice}\n` +
      `⏰ <b>Thời gian đăng:</b> ${detectedTime}\n` +
      `🔗 <a href="${payload.productUrl}">Xem trên Shopee</a>`
    );
  }

  formatPriceUpdateMessage(payload: PriceUpdateNotificationPayload): string {
    const updateTime = formatVNDateTime(payload.updatedAt || new Date());
    const formattedOld = formatVNDPrice(payload.oldPrice);
    const formattedNew = formatVNDPrice(payload.newPrice);
    const cleanShopName = escapeHtml(payload.shopName);
    const cleanItemName = escapeHtml(payload.itemName);

    const priceDirection = payload.newPrice < payload.oldPrice ? '📉 GIẢM GIÁ' : '📈 TĂNG GIÁ';

    return (
      `🔔 <b>CẬP NHẬT GIÁ SẢN PHẨM (${priceDirection})!</b>\n\n` +
      `🏪 <b>Shop:</b> ${cleanShopName}\n` +
      `📦 <b>Sản phẩm:</b> ${cleanItemName}\n` +
      `🏷️ <b>Giá cũ:</b> <s>${formattedOld}</s>\n` +
      `💰 <b>Giá mới:</b> <b>${formattedNew}</b>\n` +
      `⏰ <b>Thời gian cập nhật:</b> ${updateTime}\n` +
      `🔗 <a href="${payload.productUrl}">Xem trên Shopee</a>`
    );
  }

  async sendProductNotification(payload: NewProductNotificationPayload): Promise<{ success: boolean; error?: string }> {
    if (!this.isConfigured) {
      logger.info(`[Telegram DRY-RUN] Would notify new product: "${payload.itemName}" from shop "${payload.shopName}"`);
      return { success: true };
    }

    const messageHtml = this.formatProductMessage(payload);

    await this.rateLimitThrottle();

    // Send formatted text message with rich link preview enabled
    try {
      await this.postTelegramApi('sendMessage', {
        chat_id: this.chatId,
        text: messageHtml,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      });
      logger.info(`Telegram notification sent for: ${payload.itemName}`);
      return { success: true };
    } catch (err: any) {
      logger.error(`Failed to send Telegram notification: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async sendPriceUpdateNotification(payload: PriceUpdateNotificationPayload): Promise<{ success: boolean; error?: string }> {
    if (!this.isConfigured) {
      logger.info(`[Telegram DRY-RUN] Would notify price change: "${payload.itemName}" from ${payload.oldPrice} to ${payload.newPrice}`);
      return { success: true };
    }

    const messageHtml = this.formatPriceUpdateMessage(payload);

    await this.rateLimitThrottle();

    try {
      await this.postTelegramApi('sendMessage', {
        chat_id: this.chatId,
        text: messageHtml,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      });
      logger.info(`Telegram price update sent for: ${payload.itemName} (${payload.oldPrice} -> ${payload.newPrice})`);
      return { success: true };
    } catch (err: any) {
      logger.error(`Failed to send Telegram price update notification: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    if (!this.isConfigured) {
      return {
        ok: false,
        message: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing in configuration.',
      };
    }

    try {
      const me = await this.postTelegramApi('getMe', {});
      const botName = me.username || me.first_name;

      const testMsg =
        `🤖 <b>KIỂM TRA KẾT NỐI TELEGRAM BOT</b>\n\n` +
        `✅ Bot: @${botName}\n` +
        `🕒 Thời gian: ${formatVNDateTime()}\n` +
        `Hệ thống Shopee Product Monitor đã kết nối thành công!`;

      await this.postTelegramApi('sendMessage', {
        chat_id: this.chatId,
        text: testMsg,
        parse_mode: 'HTML',
      });

      return {
        ok: true,
        message: `Successfully connected to bot @${botName} and delivered test message to chat ${this.chatId}`,
      };
    } catch (err: any) {
      return {
        ok: false,
        message: `Telegram test failed: ${err.message}`,
      };
    }
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
