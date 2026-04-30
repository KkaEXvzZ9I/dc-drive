# Discord Drive

Discord Drive 是一個自架的 Discord 雲端硬碟面板。使用者透過 Discord OAuth2 登入後，可以在網頁上傳、預覽、下載、收藏與刪除檔案；伺服器會把檔案切成 chunks，再透過 Discord webhook 上傳到每位使用者專屬的 Discord 頻道。

## 功能

- Discord OAuth2 登入，使用 `identify` scope。
- 第一個登入的帳號會自動成為管理員。
- 管理員可在左側邊欄的 **帳號管理** 中設定管理員、降級使用者、停用或啟用帳號。
- 每位使用者建立一個專屬 Discord 文字頻道。
- 每位使用者頻道建立一個 webhook，用來上傳檔案 chunks。
- 支援瀏覽器分段上傳，避免單檔超過 Discord 附件限制。
- 支援圖片、影片、音訊、PDF、文字檔預覽。
- 支援 range streaming，圖片與影片預覽可以正常拖曳讀取。
- 支援檔案搜尋、排序、收藏、重新命名、複製下載連結與批次刪除。

## 需求

- Node.js 20 或更新版本。
- 一個 Discord Application。
- Discord Application 內啟用 Bot。
- 一個專門存放檔案 chunks 的 Discord Server/Guild。
- Bot 需要加入該 Guild。

Bot 權限最簡單可以先給 `Administrator`。如果要收斂權限，至少需要：

- Manage Channels
- Manage Webhooks
- Manage Roles
- View Channel
- Send Messages
- Attach Files
- Read Message History

## Discord 設定

1. 到 Discord Developer Portal 建立 Application。
2. 在 OAuth2 設定中加入 Redirect URL：

```text
http://localhost:8787/auth/callback
```

3. 記下 Application 的 Client ID 與 Client Secret。
4. 建立 Bot，記下 Bot Token。
5. 把 Bot 加到你的 storage guild。
6. 記下該 Guild ID。
7. 如果想把使用者頻道集中到某個分類，另外填入 Category ID。

## 安裝與啟動

目前專案沒有額外 npm dependencies，但仍建議先確認 Node 版本：

```bash
node --version
```

複製環境變數範本：

```bash
copy .env.example .env
```

填好 `.env`：

```env
PORT=8787
PUBLIC_BASE_URL=http://localhost:8787

DISCORD_CLIENT_ID=your_discord_application_client_id
DISCORD_CLIENT_SECRET=your_discord_application_client_secret
DISCORD_REDIRECT_URI=http://localhost:8787/auth/callback

DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_GUILD_ID=your_storage_guild_id
DISCORD_CATEGORY_ID=

SESSION_SECRET=replace_with_a_long_random_secret
CHUNK_SIZE_BYTES=8388608
DATA_DIR=./data
```

啟動：

```bash
npm start
```

開啟：

```text
http://localhost:8787
```

## 帳號管理

第一次成功登入的 Discord 帳號會自動成為管理員。

管理員登入後，左側邊欄會出現 **帳號管理** 按鈕，位置在檔案類型篩選下方、上傳佇列上方。管理員可以：

- 查看所有登入過的帳號。
- 將使用者設為管理員。
- 將管理員改回一般使用者。
- 停用帳號。
- 重新啟用帳號。

系統會避免管理員停用自己，或把最後一個可用管理員降級，避免整個面板失去管理權限。

如果是舊資料升級，server 啟動時會自動補上角色；若沒有任何管理員，會把最早建立或最早登入的帳號設為管理員。

## 資料儲存

本機 metadata 存在：

```text
data/store.json
```

這個檔案包含：

- users
- roles
- sessions
- files
- chunk hashes
- Discord message IDs
- Discord attachment IDs
- webhook credentials

真正的檔案 bytes 會存在 Discord message attachments。下載與預覽時，伺服器會透過儲存的 message ID 重新向 Discord 取得目前可用的 attachment URL，再把內容串流回瀏覽器。

請保護好 `data/store.json` 與 `.env`，不要公開或提交到公開 repo。

## 環境變數

| 變數 | 說明 |
| --- | --- |
| `PORT` | HTTP server port，預設 `8787`。 |
| `PUBLIC_BASE_URL` | 瀏覽器使用的公開網址。 |
| `DISCORD_CLIENT_ID` | Discord Application Client ID。 |
| `DISCORD_CLIENT_SECRET` | Discord Application Client Secret。 |
| `DISCORD_REDIRECT_URI` | Discord OAuth2 callback URL。 |
| `DISCORD_BOT_TOKEN` | Discord Bot Token，用於建立頻道、建立 webhook、讀取 webhook message。 |
| `DISCORD_GUILD_ID` | 存放檔案 chunks 的 Discord Guild ID。 |
| `DISCORD_CATEGORY_ID` | 選填，使用者 storage channel 要放入的 category ID。 |
| `SESSION_SECRET` | Cookie 簽章用 secret，正式使用請換成長且隨機的字串。 |
| `SESSION_MAX_AGE_SECONDS` | 登入 session 有效秒數，預設 14 天。 |
| `CHUNK_SIZE_BYTES` | 每個 chunk 大小，預設 8 MiB。 |
| `DATA_DIR` | 本機 metadata 資料夾，預設 `./data`。 |

## Discord 限制

Discord 預設附件上傳限制通常是 10 MiB，因此預設 chunk size 是 8 MiB，保守避開限制。如果你的 guild 有更高上限，可以調整 `CHUNK_SIZE_BYTES`。

Discord webhook 和 API 都有 rate limit。此專案會依 Discord retry header 等待重試，但大量上傳仍可能變慢。

Discord attachment CDN URL 可能過期，所以本專案不直接永久保存 CDN URL，而是保存 message 與 attachment metadata，需要讀取時再重新取得。

## 指令

```bash
npm start
```

啟動 server。

```bash
npm run dev
```

同樣啟動 server，方便開發時使用。

```bash
npm test
```

執行 Node test runner 的測試。

## 常見問題

### 看不到帳號管理

只有管理員看得到 **帳號管理**。請確認：

- 你是第一個登入的帳號，或已被其他管理員設為管理員。
- `data/store.json` 中你的使用者資料有 `"role": "admin"`。
- 修改資料後有重新整理頁面。

### 登入後回到首頁但沒有成功進入面板

請確認：

- Discord Developer Portal 的 Redirect URL 與 `.env` 的 `DISCORD_REDIRECT_URI` 完全一致。
- `PUBLIC_BASE_URL` 與目前開啟的網址一致。
- `SESSION_SECRET` 有設定且 server 沒有在登入流程中途換掉。

### 上傳失敗

請確認：

- Bot 還在 storage guild 裡。
- Bot 有建立 channel 與 webhook 的權限。
- `CHUNK_SIZE_BYTES` 沒有超過 Discord 附件上限。
- `data/store.json` 可正常寫入。
