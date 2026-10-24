# Shopee New Product Monitor + Telegram Bot

Hệ thống tự động theo dõi danh sách lên đến 200 shop trên Shopee Việt Nam, phát hiện sản phẩm mới đăng và gửi thông báo tức thời qua Telegram Bot với chi phí vận hành 0đ, lưu trữ SQLite bền vững và hỗ trợ chạy liên tục 24/7 trên Windows hoặc VPS Linux.

---

## 1. Báo cáo tính khả thi nguồn dữ liệu Shopee VN (Giai đoạn A)

Trong quá trình phân tích và thử nghiệm trực tiếp (`scripts/test-shopee-source.ts`):
1. **Shopee Open Platform API (Chính thức)**: Chỉ cấp quyền quản lý sản phẩm cho **chính chủ sở hữu shop** (yêu cầu OAuth Authorize từ shop). Không thể dùng để đọc sản phẩm của 200 shop bên ngoài mà không có ủy quyền.
2. **Shopee Web Public API (`/api/v4/...`)**:
   - Shopee kích hoạt lá chắn bảo vệ WAF (Anti-Bot Shield).
   - Khi gửi HTTP request thông thường không có phiên làm việc trình duyệt, Shopee trả về:
     `HTTP 403 {"error": 90309999, "action_type": 2, "redirect_to_error_page": true}`
   - **Giải pháp**: Kiến trúc hệ thống áp dụng **Provider Pattern** (`IShopeeProvider`):
     - **`ShopeeHttpProvider`**: Hỗ trợ truyền cookie trình duyệt hợp lệ (`SHOPEE_COOKIE`) qua biến môi trường để vượt qua WAF kiểm tra; tự động nhận diện lỗi 90309999 để ghi log rõ ràng và không làm sập tiến trình.
     - **`MockShopeeProvider`**: Mô phỏng đầy đủ dữ liệu cho kiểm thử 100% độc lập, không phụ thuộc mạng hay anti-bot của Shopee.
     - **Khả năng mở rộng**: Dễ dàng cắm thêm proxy residential hoặc module Shopee Affiliate GraphQL / Puppeteer Stealth khi cần thiết.

---

## 2. Tính năng cốt lõi

- **Quản lý 200 shop**: Thêm từng shop bằng URL/Username hoặc nhập hàng loạt từ CSV. Tự động chuẩn hóa URL (bỏ param tracking `?sp_atk=...`, `?utm_...`) và lọc trùng lặp.
- **Phát hiện sản phẩm mới (Deduplication)**:
  - Lần đầu thêm shop: Lưu toàn bộ sản phẩm hiện có làm dữ liệu nền (`BASELINE`). Tuyệt đối **không spam thông báo**.
  - Các lần kiểm tra sau: Chỉ khi xuất hiện `item_id` mới chưa từng có trong DB mới đánh dấu `PENDING` và gửi Telegram.
  - Đổi giá hoặc đổi tên sản phẩm cũ: Chỉ cập nhật DB, **không báo trùng**.
- **Cơ chế Polling an toàn cho 200 shop**:
  - Giới hạn luồng đồng thời `MAX_CONCURRENT_REQUESTS=3` (không bắn ồ ạt).
  - Nghỉ giữa các request `REQUEST_DELAY_MS` kèm Jitter ngẫu nhiên tránh bị chặn IP.
  - Exponential Backoff khi gặp lỗi mạng hoặc HTTP 429.
  - Lỗi của 1 shop được ghi nhận vào `last_error` và tiếp tục kiểm tra shop khác, không dừng toàn bộ worker.
- **Telegram Bot thông minh**:
  - Gửi kèm hình ảnh sản phẩm (nếu có) hoặc tin nhắn văn bản định dạng HTML chuẩn mực.
  - Hỗ trợ cả tài khoản cá nhân lẫn **Telegram Group / Channel**.
  - Rate limiting (1 giây/tin) và retry tự động nếu Telegram gặp lỗi mạng.
- **Web Dashboard tối giản tích hợp sẵn**:
  - Truy cập ngay tại `http://localhost:3000`.
  - Xem tổng số shop, shop hoạt động, sản phẩm mới hôm nay, lịch sử quét và shop lỗi.
  - Thêm shop mới, bật/tắt theo dõi trực tiếp trên giao diện hoặc bấm "Quét ngay".

---

## 3. Cấu trúc thư mục

