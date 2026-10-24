import http from 'node:http';
import { getDatabase } from '../database/db.js';
import { ShopService } from '../modules/shops/shop-service.js';
import { ProductService } from '../modules/products/product-service.js';
import { MonitorEngine } from '../modules/monitoring/monitor-engine.js';
import { SettingsService } from '../modules/settings/settings-service.js';
import { formatVNDateTime, formatVNDPrice } from '../utils/time.js';
import { logger } from '../utils/logger.js';

export function startDashboard(
  port: number,
  shopService: ShopService,
  productService: ProductService,
  monitorEngine: MonitorEngine
): http.Server {
  const settingsService = new SettingsService();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    const sendJson = (statusCode: number, data: any) => {
      res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end(JSON.stringify(data));
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    // --- API Endpoints ---
    if (pathname === '/api/stats' && req.method === 'GET') {
      const db = getDatabase();
      const allShops = shopService.listShops(false);
      const activeShops = shopService.listShops(true);
      const todayCount = productService.getNewProductsTodayCount();
      const errorShops = allShops.filter((s) => Boolean(s.last_error));
      const lastRun = db.prepare('SELECT * FROM check_runs ORDER BY id DESC LIMIT 1').get();

      return sendJson(200, {
        totalShops: allShops.length,
        activeShops: activeShops.length,
        errorShopsCount: errorShops.length,
        newProductsToday: todayCount,
        isChecking: monitorEngine.isBusy,
        lastRun,
      });
    }

    if (pathname === '/api/shops' && req.method === 'GET') {
      const shops = shopService.listShops(false);
      return sendJson(200, shops);
    }

    if (pathname === '/api/shops' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const { url, name } = JSON.parse(body);
          if (!url) return sendJson(400, { error: 'URL is required' });
          const created = await shopService.addShop(url, name);
          sendJson(201, created);
        } catch (err: any) {
          sendJson(400, { error: err.message });
        }
      });
      return;
    }

    if (pathname.startsWith('/api/shops/') && pathname.endsWith('/toggle') && req.method === 'POST') {
      const parts = pathname.split('/');
      const shopId = parseInt(parts[3], 10);
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const { isActive } = JSON.parse(body);
          const ok = shopService.toggleShop(shopId, Boolean(isActive));
          sendJson(200, { success: ok });
        } catch (err: any) {
          sendJson(400, { error: err.message });
        }
      });
      return;
    }

    if (pathname.startsWith('/api/shops/') && req.method === 'DELETE') {
      const parts = pathname.split('/');
      const shopId = parseInt(parts[3], 10);
      const ok = shopService.deleteShop(shopId);
      return sendJson(200, { success: ok });
    }

    if (pathname === '/api/products' && req.method === 'GET') {
      const db = getDatabase();
      const products = db
        .prepare('SELECT * FROM products ORDER BY id DESC LIMIT 50')
        .all();
      return sendJson(200, products);
    }

    if (pathname === '/api/runs' && req.method === 'GET') {
      const db = getDatabase();
      const runs = db.prepare('SELECT * FROM check_runs ORDER BY id DESC LIMIT 10').all();
      return sendJson(200, runs);
    }

    if (pathname === '/api/check-now' && req.method === 'POST') {
      if (monitorEngine.isBusy) {
        return sendJson(409, { message: 'Monitoring cycle already in progress' });
      }
      // Trigger in background
      monitorEngine.runCycle().catch((err) => logger.error('Check-now error:', err));
      return sendJson(202, { message: 'Monitoring cycle triggered' });
    }

    if (pathname === '/api/settings' && req.method === 'GET') {
      const s = settingsService.getAllSettings();
      return sendJson(200, {
        shopeeCookie: s.shopeeCookie,
        shopeeAfAcEncDat: s.shopeeAfAcEncDat,
        userAgent: s.userAgent,
        notifyOnProductUpdate: s.notifyOnProductUpdate,
        hasCookie: Boolean(s.shopeeCookie),
      });
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const updated = settingsService.saveAllSettings({
            shopeeCookie: payload.shopeeCookie,
            shopeeAfAcEncDat: payload.shopeeAfAcEncDat,
            userAgent: payload.userAgent,
            notifyOnProductUpdate: payload.notifyOnProductUpdate,
          });

          // Hot update active provider if supported
          const activeProv = (monitorEngine as any).provider;
          if (activeProv && typeof activeProv.updateCredentials === 'function') {
            activeProv.updateCredentials(updated.shopeeCookie, updated.userAgent);
          }

          sendJson(200, {
            success: true,
            message: 'Đã lưu cài đặt vào Database SQLite thành công!',
            settings: updated,
          });
        } catch (err: any) {
          sendJson(400, { error: err.message });
        }
      });
      return;
    }

    if (pathname === '/api/settings/toggle-product-updates' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          const current = settingsService.getAllSettings();
          const nextVal = typeof payload.enabled === 'boolean' ? payload.enabled : !current.notifyOnProductUpdate;
          const updated = settingsService.saveAllSettings({ notifyOnProductUpdate: nextVal });
          sendJson(200, { success: true, notifyOnProductUpdate: updated.notifyOnProductUpdate });
        } catch (err: any) {
          sendJson(400, { error: err.message });
        }
      });
      return;
    }

    // --- HTML Dashboard Page ---
    if (pathname === '/' || pathname === '/dashboard') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDashboardHtml());
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(port, () => {
    logger.info(`Web Dashboard is running at: http://localhost:${port}`);
  });

  return server;
}

