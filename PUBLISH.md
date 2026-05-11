# Hướng dẫn Public Redmine Connector lên VS Code Marketplace

## Chuẩn bị

- Node.js đã cài
- Cài `vsce`: `npm install -g @vscode/vsce`
- Tài khoản Microsoft (cá nhân hoặc công ty)

---

## Bước 1 — Tạo Publisher Account

1. Vào [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)
2. Đăng nhập bằng tài khoản Microsoft
3. Nhấn **Create publisher**
4. Điền thông tin:
   - **ID**: tên định danh duy nhất, ví dụ `hoangthiep` (chữ thường, không dấu cách) — cái này sẽ xuất hiện trong extension ID
   - **Display name**: tên hiển thị trên Marketplace, ví dụ `Hoang Thiep`
5. Nhấn **Create**

---

## Bước 2 — Tạo Personal Access Token (PAT)

1. Vào [dev.azure.com](https://dev.azure.com), đăng nhập cùng tài khoản Microsoft
2. Nhấn avatar góc trên phải → **Personal access tokens**
3. Nhấn **New Token**
4. Cấu hình:
   - **Name**: đặt tên tuỳ ý, ví dụ `vsce-publish`
   - **Organization**: chọn **All accessible organizations**
   - **Expiration**: 1 year
   - **Scopes**: chọn **Custom defined** → tích **Marketplace → Manage**
5. Nhấn **Create** — **copy token ngay**, nó chỉ hiện 1 lần duy nhất

---

## Bước 3 — Cập nhật `package.json`

Mở file `vscode-extension/package.json`, cập nhật 2 trường sau:

```json
{
  "publisher": "id-publisher-của-bạn",
  "repository": {
    "type": "git",
    "url": "https://github.com/your-username/your-repo"
  }
}
```

> `publisher` phải khớp chính xác với Publisher ID đã tạo ở Bước 1.

---

## Bước 4 — Đăng nhập và Publish

Mở terminal, chạy lần lượt:

```bash
cd vscode-extension

# Đăng nhập với publisher ID của bạn
vsce login id-publisher-của-bạn
# Dán PAT từ Bước 2 khi được hỏi

# Publish lên Marketplace
vsce publish
```

`vsce` sẽ tự động build, đóng gói và upload. Sau khi xong sẽ hiện link xác nhận.

---

## Bước 5 — Kiểm tra trên Marketplace

- Extension sẽ xuất hiện tại:
  `https://marketplace.visualstudio.com/items?itemName=id-publisher-của-bạn.redmine-connector`
- Thường **5–10 phút** là live
- **Cursor** dùng chung Marketplace với VS Code → tự động có luôn, không cần làm thêm gì

---

## Khi phát hành phiên bản mới

1. Tăng version trong `package.json` (ví dụ `1.0.1` → `1.0.2`)
2. Cập nhật Release Notes trong `README.md`
3. Chạy:

```bash
cd vscode-extension
vsce publish
```

Hoặc tăng version tự động:

```bash
vsce publish patch   # 1.0.1 → 1.0.2  (sửa lỗi nhỏ)
vsce publish minor   # 1.0.1 → 1.1.0  (tính năng mới)
vsce publish major   # 1.0.1 → 2.0.0  (thay đổi lớn)
```

---

## Checklist trước khi publish

- [ ] `publisher` trong `package.json` khớp với Publisher ID trên Marketplace
- [ ] `repository` URL đã được điền
- [ ] Version number đúng
- [ ] README không có ảnh bị broken
- [ ] Đã test với file `.vsix` mới nhất
- [ ] Release Notes đã cập nhật trong `README.md`

---

## Links hữu ích

- [VS Code Marketplace — Manage](https://marketplace.visualstudio.com/manage)
- [Azure DevOps — Personal Access Tokens](https://dev.azure.com)
- [Tài liệu vsce chính thức](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