```
src/
  config/
    env.ts                  # Đọc và validate biến môi trường
  database/
    db.ts                   # Kết nối SQLite (WAL mode)
    schema.sql              # Định nghĩa bảng shops, products, check_runs
  providers/
    types.ts                # Interface chuẩn IShopeeProvider
    factory.ts              # Factory cấp phát provider theo cấu hình
    mock/
      mock-provider.ts      # Provider giả lập kiểm thử
    shopee/
      shopee-http-provider.ts # Provider kết nối Shopee VN + xử lý WAF
  modules/
    shops/
      shop-service.ts       # Thêm, bật/tắt, import/export CSV shop
    products/
      product-service.ts    # Phân loại baseline, phát hiện sản phẩm mới
    monitoring/
      monitor-engine.ts     # Engine điều phối kiểm tra 200 shop
  telegram/
    telegram-service.ts     # Gửi tin nhắn Telegram, xử lý rate limit & retry
  scheduler/
    monitor-worker.ts       # Worker chạy nền định kỳ
  dashboard/
    server.ts               # Web Dashboard & REST API
  utils/
    logger.ts               # Logger có lọc dữ liệu nhạy cảm
    time.ts                 # Định dạng ngày giờ VN, giá VNĐ, backoff jitter
    url.ts                  # Chuẩn hóa link Shopee
  index.ts                  # Điểm khởi chạy chính của hệ thống

scripts/
  run-all-tests.ts          # Bộ kiểm thử 9 kịch bản tự động
  test-shopee-source.ts     # Kiểm tra kết nối trực tiếp Shopee VN
  test-telegram.ts          # Kiểm tra bot Telegram
  import-shops.ts           # Import shop từ CSV hoặc thêm nhanh bằng CLI
  export-shops.ts           # Export danh sách shop ra CSV

data/
  sample-shops.csv          # File mẫu 10 shop Shopee
  monitor.db                # Database SQLite (tự tạo khi chạy)
```

---

## 4. Hướng dẫn cài đặt & Cấu hình

### 4.1. Yêu cầu môi trường
- **Node.js**: Phiên bản 18+ hoặc 20+ (đã xác thực hoạt động tốt trên Node v25).
- **pnpm**: Hoặc npm / yarn.

### 4.2. Cài đặt dependencies
```bash
pnpm install
```

### 4.3. Cấu hình biến môi trường
Tạo file `.env` từ file mẫu `.env.example`:
```bash
cp .env.example .env
```

Nội dung `.env`:
```env
# Token lấy từ @BotFather trên Telegram
TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ

# Chat ID người nhận hoặc Group ID (ví dụ: -100123456789)
TELEGRAM_CHAT_ID=-100123456789

# Chu kỳ kiểm tra (phút) - Khuyến nghị cho 200 shop: 10 - 15 phút
POLL_INTERVAL_MINUTES=10

# Số shop quét đồng thời (khuyến nghị: 2 - 3 để tránh nghẽn IP)
MAX_CONCURRENT_REQUESTS=3

# Thời gian nghỉ giữa các shop (ms)
REQUEST_DELAY_MS=1000

# File database SQLite
DATABASE_PATH=./data/monitor.db

# Nguồn dữ liệu: 'shopee-http' (thực tế) hoặc 'mock' (kiểm thử)
DATA_PROVIDER=shopee-http

# Cookie trình duyệt Shopee (nếu chạy shopee-http trực tiếp)
SHOPEE_COOKIE=

# Web Dashboard
ENABLE_DASHBOARD=true
DASHBOARD_PORT=3000

# Cấp độ ghi log
LOG_LEVEL=info
```

---

## 5. Hướng dẫn lấy Telegram Bot Token & Chat ID

1. **Lấy Bot Token**:
   - Mở Telegram, tìm bot `@BotFather`.
   - Gửi lệnh `/newbot`, đặt tên và username cho bot.
   - Sao chép chuỗi HTTP API Token nhận được vào `TELEGRAM_BOT_TOKEN`.
2. **Lấy Chat ID**:
   - **Gửi tin nhắn cá nhân**: Nhắn tin bất kỳ cho bot của bạn, sau đó mở trình duyệt vào:
     `https://api.telegram.org/bot<TOKEN>/getUpdates`
     Tìm mục `"chat":{"id": 123456789}` -> sao chép số này vào `TELEGRAM_CHAT_ID`.
   - **Gửi vào Telegram Group**:
     - Thêm bot vào Group của bạn.
     - Cấp quyền gửi tin nhắn cho bot.
     - Thêm bot `@RawDataBot` vào nhóm để xem Group ID (bắt đầu bằng dấu `-`, ví dụ `-1002345678901`).
     - Điền ID này vào `TELEGRAM_CHAT_ID`.

---

