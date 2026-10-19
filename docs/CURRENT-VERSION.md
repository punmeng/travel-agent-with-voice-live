# 本機版本交接：2026-10-19

本文件記錄目前已保存的本機版本，不是Azure部署計畫或正式發行聲明。套件為`meihao-airlines` **0.1.0**；沒有為收尾任意增加版本號。

## 實際運行與完成範圍

2026-10-19收尾時，唯讀`GET http://127.0.0.1:3100/api/health`回傳`ok=true`、`mode=foundry`、`build=6b6814aca5deb4b2`、`voice.available=true`、`voice.type=azure-personal`。這是已載入程式的識別，不是Git SHA，也不代表重新驗證所有Azure依賴、真人麥克風或聲音正確性。收尾沒有重啟3100。

| 已交付項目 | 目前行為與界線 |
|---|---|
| 繁中聊天 | 梅好 Airlines風格但非官方；原生Node HTTP與瀏覽器modules，無前端build；聊天完成探索、五天等規劃、選班與模擬結帳 |
| 四代理 | 後端協調intent／planner／flight／price；不是自主A2A。意圖摘取、地理／日期解析、權威旅程與工具權限仍由後端控制 |
| 同源票價工具／MCP | 共用strict handler；有界機場／日期搜尋，選班、expiry、reprice、完整報價呈現、明確同意及冪等模擬確認 |
| 城市／機場維護 | 43城市群組、45參考機場、122別名關係；支援多機場集合、排除及跨國同名澄清；地理會員不代表航空營運資格 |
| Voice Live | 真正Azure收音／轉錄與exact-text合成，與文字共用旅程；mute／stop、只讀插話取消、過時回覆隔離、交易lock不假回滾 |
| Personal Voice | 同一既有資源，明確`azure-personal`／`DragonLatestNeural`；沒有錯誤fallback、訓練／錄音上傳或新聲音佈建 |
| 語音角色標籤 | Voice Live面板顯示實際意圖協調／旅遊規劃／航班查詢／票價與購買；等待、完成、錯誤／停止及過時事件有明確處理，不增加雲端呼叫 |
| 對話呈現 | 每則canonical回答最多50 meaningful words，長內容可「繼續」；文字／語音共用100個成功回合，15秒等待提示不另開語音／模型回覆 |

目前既有Foundry agent refs為：

| 角色 | 名稱 | 版本 |
|---|---|---|
| intent | `meihao-intent-agent` | 6 |
| planner | `meihao-travel-planner-agent` | 6 |
| flight | `meihao-flight-checker-agent` | 7 |
| price | `meihao-price-purchase-agent` | 5 |

它們使用既有`gpt-5.4`部署及四個managed vector stores；沒有為收尾重新部署或管理GET核驗。詳細先前驗證與工具清單見[Foundry指南](FOUNDRY.md)。新環境不能只複製名稱就假定有權限。

## 資料、語音與交易事實

合成資料涵蓋**2026-10-16至2027-02-12**：45參考機場、86條有向假設DEMO路線、20,640 dated flights、48,000 fare rows。DEMO／非codeshare標記只是示範約束，**不是完整或已核驗的梅好 Airlines航網**。`DEMO-FLT-*`不是實際班號；價格、機位、行程時間及模擬付款皆不可當作真實可售供應。沒有付款、訂位、開票、退款或護照／卡號收集。

靜態知識可解釋合成資料，但不能代替工具查價、reprice或同意。既有15個TXT知識快照由manifest列出；重新索引／上傳仍需另外核准付費，不是重現離線版本的必要步驟。

發音只改送往exact-text合成的文字，不改畫面／工具識別碼與報價：

| canonical內容 | 語音正規化例 |
|---|---|
| `DEMO101`／`DEMO0101` | `D，E，M，O，一，零，一`／`D，E，M，O，零，一，零，一`，保留前置零與I／1差別 |
| `TPE`／`DEMO-FLT-30` | 字母逐個拼；後者保留模擬意義及三、零，不讀英文百位數 |
| `2026-11-25T08:30` | 二零二六年十一月二十五日上午八點三十分 |
| `11/26–11/30` | 十一月二十六號到十一月三十號；亦支援`-`、`—`、`~`、`～` |
| `TWD 12,300` | 新臺幣一萬二千三百元 |
| secured checkout URL | 只說「結帳連結已放在對話中」，畫面連結保留原值，不朗讀token／query |

一般英文單字不盲目拆字；受維護的時區路徑改讀當地時間標籤。正規化只執行一次；50詞限制canonical答案，不能截掉發音展開後的必要金額、日期、版本或期限。Personal Voice的`name`須為同資源Personal Voices API回傳的**voice資源id**，不是入口網站顯示名，也不是SSML speakerProfileId；實值只留私人後端設定。過往合成音訊已取得，聲學正確性與相似度仍須本人試聽；既有私人WAV未包含後加的月日區間規則，本次沒有付費重合成。

## 重現與維護

需要Node.js >=22。此開發機`.env`為已核准的付費foundry模式；**離線重現不要直接沿用該設定**。在乾淨副本使用下列方式啟動，不讀取私人`.env`：

```powershell
Set-Location C:\Code\travelagent
npm DEMO
$env:APP_MODE = 'mock'
$env:VOICE_LIVE_ENABLED = 'false'
$env:PAYMENT_PROVIDER = 'mock'
$env:PORT = '3102'
node server.js
```

開啟`http://127.0.0.1:3102`；Ctrl+C停止自己啟動的程序。3102是重現示例，沒有在本次收尾啟動第二個服務。mock僅有有限離線語句；不宣稱與真實GPT任意對話相同。`npm start`會載入`.env`，只有明確同意live用量後才使用既有私人設定。通用`.env.example`維持mock／Voice關閉，不含私人voice id或憑證。跨shell設定不會自動保留。

