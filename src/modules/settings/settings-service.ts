import { getDatabase } from '../../database/db.js';
import { config } from '../../config/env.js';

export interface SystemSettings {
  shopeeCookie: string;
  shopeeAfAcEncDat: string;
  userAgent: string;
  notifyOnProductUpdate: boolean;
}

export class SettingsService {
  getSetting(key: string, fallback = ''): string {
    const db = getDatabase();
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (row && typeof row.value === 'string' && row.value.trim().length > 0) {
      return row.value;
    }
    return fallback;
  }

  setSetting(key: string, value: string): void {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO system_settings (key, value, updated_at) 
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now);
  }

  getAllSettings(): SystemSettings {
    const notifyVal = this.getSetting('NOTIFY_ON_PRODUCT_UPDATE', 'true');
    return {
      shopeeCookie: this.getSetting('SHOPEE_COOKIE', config.shopeeCookie || ''),
      shopeeAfAcEncDat: this.getSetting('SHOPEE_AF_AC_ENC_DAT', config.shopeeAfAcEncDat || ''),
      userAgent: this.getSetting(
        'USER_AGENT',
        config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      ),
      notifyOnProductUpdate: notifyVal !== 'false',
    };
  }

  saveAllSettings(settings: Partial<SystemSettings>): SystemSettings {
    if (typeof settings.shopeeCookie === 'string') {
      this.setSetting('SHOPEE_COOKIE', settings.shopeeCookie.trim());
    }
    if (typeof settings.shopeeAfAcEncDat === 'string') {
      this.setSetting('SHOPEE_AF_AC_ENC_DAT', settings.shopeeAfAcEncDat.trim());
    }
    if (typeof settings.userAgent === 'string') {
      this.setSetting('USER_AGENT', settings.userAgent.trim());
    }
    if (typeof settings.notifyOnProductUpdate === 'boolean') {
      this.setSetting('NOTIFY_ON_PRODUCT_UPDATE', settings.notifyOnProductUpdate ? 'true' : 'false');
    }
    return this.getAllSettings();
  }
}