## 6. Các lệnh chạy thử nghiệm và kiểm thử

### 6.1. Chạy toàn bộ 9 kịch bản kiểm thử (Automated Unit & Integration Test)
```bash
pnpm test
```
*Script này kiểm tra độc lập tất cả các tình huống: Baseline, phát hiện SP mới, chống gửi trùng, cập nhật giá, Telegram lỗi & retry, lỗi mạng/timeout, Rate limit 429, phục hồi sau khi restart tiến trình, chuẩn hóa và lọc trùng CSV.*

### 6.2. Kiểm tra kết nối Telegram Bot
```bash
pnpm run test:telegram
```
*Gửi thử 1 tin nhắn định dạng chuẩn kèm hình ảnh đến Telegram để xác nhận cấu hình token và chat ID.*

### 6.3. Kiểm tra nguồn dữ liệu Shopee VN
```bash
pnpm run test:shopee
```
*Chẩn đoán kết nối thực tế tới Shopee VN và trạng thái WAF.*

---

## 7. Quản lý danh sách shop

### 7.1. Nhập hàng loạt shop từ CSV
Hệ thống đi kèm file mẫu `data/sample-shops.csv`.
Chạy lệnh:
```bash
pnpm run import:shops data/sample-shops.csv
```
*Hệ thống tự động bỏ qua các shop đã có, chuẩn hóa URL và ghi nhận shop mới.*

Định dạng file CSV (hỗ trợ cả dấu `,` hoặc `;`):
```csv
shop_name,shop_url
Coolmate Official Store,https://shopee.vn/coolmate.vn
Anker Official VN,https://shopee.vn/anker_official_store
Lock&Lock Vietnam,https://shopee.vn/locknlockvn
Xiaomi Flagship,https://shopee.vn/xiaomiofficialstore
```

### 7.2. Thêm nhanh một shop bằng CLI
```bash
pnpm run import:shops https://shopee.vn/coolmate.vn "Coolmate Official"
```

### 7.3. Xuất danh sách shop ra CSV
```bash
pnpm run export:shops data/danh-sach-shop.csv
```

---

## 8. Khởi chạy hệ thống

### 8.1. Chạy trên máy tính cá nhân (Windows / Mac)
```bash
pnpm start
```
Hệ thống sẽ:
1. Mở database SQLite (kích hoạt WAL mode).
2. Tải toàn bộ danh sách shop đang bật theo dõi.
3. Chạy vòng lặp kiểm tra ban đầu (lưu Baseline).
4. Khởi chạy worker chạy ngầm định kỳ theo `POLL_INTERVAL_MINUTES`.
5. Bật Web Dashboard tại `http://localhost:3000`.

### 8.2. Triển khai 24/7 trên VPS Linux (Ubuntu / Debian)

#### Cách 1: Sử dụng PM2 (Khuyến nghị - Dễ nhất)
1. Cài đặt PM2 trên VPS:
   ```bash
   npm install -g pm2
   ```
2. Khởi chạy ứng dụng:
   ```bash
   pm2 start "pnpm start" --name "shopee-monitor"
   ```
3. Thiết lập tự khởi động cùng hệ thống khi VPS reboot:
   ```bash
   pm2 startup
   pm2 save
   ```
4. Các lệnh quản lý PM2:
   - Xem log theo thời gian thực: `pm2 logs shopee-monitor`
   - Xem trạng thái CPU/RAM: `pm2 status`
   - Khởi động lại: `pm2 restart shopee-monitor`
   - Dừng: `pm2 stop shopee-monitor`

#### Cách 2: Sử dụng Systemd Service (Chuẩn Linux)
Tạo file `/etc/systemd/system/shopee-monitor.service`:
```ini
[Unit]
Description=Shopee New Product Monitor Worker
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/var/www/shopee-monitor
ExecStart=/usr/bin/pnpm start
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```
Sau đó bật service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable shopee-monitor
sudo systemctl start shopee-monitor
sudo systemctl status shopee-monitor
```

---

## 9. Mẫu thông báo gửi về Telegram

Khi phát hiện sản phẩm mới, bot sẽ gửi ảnh bìa sản phẩm (nếu có) kèm nội dung:

```
🆕 SẢN PHẨM MỚI TRÊN SHOPEE

🏪 Shop: Coolmate Official Store

📦 Sản phẩm: Áo Polo Nam Thể Thao Pro Active Siêu Nhẹ

💰 Giá: 249.000 ₫

🔗 Link sản phẩm: https://shopee.vn/product/469064007/1001

🕒 Phát hiện lúc: 23/10/2026 21:05:00
```