function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Shopee New Product Monitor</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(23, 32, 54, 0.7);
      --border: rgba(255, 255, 255, 0.08);
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --primary: #ee4d2d;
      --primary-hover: #ff5c38;
      --accent-green: #10b981;
      --accent-red: #ef4444;
      --accent-amber: #f59e0b;
      --accent-blue: #3b82f6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background-color: var(--bg);
      background-image: radial-gradient(circle at 10% 20%, rgba(238, 77, 45, 0.08) 0%, transparent 40%),
                        radial-gradient(circle at 90% 80%, rgba(59, 130, 246, 0.08) 0%, transparent 40%);
      color: var(--text);
      min-height: 100vh;
      padding: 24px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 16px;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-icon {
      width: 44px; height: 44px;
      background: linear-gradient(135deg, #ee4d2d, #ff7337);
      border-radius: 12px;
      display: flex; align-items: center; justify-content: center;
      font-size: 24px; box-shadow: 0 4px 14px rgba(238, 77, 45, 0.4);
    }
    h1 { font-size: 24px; font-weight: 700; }
    .subtitle { font-size: 13px; color: var(--text-muted); }
    .btn {
      padding: 8px 16px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .btn-primary { background: var(--primary); color: white; }
    .btn-primary:hover { background: var(--primary-hover); transform: translateY(-1px); }
    .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
    .btn-outline:hover { background: rgba(255, 255, 255, 0.05); }
    .switch {
      position: relative;
      display: inline-block;
      width: 44px;
      height: 24px;
      vertical-align: middle;
    }
    .switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: rgba(255, 255, 255, 0.15);
      transition: .3s;
      border-radius: 24px;
      border: 1px solid var(--border);
    }
    .slider:before {
      position: absolute;
      content: "";
      height: 16px;
      width: 16px;
      left: 3px;
      bottom: 3px;
      background-color: white;
      transition: .3s;
      border-radius: 50%;
    }
    input:checked + .slider {
      background-color: #10b981;
      border-color: #10b981;
    }
    input:checked + .slider:before {
      transform: translateX(20px);
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 28px;
    }
    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 20px;
      backdrop-filter: blur(12px);
    }
    .stat-title { font-size: 13px; color: var(--text-muted); font-weight: 500; }
    .stat-value { font-size: 28px; font-weight: 700; margin-top: 6px; }
    .tabs { display: flex; gap: 8px; border-bottom: 1px solid var(--border); margin-bottom: 20px; }
    .tab {
      padding: 10px 18px;
      cursor: pointer;
      font-weight: 600;
      font-size: 14px;
      border-bottom: 2px solid transparent;
      color: var(--text-muted);
    }
    .tab.active { color: var(--text); border-color: var(--primary); }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      backdrop-filter: blur(12px);
      margin-bottom: 24px;
    }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 14px; }
    th { padding: 12px 14px; color: var(--text-muted); font-weight: 600; border-bottom: 1px solid var(--border); }
    td { padding: 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
    }
    .badge-success { background: rgba(16, 185, 129, 0.15); color: #34d399; }
    .badge-danger { background: rgba(239, 68, 68, 0.15); color: #f87171; }
    .badge-amber { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
    .form-row { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
    .input {
      flex: 1;
      min-width: 200px;
      padding: 10px 14px;
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 14px;
      outline: none;
    }
    .input:focus { border-color: var(--primary); }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <div class="brand-icon">🛍️</div>
        <div>
          <h1>Shopee New Product Monitor</h1>
          <div class="subtitle">Hệ thống theo dõi 200 shop & thông báo tức thời qua Telegram</div>
        </div>
      </div>
      <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
        <div style="display: inline-flex; align-items: center; gap: 8px; background: rgba(255, 255, 255, 0.04); border: 1px solid var(--border); padding: 6px 12px; border-radius: 8px;">
          <span style="font-size: 13px; font-weight: 500;">Báo cập nhật giá:</span>
          <label class="switch">
            <input type="checkbox" id="headerToggleUpdates" onchange="handleToggleProductUpdates(event)">
            <span class="slider"></span>
          </label>
          <span id="headerLabelUpdates" style="font-size: 12px; font-weight: 700; color: #34d399; min-width: 32px;">BẬT</span>
        </div>
        <button class="btn btn-outline" onclick="triggerScan()">⚡ Quét ngay</button>
        <button class="btn btn-primary" onclick="loadAll()">🔄 Làm mới</button>
      </div>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-title">TỔNG SỐ SHOP</div>
        <div class="stat-value" id="statTotalShops">-</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">SHOP ĐANG HOẠT ĐỘNG</div>
        <div class="stat-value" style="color: #34d399" id="statActiveShops">-</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">SẢN PHẨM MỚI HÔM NAY</div>
        <div class="stat-value" style="color: #fb923c" id="statTodayCount">-</div>
      </div>
      <div class="stat-card">
        <div class="stat-title">SHOP GẶP LỖI / WAF</div>
        <div class="stat-value" style="color: #f87171" id="statErrorShops">-</div>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-bottom: 14px;">Thêm shop theo dõi mới</h3>
      <form id="addShopForm" onsubmit="handleAddShop(event)" class="form-row">
        <input class="input" id="newShopUrl" placeholder="URL shop Shopee (ví dụ: https://shopee.vn/coolmate.vn)" required />
        <input class="input" id="newShopName" placeholder="Tên shop gợi nhớ (tùy chọn)" />
        <button type="submit" class="btn btn-primary">➕ Thêm shop</button>
      </form>
    </div>

    <div class="tabs">
      <div class="tab active" onclick="switchTab('shops')">Danh sách shop (<span id="tabShopsCount">0</span>)</div>
      <div class="tab" onclick="switchTab('products')">Sản phẩm phát hiện gần đây</div>
      <div class="tab" onclick="switchTab('runs')">Lịch sử các lượt kiểm tra</div>
      <div class="tab" onclick="switchTab('settings')">⚙️ Cài đặt Shopee Credentials</div>
    </div>

    <!-- Shops Section -->
    <div id="sectionShops" class="card">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Tên shop</th>
            <th>Shopee ID</th>
            <th>URL</th>
            <th>Trạng thái</th>
            <th>Kiểm tra gần nhất</th>
            <th>Lỗi gần nhất</th>
            <th>Hành động</th>
          </tr>
        </thead>
        <tbody id="shopsTableBody">
          <tr><td colspan="8" style="text-align: center; color: var(--text-muted)">Đang tải...</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Products Section -->
    <div id="sectionProducts" class="card" style="display: none;">
      <table>
        <thead>
          <tr>
            <th>Hình</th>
            <th>Tên sản phẩm</th>
            <th>Giá</th>
            <th>Shop ID</th>
            <th>Phát hiện lúc</th>
            <th>Trạng thái Telegram</th>
          </tr>
        </thead>
        <tbody id="productsTableBody">
          <tr><td colspan="6" style="text-align: center; color: var(--text-muted)">Đang tải...</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Runs Section -->
    <div id="sectionRuns" class="card" style="display: none;">
      <table>
        <thead>
          <tr>
            <th>Run ID</th>
            <th>Bắt đầu</th>
            <th>Hoàn thành</th>
            <th>Tổng shop</th>
            <th>Thành công</th>
            <th>Lỗi</th>
            <th>SP mới</th>
            <th>Trạng thái</th>
          </tr>
        </thead>
        <tbody id="runsTableBody">
          <tr><td colspan="8" style="text-align: center; color: var(--text-muted)">Đang tải...</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Settings Section -->
    <div id="sectionSettings" class="card" style="display: none;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; flex-wrap: wrap; gap: 12px;">
        <div>
          <h3 style="font-size: 18px; font-weight: 700; margin-bottom: 6px;">⚙️ Cài đặt Xác thực Shopee (Lưu vào Database)</h3>
          <p style="font-size: 13px; color: var(--text-muted); max-width: 750px; line-height: 1.5;">
            Nhập 3 thông tin xác thực Shopee bên dưới. Dữ liệu được lưu trực tiếp vào cơ sở dữ liệu SQLite (<code style="color: #60a5fa">system_settings</code>), <b>hoàn toàn không lưu hoặc ghi đè file .env</b> và có hiệu lực tức thì cho các lượt quét tiếp theo.
          </p>
        </div>
        <div id="settingsAlert" style="font-size: 13px; padding: 6px 12px; border-radius: 6px; display: none;"></div>
      </div>

      <div style="margin-bottom: 20px; background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border); border-radius: 12px; padding: 16px;">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
          <div>
            <div style="font-weight: 700; font-size: 15px; margin-bottom: 4px;">🔔 Thông báo khi CẬP NHẬT giá sản phẩm</div>
            <div style="font-size: 13px; color: var(--text-muted); line-height: 1.4;">
              Bật hoặc tắt gửi tin nhắn Telegram khi sản phẩm trong shop thay đổi giá bán.
              <br><span style="color: #60a5fa; font-weight: 600;">Lưu ý:</span> Thông báo khi có <b>SẢN PHẨM MỚI</b> luôn luôn được gửi tự động (không bị tắt).
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 10px;">
            <label class="switch">
              <input type="checkbox" id="settingNotifyUpdates" onchange="handleToggleProductUpdates(event)">
              <span class="slider"></span>
            </label>
            <span id="settingNotifyUpdatesLabel" style="font-size: 13px; font-weight: 700; color: #34d399; min-width: 40px;">BẬT</span>
          </div>
        </div>
      </div>

      <div style="margin-bottom: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <label style="font-weight: 600; font-size: 14px;">1. SHOPEE_COOKIE (Phiên đăng nhập Kênh Người Bán / Buyer)</label>
          <span id="cookieCharCount" style="font-size: 12px; color: var(--text-muted);">0 ký tự</span>
        </div>
        <textarea id="settingCookie" class="input" rows="6" oninput="updateCharCount()" style="width: 100%; font-family: monospace; font-size: 12px; resize: vertical;" placeholder="Dán toàn bộ chuỗi cookie của bạn vào đây (ví dụ: SPC_F=...; SPC_ST=...; SPC_SC_SESSION=...;)"></textarea>
        <div style="display: flex; gap: 8px; margin-top: 8px;">
          <button type="button" class="btn btn-outline" style="padding: 4px 12px; font-size: 12px;" onclick="clearCookie()">🧹 Xóa Cookie</button>
          <button type="button" class="btn btn-outline" style="padding: 4px 12px; font-size: 12px;" onclick="pasteCookie()">📋 Dán từ Clipboard</button>
        </div>
        <div style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">
          💡 Cookie chứa <code>SPC_SC_SESSION</code> hoặc <code>SPC_ST</code> cho phép hệ thống truy xuất trực tiếp Kênh Người Bán và cập nhật giá / sản phẩm trong vòng 10 giây.
        </div>
      </div>

      <div style="margin-bottom: 20px;">
        <label style="display: block; font-weight: 600; font-size: 14px; margin-bottom: 6px;">2. SHOPEE_AF_AC_ENC_DAT (Token chống bot phụ)</label>
        <input id="settingAfAc" class="input" style="width: 100%; font-family: monospace; font-size: 13px;" placeholder="Ví dụ: f4f3780ccc751a8f (tùy chọn khi dùng chế độ browser)" />
        <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">
          Token định danh thiết bị chống bot WAF phụ của Shopee (nếu có).
        </div>
      </div>

      <div style="margin-bottom: 24px;">
        <label style="display: block; font-weight: 600; font-size: 14px; margin-bottom: 6px;">3. USER_AGENT (Chuỗi định danh trình duyệt)</label>
        <input id="settingUserAgent" class="input" style="width: 100%; font-family: monospace; font-size: 13px;" placeholder="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" />
        <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">
          Định danh User-Agent của trình duyệt Chrome trên máy bạn. Nếu để trống sẽ sử dụng mặc định.
        </div>
      </div>

      <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
        <button class="btn btn-primary" onclick="saveSettings()" style="padding: 10px 22px;">💾 Lưu cài đặt vào Database</button>
        <button class="btn btn-outline" onclick="triggerScan()" style="padding: 10px 18px;">⚡ Thử quét ngay để kiểm tra</button>
      </div>
    </div>
  </div>

  <script>
    async function loadStats() {
      const res = await fetch('/api/stats');
      const data = await res.json();
      document.getElementById('statTotalShops').innerText = data.totalShops;
      document.getElementById('statActiveShops').innerText = data.activeShops;
      document.getElementById('statTodayCount').innerText = data.newProductsToday;
      document.getElementById('statErrorShops').innerText = data.errorShopsCount;
      document.getElementById('tabShopsCount').innerText = data.totalShops;
    }

    async function loadShops() {
      const res = await fetch('/api/shops');
      const shops = await res.json();
      const tbody = document.getElementById('shopsTableBody');
      if (shops.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;">Chưa có shop nào được theo dõi.</td></tr>';
        return;
      }
      tbody.innerHTML = shops.map(s => \`
        <tr>
          <td>\${s.id}</td>
          <td><b>\${escapeHtml(s.shop_name)}</b></td>
          <td>\${s.shop_id || '<span style="color:#94a3b8">Chưa có</span>'}</td>
          <td><a href="\${s.shop_url}" target="_blank">\${s.shop_url}</a></td>
          <td>
            <span class="badge \${s.is_active ? 'badge-success' : 'badge-danger'}">
              \${s.is_active ? 'Đang bật' : 'Tạm dừng'}
            </span>
          </td>
          <td>\${s.last_checked_at ? new Date(s.last_checked_at).toLocaleString('vi-VN') : 'Chưa chạy'}</td>
          <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #f87171" title="\${escapeHtml(s.last_error || '')}">
            \${s.last_error ? escapeHtml(s.last_error) : '<span style="color:#34d399">Tốt</span>'}
          </td>
          <td>
            <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px" onclick="toggleShop(\${s.id}, \${s.is_active ? 0 : 1})">
              \${s.is_active ? 'Tắt' : 'Bật'}
            </button>
            <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px; color: #ef4444" onclick="deleteShop(\${s.id})">
              Xóa
            </button>
          </td>
        </tr>
      \`).join('');
    }

    async function loadProducts() {
      const res = await fetch('/api/products');
      const prods = await res.json();
      const tbody = document.getElementById('productsTableBody');
      if (prods.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Chưa có sản phẩm mới nào.</td></tr>';
        return;
      }
      tbody.innerHTML = prods.map(p => \`
        <tr>
          <td>
            \${p.image_url ? '<img src="' + p.image_url + '" width="40" height="40" style="border-radius:6px; object-fit:cover" />' : '📦'}
          </td>
          <td><a href="\${p.product_url}" target="_blank"><b>\${escapeHtml(p.item_name)}</b></a></td>
          <td style="color:#fb923c; font-weight:600">\${p.price ? Number(p.price).toLocaleString('vi-VN') + ' đ' : 'Liên hệ'}</td>
          <td>\${p.shop_id}</td>
          <td>\${new Date(p.first_seen_at).toLocaleString('vi-VN')}</td>
          <td>
            <span class="badge \${p.notification_status === 'SENT' ? 'badge-success' : (p.notification_status === 'FAILED' ? 'badge-danger' : 'badge-amber')}">
              \${p.notification_status}
            </span>
          </td>
        </tr>
      \`).join('');
    }

    async function loadRuns() {
      const res = await fetch('/api/runs');
      const runs = await res.json();
      const tbody = document.getElementById('runsTableBody');
      if (runs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;">Chưa có lượt quét nào.</td></tr>';
        return;
      }
      tbody.innerHTML = runs.map(r => \`
        <tr>
          <td>#\${r.id}</td>
          <td>\${new Date(r.started_at).toLocaleString('vi-VN')}</td>
          <td>\${r.finished_at ? new Date(r.finished_at).toLocaleString('vi-VN') : 'Đang chạy...'}</td>
          <td>\${r.total_shops}</td>
          <td style="color:#34d399">\${r.successful_shops}</td>
          <td style="color:#f87171">\${r.failed_shops}</td>
          <td style="color:#fb923c; font-weight:700">\${r.new_products_found}</td>
          <td><span class="badge \${r.status === 'COMPLETED' ? 'badge-success' : 'badge-amber'}">\${r.status}</span></td>
        </tr>
      \`).join('');
    }

    async function handleAddShop(e) {
      e.preventDefault();
      const url = document.getElementById('newShopUrl').value.trim();
      const name = document.getElementById('newShopName').value.trim();
      const res = await fetch('/api/shops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, name }),
      });
      if (res.ok) {
        document.getElementById('newShopUrl').value = '';
        document.getElementById('newShopName').value = '';
        loadAll();
      } else {
        const data = await res.json();
        alert('Lỗi: ' + data.error);
      }
    }

    async function toggleShop(id, isActive) {
      await fetch('/api/shops/' + id + '/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive }),
      });
      loadAll();
    }

    async function deleteShop(id) {
      if (!confirm('Bạn có chắc muốn xóa shop này?')) return;
      await fetch('/api/shops/' + id, { method: 'DELETE' });
      loadAll();
    }

    async function triggerScan() {
      const res = await fetch('/api/check-now', { method: 'POST' });
      const data = await res.json();
      alert(data.message);
      setTimeout(loadAll, 1000);
    }

    function updateCharCount() {
      const val = document.getElementById('settingCookie').value;
      document.getElementById('cookieCharCount').innerText = val.length.toLocaleString('vi-VN') + ' ký tự';
    }

    function clearCookie() {
      if (confirm('Bạn có muốn xóa nội dung ô Cookie?')) {
        document.getElementById('settingCookie').value = '';
        updateCharCount();
      }
    }

    async function pasteCookie() {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          document.getElementById('settingCookie').value = text;
          updateCharCount();
        }
      } catch (err) {
        alert('Không thể đọc clipboard tự động. Vui lòng bấm Ctrl+V để dán.');
      }
    }

    async function handleToggleProductUpdates(e) {
      const isChecked = e.target.checked;
      const headerCheck = document.getElementById('headerToggleUpdates');
      const headerLabel = document.getElementById('headerLabelUpdates');
      const settingCheck = document.getElementById('settingNotifyUpdates');
      const settingLabel = document.getElementById('settingNotifyUpdatesLabel');

      if (headerCheck) headerCheck.checked = isChecked;
      if (headerLabel) {
        headerLabel.innerText = isChecked ? 'BẬT' : 'TẮT';
        headerLabel.style.color = isChecked ? '#34d399' : '#94a3b8';
      }
      if (settingCheck) settingCheck.checked = isChecked;
      if (settingLabel) {
        settingLabel.innerText = isChecked ? 'BẬT' : 'TẮT';
        settingLabel.style.color = isChecked ? '#34d399' : '#94a3b8';
      }

      try {
        await fetch('/api/settings/toggle-product-updates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: isChecked }),
        });
      } catch (err) {
        alert('Lỗi khi đổi trạng thái thông báo cập nhật giá: ' + err.message);
      }
    }

    async function loadSettings() {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        document.getElementById('settingCookie').value = data.shopeeCookie || '';
        document.getElementById('settingAfAc').value = data.shopeeAfAcEncDat || '';
        document.getElementById('settingUserAgent').value = data.userAgent || '';
        updateCharCount();

        const notify = data.notifyOnProductUpdate !== false;
        const headerCheck = document.getElementById('headerToggleUpdates');
        const headerLabel = document.getElementById('headerLabelUpdates');
        const settingCheck = document.getElementById('settingNotifyUpdates');
        const settingLabel = document.getElementById('settingNotifyUpdatesLabel');
        if (headerCheck) headerCheck.checked = notify;
        if (headerLabel) {
          headerLabel.innerText = notify ? 'BẬT' : 'TẮT';
          headerLabel.style.color = notify ? '#34d399' : '#94a3b8';
        }
        if (settingCheck) settingCheck.checked = notify;
        if (settingLabel) {
          settingLabel.innerText = notify ? 'BẬT' : 'TẮT';
          settingLabel.style.color = notify ? '#34d399' : '#94a3b8';
        }
      } catch (err) {
        console.error('Failed to load settings:', err);
      }
    }

    async function saveSettings() {
      const shopeeCookie = document.getElementById('settingCookie').value;
      const shopeeAfAcEncDat = document.getElementById('settingAfAc').value;
      const userAgent = document.getElementById('settingUserAgent').value;
      const notifyOnProductUpdate = document.getElementById('settingNotifyUpdates') ? document.getElementById('settingNotifyUpdates').checked : true;
      const alertBox = document.getElementById('settingsAlert');

      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shopeeCookie, shopeeAfAcEncDat, userAgent, notifyOnProductUpdate }),
        });
        const data = await res.json();
        if (res.ok) {
          alertBox.style.display = 'block';
          alertBox.style.background = 'rgba(16, 185, 129, 0.2)';
          alertBox.style.color = '#34d399';
          alertBox.style.border = '1px solid rgba(16, 185, 129, 0.4)';
          alertBox.innerHTML = '✅ ' + (data.message || 'Đã lưu cài đặt vào Database thành công!');
          setTimeout(() => { alertBox.style.display = 'none'; }, 4000);
        } else {
          alertBox.style.display = 'block';
          alertBox.style.background = 'rgba(239, 68, 68, 0.2)';
          alertBox.style.color = '#f87171';
          alertBox.style.border = '1px solid rgba(239, 68, 68, 0.4)';
          alertBox.innerHTML = '❌ ' + (data.error || 'Lỗi khi lưu');
        }
      } catch (err) {
        alert('Lỗi kết nối khi lưu cài đặt: ' + err.message);
      }
    }

    function switchTab(tab) {
      document.querySelectorAll('.tab').forEach((t, i) => {
        t.classList.toggle('active', (tab === 'shops' && i === 0) || (tab === 'products' && i === 1) || (tab === 'runs' && i === 2) || (tab === 'settings' && i === 3));
      });
      document.getElementById('sectionShops').style.display = tab === 'shops' ? 'block' : 'none';
      document.getElementById('sectionProducts').style.display = tab === 'products' ? 'block' : 'none';
      document.getElementById('sectionRuns').style.display = tab === 'runs' ? 'block' : 'none';
      document.getElementById('sectionSettings').style.display = tab === 'settings' ? 'block' : 'none';
      if (tab === 'products') loadProducts();
      if (tab === 'runs') loadRuns();
      if (tab === 'settings') loadSettings();
    }

    function escapeHtml(str) {
      return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function loadAll() {
      loadStats();
      loadShops();
      loadProducts();
      loadRuns();
      loadSettings();
    }

    loadAll();
  </script>
</body>
</html>`;
}
