/**
 * Shopee Realtime Monitor - Popup Script
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const masterToggle = document.getElementById('masterToggle');
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const totalShopsCount = document.getElementById('totalShopsCount');
  const tabShopsCount = document.getElementById('tabShopsCount');
  const newProductsToday = document.getElementById('newProductsToday');
  const cycleIntervalDisplay = document.getElementById('cycleIntervalDisplay');
  const lastCheckTime = document.getElementById('lastCheckTime');
  const logsList = document.getElementById('logsList');
  const shopsListContainer = document.getElementById('shopsListContainer');

  const btnScanNow = document.getElementById('btnScanNow');
  const btnSyncVps = document.getElementById('btnSyncVps');
  const btnClearLogs = document.getElementById('btnClearLogs');
  const btnAddShop = document.getElementById('btnAddShop');
  const inputNewShopUrl = document.getElementById('inputNewShopUrl');
  const inputNewShopName = document.getElementById('inputNewShopName');

  const settingTeleToken = document.getElementById('settingTeleToken');
  const settingTeleChatId = document.getElementById('settingTeleChatId');
  const settingVpsUrl = document.getElementById('settingVpsUrl');
  const settingInterval = document.getElementById('settingInterval');
  const btnSaveSettings = document.getElementById('btnSaveSettings');
  const btnTestTele = document.getElementById('btnTestTele');

  // Load Initial State
  const state = await chrome.storage.local.get(null);
  applyState(state);

  // Tab Navigation
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  // Master Toggle
  masterToggle.addEventListener('change', async (e) => {
    const active = e.target.checked;
    await chrome.storage.local.set({ isActive: active });
    updateStatusDisplay(active);
    chrome.runtime.sendMessage({ action: active ? 'start_monitoring' : 'stop_monitoring' });
  });

  // Scan Now Button
  btnScanNow.addEventListener('click', () => {
    btnScanNow.disabled = true;
    btnScanNow.innerHTML = '<span class="icon">⏳</span> Đang quét...';
    chrome.runtime.sendMessage({ action: 'trigger_scan_now' }, () => {
      setTimeout(() => {
        btnScanNow.disabled = false;
        btnScanNow.innerHTML = '<span class="icon">🚀</span> Quét ngay';
        refreshDisplay();
      }, 1500);
    });
  });

  // Clear Logs
  btnClearLogs.addEventListener('click', async () => {
    await chrome.storage.local.set({ logs: [] });
    logsList.innerHTML = '<div class="log-entry log-info"><span class="log-time">[Đã xóa]</span> Nhật ký đã được làm trống.</div>';
  });

  // Add Shop
  btnAddShop.addEventListener('click', async () => {
    const url = inputNewShopUrl.value.trim();
    const name = inputNewShopName.value.trim();
    if (!url) {
      alert('Vui lòng nhập Link Shop hoặc Username Shopee!');
      return;
    }

    const { shops = [] } = await chrome.storage.local.get('shops');
    const newId = shops.length > 0 ? Math.max(...shops.map((s) => s.id || 0)) + 1 : 1;
    const cleanName = name || url.split('/').pop() || `Shop ${newId}`;

    const newShop = {
      id: newId,
      shop_id: '',
      shop_name: cleanName,
      shop_url: url.startsWith('http') ? url : `https://shopee.vn/${url}`,
      is_active: true,
      last_item_count: null
    };

    const updated = [newShop, ...shops];
    await chrome.storage.local.set({ shops: updated });
    inputNewShopUrl.value = '';
    inputNewShopName.value = '';
    renderShops(updated);
  });

  // Sync from VPS
  btnSyncVps.addEventListener('click', async () => {
    btnSyncVps.disabled = true;
    btnSyncVps.innerHTML = '<span class="icon">⏳</span> Đang tải từ VPS...';
    try {
      const { vpsUrl } = await chrome.storage.local.get('vpsUrl');
      const targetUrl = (vpsUrl || 'http://36.50.26.72:3000').replace(/\/+$/, '') + '/api/shops';
      const res = await fetch(targetUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const vpsShops = await res.json();

      if (Array.isArray(vpsShops) && vpsShops.length > 0) {
        const { shops = [] } = await chrome.storage.local.get('shops');
        const existingUrls = new Set(shops.map((s) => s.shop_url));
        const merged = [...shops];

        for (const vs of vpsShops) {
          if (!existingUrls.has(vs.shop_url)) {
            merged.push({
              id: vs.id,
              shop_id: vs.shop_id || '',
              shop_name: vs.shop_name,
              shop_url: vs.shop_url,
              is_active: Boolean(vs.is_active),
              last_item_count: null
            });
            existingUrls.add(vs.shop_url);
          }
        }

        await chrome.storage.local.set({ shops: merged });
        renderShops(merged);
        alert(`Đã đồng bộ thành công! Hiện có tổng cộng ${merged.length} shop.`);
      } else {
        alert('Không tìm thấy shop nào trên VPS.');
      }
    } catch (e) {
      alert(`Lỗi kết nối tới VPS: ${e.message}\nHãy kiểm tra xem VPS có đang online tại port 3000 không.`);
    } finally {
      btnSyncVps.disabled = false;
      btnSyncVps.innerHTML = '<span class="icon">☁️</span> Đồng bộ từ VPS';
    }
  });

  // Save Settings
  btnSaveSettings.addEventListener('click', async () => {
    const teleToken = settingTeleToken.value.trim();
    const teleChatId = settingTeleChatId.value.trim();
    const vpsUrl = settingVpsUrl.value.trim();
    const intervalSeconds = parseInt(settingInterval.value, 10);

    await chrome.storage.local.set({
      teleToken,
      teleChatId,
      vpsUrl,
      intervalSeconds
    });

    cycleIntervalDisplay.textContent = `${intervalSeconds}s`;
    btnSaveSettings.textContent = '✅ Đã lưu thành công!';
    setTimeout(() => {
      btnSaveSettings.textContent = '💾 Lưu cài đặt';
    }, 1500);
  });

  // Test Telegram Button
  btnTestTele.addEventListener('click', () => {
    const token = settingTeleToken.value.trim();
    const chatId = settingTeleChatId.value.trim();
    btnTestTele.disabled = true;
    btnTestTele.textContent = '⏳ Đang gửi...';

    chrome.runtime.sendMessage({ action: 'test_telegram', token, chatId }, (resp) => {
      setTimeout(() => {
        btnTestTele.disabled = false;
        btnTestTele.textContent = '✉️ Gửi tin nhắn kiểm tra thử';
      }, 1500);
    });
  });

  // Listen for storage changes
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.logs) renderLogs(changes.logs.newValue || []);
    if (changes.shops) renderShops(changes.shops.newValue || []);
    if (changes.newProductsToday) newProductsToday.textContent = changes.newProductsToday.newValue || 0;
    if (changes.lastCheckTime) lastCheckTime.textContent = changes.lastCheckTime.newValue || 'Vừa xong';
  });

  // Helper Functions
  function applyState(data) {
    masterToggle.checked = data.isActive !== false;
    updateStatusDisplay(data.isActive !== false);

    const shops = data.shops || [];
    totalShopsCount.textContent = shops.length;
    tabShopsCount.textContent = shops.length;
    newProductsToday.textContent = data.newProductsToday || 0;
    cycleIntervalDisplay.textContent = `${data.intervalSeconds || 10}s`;
    lastCheckTime.textContent = data.lastCheckTime || 'Chưa quét';

    settingTeleToken.value = data.teleToken || '';
    settingTeleChatId.value = data.teleChatId || '';
    settingVpsUrl.value = data.vpsUrl || 'http://36.50.26.72:3000';
    settingInterval.value = String(data.intervalSeconds || 10);

    renderLogs(data.logs || []);
    renderShops(shops);
  }

  function updateStatusDisplay(isActive) {
    if (isActive) {
      statusBadge.className = 'stat-value status-active';
      statusText.textContent = 'Đang chạy';
    } else {
      statusBadge.className = 'stat-value status-paused';
      statusText.textContent = 'Tạm dừng';
    }
  }

  function renderLogs(logs) {
    if (!logs || logs.length === 0) {
      logsList.innerHTML = '<div class="log-entry log-info"><span class="log-time">[Hệ thống]</span> Chưa có nhật ký hoạt động.</div>';
      return;
    }
    logsList.innerHTML = logs
      .map(
        (l) =>
          `<div class="log-entry log-${l.type || 'info'}"><span class="log-time">[${l.time}]</span> ${escapeHtml(
            l.message
          )}</div>`
      )
      .join('');
  }

  function renderShops(shops) {
    totalShopsCount.textContent = shops.length;
    tabShopsCount.textContent = shops.length;

    if (!shops || shops.length === 0) {
      shopsListContainer.innerHTML = '<div class="empty-state">Chưa có shop nào. Hãy thêm shop hoặc nhấn "Đồng bộ từ VPS"!</div>';
      return;
    }

    shopsListContainer.innerHTML = shops
      .map(
        (s) => `
        <div class="shop-item" data-id="${s.id}">
          <div class="shop-item-info">
            <span class="shop-item-title">${escapeHtml(s.shop_name)}</span>
            <span class="shop-item-meta">ID: ${s.shop_id || 'Chưa định danh'} &bull; ${s.last_item_count !== null ? s.last_item_count + ' SP' : 'Đang quét'}</span>
          </div>
          <div class="shop-item-actions">
            <button class="btn-del" title="Xóa shop" data-del-id="${s.id}">🗑️</button>
          </div>
        </div>
      `
      )
      .join('');

    // Attach delete listeners
    document.querySelectorAll('.btn-del').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const id = parseInt(e.currentTarget.dataset.delId, 10);
        const { shops = [] } = await chrome.storage.local.get('shops');
        const updated = shops.filter((s) => s.id !== id);
        await chrome.storage.local.set({ shops: updated });
        renderShops(updated);
      });
    });
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  async function refreshDisplay() {
    const data = await chrome.storage.local.get(null);
    applyState(data);
  }
});
