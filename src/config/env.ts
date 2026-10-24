import dotenv from 'dotenv';
import path from 'node:path';

// Load environment variables from .env if present
dotenv.config();

export interface AppConfig {
  telegramBotToken: string;
  telegramChatId: string;
  pollIntervalMinutes: number;
  pollIntervalSeconds: number;
  maxConcurrentRequests: number;
  requestDelayMs: number;
  databasePath: string;
  dataProvider: 'mock' | 'shopee-http' | 'browser' | 'zenrows' | 'custom';
  zenrowsApiKey?: string;
  shopeeCookie?: string;
  shopeeAfAcEncDat?: string;
  userAgent?: string;
  logLevel: string;
  enableDashboard: boolean;
  dashboardPort: number;
}

export function loadConfig(): AppConfig {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const telegramChatId = process.env.TELEGRAM_CHAT_ID || '';
  const pollIntervalSecondsEnv = process.env.POLL_INTERVAL_SECONDS;
  const pollIntervalMinutesEnv = process.env.POLL_INTERVAL_MINUTES;

  let pollIntervalSeconds = 10;
  if (pollIntervalSecondsEnv) {
    pollIntervalSeconds = parseInt(pollIntervalSecondsEnv, 10);
  } else if (pollIntervalMinutesEnv) {
    pollIntervalSeconds = parseInt(pollIntervalMinutesEnv, 10) * 60;
  }
  if (isNaN(pollIntervalSeconds) || pollIntervalSeconds < 2) {
    pollIntervalSeconds = 10;
  }

  const pollIntervalMinutes = Math.max(1, Math.round(pollIntervalSeconds / 60));
  const maxConcurrentRequests = parseInt(process.env.MAX_CONCURRENT_REQUESTS || '3', 10);
  const requestDelayMs = parseInt(process.env.REQUEST_DELAY_MS || '1000', 10);
  const databasePath = process.env.DATABASE_PATH || './data/monitor.db';
  const dataProvider = ((process.env.DATA_PROVIDER || 'browser').trim().toLowerCase()) as 'mock' | 'shopee-http' | 'browser' | 'zenrows' | 'custom';
  const zenrowsApiKey = process.env.ZENROWS_API_KEY;
  const shopeeCookie = process.env.SHOPEE_COOKIE;
  const shopeeAfAcEncDat = process.env.SHOPEE_AF_AC_ENC_DAT;
  const userAgent = process.env.USER_AGENT;
  const logLevel = process.env.LOG_LEVEL || 'info';
  const enableDashboard = process.env.ENABLE_DASHBOARD !== 'false';
  const dashboardPort = parseInt(process.env.DASHBOARD_PORT || '3000', 10);

  return {
    telegramBotToken,
    telegramChatId,
    pollIntervalMinutes,
    pollIntervalSeconds,
    maxConcurrentRequests: isNaN(maxConcurrentRequests) || maxConcurrentRequests < 1 ? 3 : maxConcurrentRequests,
    requestDelayMs: isNaN(requestDelayMs) || requestDelayMs < 0 ? 1000 : requestDelayMs,
    databasePath: path.resolve(databasePath),
    dataProvider,
    zenrowsApiKey,
    shopeeCookie,
    shopeeAfAcEncDat,
    userAgent,
    logLevel,
    enableDashboard,
    dashboardPort: isNaN(dashboardPort) || dashboardPort <= 0 ? 3000 : dashboardPort,
  };
}

export const config = loadConfig();
