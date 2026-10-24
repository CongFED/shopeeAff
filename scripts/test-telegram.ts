import { config } from '../src/config/env.js';
import { TelegramService } from '../src/telegram/telegram-service.js';

async function run() {
  console.log('======================================================');
  console.log('  TESTING TELEGRAM BOT INTEGRATION');
  console.log('======================================================');
  console.log(`Bot Token: ${config.telegramBotToken ? config.telegramBotToken.slice(0, 10) + '...' : 'NOT SET'}`);
  console.log(`Chat ID  : ${config.telegramChatId || 'NOT SET'}`);

  if (!config.telegramBotToken || !config.telegramChatId) {
    console.log(`
❌ Configuration Missing:
Please set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in your .env file.
Example:
  TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
  TELEGRAM_CHAT_ID=-100123456789 (or personal chat ID: 987654321)
    `);
    process.exit(1);
  }

  const telegram = new TelegramService({
    botToken: config.telegramBotToken,
    chatId: config.telegramChatId,
  });

  console.log('\n[1] Testing Telegram Bot connectivity (getMe & test message)...');
  const res = await telegram.testConnection();

  if (!res.ok) {
    console.log(`❌ Connection test failed: ${res.message}`);
    process.exit(1);
  }

  console.log(`✅ ${res.message}`);

  console.log('\n[2] Testing product notification format (matching exact user template)...');
  const sendRes = await telegram.sendProductNotification({
    shopName: 'BIO.Green Home',
    itemName: 'Móc Treo Quần Áo Hình Nơ Hello Kitty Nhựa PP Dẻo Dai Chịu Lực, Móc Treo Váy Áo 2 Dây Có Rãnh Chống Trượt',
    productUrl: 'https://shopee.vn/coolmate.vn',
    price: 80000,
    discoveredAt: new Date(),
  });

  if (sendRes.success) {
    console.log('✅ Sample product notification sent successfully to Telegram!');
  } else {
    console.log(`❌ Failed to send sample product notification: ${sendRes.error}`);
  }

  console.log('\n======================================================');
  console.log('  Telegram Bot Test Finished');
  console.log('======================================================');
}

run();
