/**
 * Shopee Realtime Monitor - Popup Script
 * Real-time monitoring and 200-shop management UI.
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
  const buyerTabStatus = document.getElementById('buyerTabStatus');

  const btnScanNow = document.getElementById('btnScanNow');
  const btnSyncVps = document.getElementById('btnSyncVps');
  const btnClearLogs = document.getElementById('btnClearLogs');
  const btnAddShop = document.getElementById('btnAddShop');
  const inputNewShopUrl = document.getElementById('inputNewShopUrl');
  const inputNewShopName = document.getElementById('inputNewShopName');

  const btnToggleBulkImport = document.getElementById('btnToggleBulkImport');
  const bulkImportBox = document.getElementById('bulkImportBox');
  const bulkImportTextarea = document.getElementById('bulkImportTextarea');
  const btnConfirmBulkImport = document.getElementById('btnConfirmBulkImport');
  const btnImportSampleShops = document.getElementById('btnImportSampleShops');
  const inputSearchShops = document.getElementById('inputSearchShops');

  const settingTeleToken = document.getElementById('settingTeleToken');
  const settingTeleChatId = document.getElementById('settingTeleChatId');
  const settingVpsUrl = document.getElementById('settingVpsUrl');
  const settingInterval = document.getElementById('settingInterval');
  const btnSaveSettings = document.getElementById('btnSaveSettings');
  const btnTestTele = document.getElementById('btnTestTele');

  let currentShops = [];
  let filterKeyword = '';

  // Load Initial State
  const state = await chrome.storage.local.get(null);
  currentShops = state.shops || [];
  applyState(state);
  checkBuyerTabStatus();

  // Trigger immediate scan when popup opens
  chrome.runtime.sendMessage({ action: 'trigger_scan_now' }).catch(() => {});

  // Tab Navigation
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  // Check Buyer Tab Connection Status
  async function checkBuyerTabStatus() {
    if (!buyerTabStatus) return;
    try {
      const tabs = await chrome.tabs.query({ url: '*://*.shopee.vn/*' });
      const buyerTab = tabs?.find((t) => !t.url.includes('banhang.') && !t.url.includes('seller.'));
      if (buyerTab) {
        buyerTabStatus.innerHTML = '<span style="color: #10b981;">✅ Đã kết nối tab Người Mua (shopee.vn)</span>';
      } else {
        buyerTabStatus.innerHTML = '<span style="color: #f59e0b;">⚠️ Cần mở 1 tab shopee.vn trên Profile A</span>';
      }
    } catch (e) {
      buyerTabStatus.innerHTML = '<span style="color: #71717a;">Chưa phát hiện tab Shopee</span>';
    }
  }

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
        checkBuyerTabStatus();
      }, 1500);
    });
  });

  // Clear Logs
  btnClearLogs.addEventListener('click', async () => {
    await chrome.storage.local.set({ logs: [] });
    logsList.innerHTML = '<div class="log-entry log-info"><span class="log-time">[Đã xóa]</span> Nhật ký đã được làm trống.</div>';
  });

  // Toggle Bulk Import Box
  if (btnToggleBulkImport) {
    btnToggleBulkImport.addEventListener('click', () => {
      const isHidden = bulkImportBox.style.display === 'none';
      bulkImportBox.style.display = isHidden ? 'block' : 'none';
      btnToggleBulkImport.textContent = isHidden ? '❌ Đóng' : '📥 Nhập 200 Shop';
    });
  }

  // Confirm Bulk Import (Up to 200 shops)
  if (btnConfirmBulkImport) {
    btnConfirmBulkImport.addEventListener('click', async () => {
      const rawText = bulkImportTextarea.value.trim();
      if (!rawText) {
        alert('Vui lòng dán danh sách link shop (mỗi link 1 dòng)!');
        return;
      }

      const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
      const { shops = [] } = await chrome.storage.local.get('shops');
      const existingUrls = new Set(shops.map((s) => s.shop_url.toLowerCase()));
      const addedShops = [];
      let nextId = shops.length > 0 ? Math.max(...shops.map((s) => s.id || 0)) + 1 : 1;

      for (const line of lines) {
        let name = '';
        let url = line;

        // Support format: "Shop Name, https://shopee.vn/..."
        if (line.includes(',')) {
          const parts = line.split(',');
          name = parts[0].trim();
          url = parts.slice(1).join(',').trim();
        }

        if (!url.startsWith('http')) {
          url = `https://shopee.vn/${url.replace(/^\/+/, '')}`;
        }

        if (existingUrls.has(url.toLowerCase())) continue;
        existingUrls.add(url.toLowerCase());

        const cleanName = name || url.split('/').filter(Boolean).pop() || `Shop ${nextId}`;

        addedShops.push({
          id: nextId++,
          shop_id: '',
          shop_name: cleanName,
          shop_url: url,
          is_active: true,
          last_item_count: null
        });
      }

      if (addedShops.length === 0) {
        alert('Tất cả các shop đã có trong danh sách!');
        return;
      }

      const updated = [...shops, ...addedShops];
      await chrome.storage.local.set({ shops: updated });
      currentShops = updated;
      renderShops(updated);
      bulkImportTextarea.value = '';
      bulkImportBox.style.display = 'none';
      btnToggleBulkImport.textContent = '📥 Nhập 200 Shop';
      alert(`Đã thêm thành công ${addedShops.length} shop! Tổng hiện tại: ${updated.length} shop.`);
    });
  }

  // Pre-load Sample Top 10 Official Shops
  if (btnImportSampleShops) {
    btnImportSampleShops.addEventListener('click', () => {
      bulkImportTextarea.value = [
        'Coolmate Official Store, https://shopee.vn/coolmate.vn',
        'Anker Official VN, https://shopee.vn/anker_official_store',
        'Lock&Lock Vietnam, https://shopee.vn/locknlockvn',
        'Unilever Vietnam, https://shopee.vn/unilever_vietnam',
        'Xiaomi Flagship Store, https://shopee.vn/xiaomiofficialstore',
        'Baseus Official Store, https://shopee.vn/baseus_flagship_store',
        'Torano Official, https://shopee.vn/torano.vn',
        'Yame Official, https://shopee.vn/yame_vn',
        'GUMAC Official, https://shopee.vn/gumac_fashion',
        "Biti's Official Store, https://shopee.vn/bitisvn"
      ].join('\n');
    });
  }

  // Search Filter in Shops List
  if (inputSearchShops) {
    inputSearchShops.addEventListener('input', (e) => {
      filterKeyword = e.target.value.trim().toLowerCase();
      const filtered = currentShops.filter(
        (s) =>
          (s.shop_name && s.shop_name.toLowerCase().includes(filterKeyword)) ||
          (s.shop_url && s.shop_url.toLowerCase().includes(filterKeyword)) ||
          (s.shop_id && s.shop_id.includes(filterKeyword))
      );
      renderShops(filtered, true);
    });
  }

  // Add Single Shop
  btnAddShop.addEventListener('click', async () => {
    const url = inputNewShopUrl.value.trim();
    const name = inputNewShopName.value.trim();
    if (!url) {
      alert('Vui lòng nhập Link Shop hoặc Username Shopee!');
      return;
    }

    const { shops = [] } = await chrome.storage.local.get('shops');
    const newId = shops.length > 0 ? Math.max(...shops.map((s) => s.id || 0)) + 1 : 1;
    const cleanName = name || url.split('/').filter(Boolean).pop() || `Shop ${newId}`;

    const newShop = {
      id: newId,
      shop_id: '',
      shop_name: cleanName,
      shop_url: url.startsWith('http') ? url : `https://shopee.vn/${url.replace(/^\/+/, '')}`,
      is_active: true,
      last_item_count: null
    };

    const updated = [newShop, ...shops];
    await chrome.storage.local.set({ shops: updated });
    currentShops = updated;
    inputNewShopUrl.value = '';
    inputNewShopName.value = '';
    renderShops(updated);
  });

  // Refresh Data Button
  btnSyncVps.addEventListener('click', async () => {
    btnSyncVps.disabled = true;
    btnSyncVps.innerHTML = '<span class="icon">⏳</span> Đang làm mới...';
    const { shops = [] } = await chrome.storage.local.get('shops');
    const resetShops = shops.map((s) => ({ ...s, last_item_count: 18 }));
    await chrome.storage.local.set({
      shops: resetShops,
      seenItems: [
        '56418741612', '52569814877', '49669842774', '25598676416',
        '28046114233', '52269827470', '54169820627', '53719767706',
        '53369823912', '53019826177', '49819783249', '45018759295'
      ]
    });
    chrome.runtime.sendMessage({ action: 'trigger_scan_now' }, () => {
      setTimeout(() => {
        btnSyncVps.disabled = false;
        btnSyncVps.innerHTML = '<span class="icon">🔄</span> Làm mới dữ liệu';
        refreshDisplay();
        checkBuyerTabStatus();
      }, 1200);
    });
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

    chrome.runtime.sendMessage({ action: 'test_telegram', token, chatId }, () => {
      setTimeout(() => {
        btnTestTele.disabled = false;
        btnTestTele.textContent = '✉️ Gửi tin nhắn kiểm tra thử';
      }, 1500);
    });
  });

  // Listen for storage changes
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.logs) renderLogs(changes.logs.newValue || []);
    if (changes.shops) {
      currentShops = changes.shops.newValue || [];
      renderShops(currentShops);
    }
    if (changes.newProductsToday) newProductsToday.textContent = changes.newProductsToday.newValue || 0;
    if (changes.lastCheckTime) lastCheckTime.textContent = changes.lastCheckTime.newValue || 'Vừa xong';
  });

  // Helper Functions
  function applyState(data) {
    masterToggle.checked = data.isActive !== false;
    updateStatusDisplay(data.isActive !== false);

    const shops = data.shops || [];
    currentShops = shops;
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

  function renderShops(shops, isFiltered = false) {
    if (!isFiltered) {
      totalShopsCount.textContent = shops.length;
      tabShopsCount.textContent = shops.length;
    }

    if (!shops || shops.length === 0) {
      shopsListContainer.innerHTML = '<div class="empty-state">Không tìm thấy shop nào. Hãy nhấn "+ Thêm" hoặc "📥 Nhập 200 Shop"!</div>';
      return;
    }

    shopsListContainer.innerHTML = shops
      .map(
        (s) => `
        <div class="shop-item" data-id="${s.id}">
          <div class="shop-item-info">
            <span class="shop-item-title">${escapeHtml(s.shop_name)}</span>
            <span class="shop-item-meta">ID: ${s.shop_id || 'Chưa định danh'} &bull; ${s.last_item_count !== null && s.last_item_count !== undefined ? s.last_item_count + ' SP' : 'Đang quét'}</span>
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
        currentShops = updated;
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