Excel範本為`data\templates\city-airport-mapping.xlsx`。維護需要Python3與`openpyxl==3.1.5`；若缺少依賴，只使用組織核准的Microsoft-protected feed：

```powershell
python -m pip install --index-url https://packagefeedproxy.microsoft.io/pypi/simple/ -r scripts\requirements-workbook.txt
node scripts\import-city-airports.js .\data\templates\city-airport-mapping.xlsx
# 明確決定替換完整地理快照後才執行：
node scripts\import-city-airports.js .\data\templates\city-airport-mapping.xlsx --apply
```

dry run整本驗證不寫檔；apply只原子替換`data\city-airport-import.json`，不生成可售路線／票價。服務下次受控重啟才載入，須先提醒旅程遺失。完整欄位、禁止公式／巨集與限制見[對照維護](CITY-AIRPORT-MAPPING.md)。

離線檢查命令：

```powershell
npm run check
npm run check:mapping-voice
npm test
npm run test:ui
```

Playwright自開mock 3101，與3100分開；若缺瀏覽器，依組織核准下載政策準備Chromium後再執行。沒有前端build指令。不要為重現版本執行`deploy:agents`、`ingest:knowledge`、`test:voice:live`或任何含`--apply`的雲端腳本；那些會修改服務或產生費用。

## 本次驗證與間歇性問題紀錄

初次收尾檢查曾有`tests\city-airports.test.js:102`的XLSX reader約30秒逾時：`Workbook reader unavailable: spawnSync python ETIMEDOUT`；隔離整個city測試檔亦重現一次。重新取得版本收尾授權後，同樣wrapper直接執行約2.8秒，四次連續Python reader約2.7–3.1秒皆成功，單獨XLSX測試通過；其後完整suite **79/79通過**。**未證明先前逾時的根因、未宣稱修復，也沒有增加timeout或略過測試**。若重現，需調查Python啟動／當時資源狀況；不能以本次通過保證不再出現。

最終離線驗證：`npm run check`、`npm run check:mapping-voice`通過，`npm test`79/79通過，`npm run test:ui`8/8通過。涵蓋發音／月日區間、角色標籤、搜尋、報價／同意、同源MCP、語音取消與交易界線；UI使用mock transport，不能證明真人音訊／live可用。本次沒有重新執行官方SDK原型或付費推論／合成，沒有重新安裝依賴或重啟3100。

為公開分享而移除管理腳本硬編碼的私人endpoint；新增留白即拒絕的`FOUNDRY_APPROVED_PROJECT_ENDPOINT`，與目標完全一致才允許進入既有管理流程。新增離線測試確認留白／不符皆零寫入。私人`.env`不修改，live服務不重啟；這不是新增雲端功能或部署授權。Node lockfile保留既有Microsoft-protected feed與版本／integrity，沒有為公開分享繞過組織套件來源政策；新環境須具備其核准feed存取能力。

## 實驗成果與暫停工作

`prototypes\hosted-adapter\`為明確核准的**隔離離線原型**：官方Python Invocations host轉接私有loopback Node核心，先前8項官方SDK ASGI測試、Hypercorn HTTP／WS smoke及4項既有Node取消／交易測試通過。它不讀`.env`，使用mock業務與固定Voice替身，不是真實語音或production gateway。套件與核准feed固定於其requirements，重現命令見[Foundry指南](FOUNDRY.md)。

這不證明Azure/Linux雙行程映像、managed identity、平台session路由或公開HTTPS／WSS已驗收。沒有Dockerfile／IaC、雲端build／push、新資源、登入網站或公開URL。`.copilot-azure`只有私人唯讀架構／費用與流程評估，不屬於應發布套件，也不是部署結果。

Azure工作維持暫停；原始碼Git快照／推送另經核准，不是雲端上線。最多5並行、每月100次×10分鐘、US$100估算AI／voice admission門檻只是未來需求，**目前未實作全域持久化ledger或demo-key登入**；US$100不是Azure帳單上限。現版本全域Voice上限仍為4，不能宣稱已支援5人同時語音。

## 記憶體、分享與Git狀態

session最多100、閒置1小時失效；旅程、報價、同意與模擬收據皆memory-only。重啟／session失效會遺失，不做跨session／跨instance恢復。每旅程100成功回合、60工具單位、600雲端requests／2.4M回報tokens軟門檻及每旅程3次Voice連線仍不是費用硬上限。沒有正式使用者登入，不可公開綁定、tunnel分享或直接部署。

使用者指定的[GitHub目的地](https://github.com/punmeng/travel-agent-with-voice-live)在檢查時為空的公開repository。本機另經核准初始化`main`、設定該精確origin，沒有自建遠端repository、覆寫遠端歷史或建立PR／tag／release。GitHub推送是否成功以最後命令結果及對應commit為準，文件本身不作成功證據。此文件不內嵌自身commit SHA，以免循環修改。

`.gitignore`排除`.env`及變體（保留`.env.example`）、整個`.foundry`與`.copilot-azure`、node_modules、venv、Python cache、workbook／Playwright暫存、uploads／recordings、WAV／私鑰及logs。公開文件改用resource／project佔位及私人metadata說明，不包含實際voice／vector store／subscription識別。不要整個資料夾ZIP後上傳。

只將應用原始碼、lockfile、範本設定、公開合成資料、維護腳本、測試、文件與明示experimental原型納入快照。知識TXT只納入目前manifest的15檔；16份舊生成檔保留本機但不發布。新增hash快照檔須先核對manifest再明確`git add -f`，不要把整個舊快照目錄加入。`.gitattributes`固定文字LF、Excel binary，避免Windows checkout改動知識檔SHA-256／bytes。
