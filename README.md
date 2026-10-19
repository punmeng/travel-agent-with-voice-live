# 梅好旅程 · 梅好 Airlines風格 AI 旅遊規劃師

繁體中文、本機優先的可執行示範。以梅花意象、留白與玫紅色呈現航空旅行風格；**非梅好 Airlines官方服務，未使用官方標誌**。

**目前版本交接：2026-10-19，套件版本0.1.0；既有3100已運行程式build `6b6814aca5deb4b2`。** 功能、重現步驟、驗證紀錄及分享排除清單見[本機版本交接](docs/CURRENT-VERSION.md)。Azure發布、demo-key登入、跨session月額度治理仍暫停且未實作；`prototypes\hosted-adapter`只是隔離離線原型，不屬於正式網站功能。本機版本保存於[GitHub原始碼repository](https://github.com/punmeng/travel-agent-with-voice-live)，這不是已部署的線上網站。

## 啟動

需求：Node.js 22 或以上。此專案刻意採原生 ES modules、Node HTTP 與原生瀏覽器 UI，沒有前端編譯或打包步驟。

```powershell
Set-Location C:\Code\travelagent
npm DEMO
npm start
```

開啟 **http://127.0.0.1:3100**。範本預設 `APP_MODE=mock`，不需要 Azure、登入或憑證，不會呼叫雲端。**此開發機的 `.env` 已依使用者明確核准改為 `APP_MODE=foundry`，使用真實 GPT-5.4 自然對話／知識檢索，會產生用量費用；航班、機位、票價及結帳仍為 mock。** 可改回 mock 離線示範；不得將秘密放進前端。

**所有業務選擇僅透過聊天輸入**，沒有表單、快捷選項、選擇卡或購買按鈕。可以從「我想去日本玩幾天」開始，接著聊「想賞楓，不要走太多路，下個月中，五天，帶媽媽」→「那東京好了，幫我安排五天」。不用機場代碼，也不用先交齊日期、人數與艙等才能規劃。助理先回應旅行想法，再問下一個有用的問題，保留國家、主題、同行者、步調及天數。

介面已精簡為小標頭、聊天與單一輸入區；**每則助理對話最多50詞**，不是50字，也不是英文空白計數。中文／混合文用 `Intl.Segmenter('zh-Hant', { granularity: 'word' })` 的 word-like 分段；日期、金額、識別碼與URL完整保留，模擬結帳連結按畫面標籤計詞。模型先被要求精簡，後端再逐則檢驗；較長行程、航班、引用與報價用「繼續」完整分段，優先在句末或換行切頁，不丟失五天內容。**文字／語音／繼續共用100個成功完成的使用者回合**；冪等重試、等待提示及失敗不計完成回合，失敗可能仍有雲端用量。分段不呼叫模型。50詞不包括角色名稱、介面、錯誤面板或文件。語音依同一受限text作確定性發音展開，不另寫答案；完整航班未呈現不能選擇，完整最新報價未呈現不能同意。長回覆不是截斷後假稱已完成。

詢問機場後回答「都可以／沒差／任何一個／你幫我選」，會按最近問題接受該城市候選集合，不忘記城市或默選機場；「不要松山」可縮小集合。最多2×2機場組合、每組最多三對日期，總工具預算與平行2仍有效。沒有符合的DEMO示範路線不以其他航空補足。文字／語音等待超過15秒會顯示「我還在查詢，請稍等一下。」；語音等待提示僅為畫面狀態，不開第二個朗讀／模型回覆，不佔回合或授權交易。

找機票時才逐步確認出發地、日期、同行成人數與艙等。東京／台北的多機場偏好用自然名稱確認，不默選成田或桃園。支援「2026年11月12日」與以台北當天為基準的「下個月12號」；「下個月中」只記偏好，絕不猜成15日。「帶媽媽」不自行當成兩人，仍會自然確認總人數。明確來回日期可組合來回合成票；「早去晚回」是排序偏好，不保證時段一定有機位。

航班與總價用編號文字呈現，例如「選第二班」→「幫我看看現在這個票價，準備結帳」→核對完整確認價後說「我同意這個報價，請給我模擬結帳連結」。最後回覆一般可點擊的**模擬結帳連結，不收款、不收卡號、不訂位或開票**，不是選擇卡。「確認」、「同意」或附帶條件的訊息不構成同意；明確接受仍需綁定瀏覽器當時顯示的 quote ID／版本／總額／幣別／期限。選擇與確認不由模型自行決定。

離線 mock 僅支援已列出的有限語句，不宣稱任意自然語言理解；真正自由旅行對話使用已核准的 GPT-5.4 agents。上游出錯會明確顯示關聯識別碼，不偷偷改回 mock 假成功。

## 已實作範圍

| 流程 | 行為 |
|---|---|
| Discover → Plan | 自然探索與逐步偏好收集；可在日期未定前安排五天等行程、保留少步行需求 |
| Search → Compare | 單程／來回合成航班、艙等／成人數／總預算；最多 3 組前後一天日期配對、6 個文字選項 |
| Select → Reprice | 後端選擇、候選報價 10 分鐘有效、確認價最多 3 分鐘有效 |
| Book → mock checkout | 綁定最新確認價的明確接受；冪等模擬確認與限時、session 專屬結帳連結 |
| 真實 Pay → Service | 未串接供應商；不實際訂位、開票或付款，不收護照／信用卡資料 |

四代理分工位於 `lib\agents.js`：`intent`、`planner`、`flight`、`price`。Foundry intent 以嚴格 JSON schema 摘取當則原文片段，後端驗證原文證據及型別、解析機場／日期並維護獨立的 discovery/draft 與可搜尋 trip。planner 提供自然文字與知識引用；flight/price 不能用模型文字覆寫工具結果。權限與選班、報價、同意、結帳保留後端控制，確認與選擇回合不呼叫模型。詳見 [Foundry 設定指南](docs/FOUNDRY.md)。

架構與邊界詳見 [AI 系統設計文件](docs/SYSTEM-DESIGN.md)；示範流程見 [繁中講稿](docs/DEMO-SCRIPT.md)。

**Talk to agent 已接上真正 Azure Voice Live。** 按入口，再按「開始語音」並允許麥克風，即可自然說話；轉錄與回答顯示在同一對話。目前明確選用Personal Voice，預建`zh-TW-HsiaoChenNeural`仍可明確設定使用但不作錯誤fallback。不另開一個語音聊天模型、不使用瀏覽器 STT/TTS。思考或朗讀時都可插話，例如「不是十月，是十一月中」；舊只讀模型請求取消後，保留原城市並依最新更正序列處理，過時答覆不顯示／朗讀。交易不強制中斷或自動重試。按停止或關閉後可繼續文字，旅程與報價共用。

Personal Voice已於2026-10-19完成同資源唯讀核對及少量真實合成：`azure-personal`／`DragonLatestNeural`，收到100,768 bytes PCM音訊，沒有替代聲音。Voice Live的`name`使用服務回傳的voice資源`id`，不是入口網站顯示名稱，也不是一般SSML的speakerProfileId；identifier只保留於忽略的後端`.env`。未處理錄音或評估人聲相似度。詳見[Personal Voice接線及限制](docs/FOUNDRY.md#personal-voice)。

發音由`lib\speech.js`在送入Voice Live的exact-text合成前正規化一次：`DEMO101`→`D，E，M，O，一，零，一`，`DEMO0101`保留前置零，`DEMO-FLT-30`保留模擬意義並逐字母／數字朗讀，`TPE`→`T，P，E`。一般英文單字不盲目拆字。日期／時間讀繁中語意（如`2026-11-25T08:30`→`二零二六年十一月二十五日上午八點三十分`），TWD金額讀「新臺幣…元」，時區路徑讀臺灣／日本等當地時間標籤。結帳連結只說已放在對話中，不朗讀安全token；畫面原始碼、日期、總額、版本、期限及可點擊連結不改。50詞上限檢查canonical顯示回覆；逐碼發音可能展開較長，不能為縮短而丟掉金額／期限等事實。實際Personal Voice已收到正規化合成音訊，但字母辨識與聲音效果仍需本人試聽。

可直接開啟本機`.foundry\pronunciation-preview.wav`試聽固定合成句（不是錄音、真實航班或購買）；內容含DEMO101、DEMO0101、TPE、日期時間及TWD總額。重新產生會使用付費雲端語音，須明確授權：`node --env-file=.env scripts\smoke-voice-output.js --apply --pronunciation --save-preview`。不透過模型捏造可售航班來測試。

月／日區間`11/26–11/30`朗讀為「十一月二十六號到十一月三十號」，也支援半形連字號、長破折號及波浪號；只處理兩端均為有效月日的獨立區間，不更改畫面日期、不推定年份，代碼／路徑／URL不當作日期。既有試聽WAV未包含此後續規則，沒有重新付費合成。

Voice Live標題旁的小標籤顯示後端**實際當前處理角色**：意圖協調／旅遊規劃／航班查詢／票價與購買。語音使用同session的`progress` WS事件；文字以只讀`/api/progress`查詢目前requestId，不呼叫額外AI。新回合重設，完成明示「已完成」，聆聽無任務、停止、錯誤回到「等待對話」；忽略被取代回合的延遲事件。這不是第五個語音agent，標籤不會朗讀。

「11月15號／十一月十五日」可直接解析，會明說按今年或已給定年份；已過日期不暗中改成明年，無效日曆會自然澄清。「11月中」仍是模糊偏好，不猜成15日；「20號回來」依出發月／年，跨月不猜。找來回機票的任務會持續到必要條件補齊後自動查詢，不需再說「搜尋航班」；使用者說「預設經濟艙」就是明確艙等選擇。先展示合成去回時間，詳情分頁後才允許選班／同意。

2026-10-18日期修復：原本模型摘出「2026年11月15號去」時，後端把尾端「去」誤當不可解析而一直追問。現在先從原文抽取日期token與去／回角色，保留`dateEvidence`的raw、canonical date、status與yearSource；同一句去回兩日期、中文數字、空白標點均走同一解析。`26年`按當前世紀解讀為2026並明說，不猜下世紀。舊版留下的有效但未解析偏好可在下一句自然回覆時修復；不相關的無法解析片段不清掉已確認日期。`GET /api/health`的`build`為啟動時程式SHA-256短碼，可辨識實際載入版本，健康回應不是雲端連線保證。

本機 `.env` 已按核准設定 `VOICE_LIVE_ENABLED=true`，既有 East US 2 資源已實際連線；通用範本仍為 false。後端 WebSocket 橋接 PCM16 24kHz，憑證僅留後端。**已移除應用五分鐘截斷**，文字與語音共用100回合；每旅程最多3次連線、不自動重連。仍有啟動／請求timeout、每秒音訊／背壓與總音訊bytes安全上限，不能保證供應商無斷線。長說明在控制項下方折疊，實際錯誤保持可見、code與關聯ID在診斷摺疊區。文字請求未完成時不能開始語音；停止語音不提前釋放正在進行的交易鎖。**Azure合成音訊已通過轉錄→GPT→朗讀；真人麥克風、喇叭與房間回音仍需實測。** 語音與推論會產生費用；航班、機位、價格與結帳仍為模擬。

## 資料與知識

城市／機場對照工具`resolve_city_airports`已供自然對話、MCP與intent／planner／flight共用，地理會員不代表DEMO自營／可售航線。預設43城市群組／45機場／122列別名關係。Excel範本：`data\templates\city-airport-mapping.xlsx`；先執行`node scripts\import-city-airports.js <file.xlsx>`整本檢查，明確套用才加`--apply`。支援country ambiguity、已接受集合及排除；公式／巨集／衝突／無效時區／非DEMO參考航線會拒絕，未通過不改舊檔。完整欄位、Python依賴及原子套用界線見[對照維護說明](docs/CITY-AIRPORT-MAPPING.md)。

`data\network.json` 為可編輯的生成來源；`npm run generate` 可確定性重新產生：

| 檔案 | 內容 |
|---|---|
| `data\generated\airports.json` | 45 個機場、城市、IATA 代碼、IANA 時區 |
| `data\generated\routes.json` | 86 條有方向性的假設 DEMO 合成直飛路線 |
| `data\generated\flights.json` | 20,640 個含日期、UTC／當地時間的 DEMO-FLT 航班 |
| `data\generated\fares.json` | 48,000 筆按航班／艙等連結的合成單價與機位數 |

範圍為 **2026-10-16 至 2027-02-12**。所有航班／航線／票價都有`marketingCarrier=DEMO`、`operatingCarrier=DEMO`及`codeshare=false`；後端搜尋、讀offer與reprice再防禦檢核，禁止AE、合作航空及他航營運共掛。**這是合成資料的範圍約束，不是已核驗DEMO營運證明。** 官方route-map本次回NEXT_NOT_FOUND，成田官方動態頁沒有可讀逐班資料；所有保留航線標為`synthetic-demo-not-real-world`，不宣稱真實或完整梅好 Airlines航網。已剔除原松山-羽田、桃園-奧克蘭直飛、桃園-宿霧等未能支持的示範spokes；45機場是地理參考，不代表每座都有可搜路線。班號`DEMO-FLT-*`不是實際DEMO班號，舊22,080筆快照已被取代。

所有票價是 **TWD、每位成人單程、含合成稅費**；總額 = 單價 × 人數，無換匯。非即時、非可售報價。只有示範長途路線有豪華經濟艙；不支援的艙等／機位／路線／日期會回傳空結果，絕不改艙補結果。

`lib\dataset.js` 是 runtime 與匯出檔共同的確定性生成器，runtime 不讀取大型匯出檔。調整日期範圍時請修改來源 metadata 再重新生成。官方航點事實若日後取得授權清單，應另存來源、核驗日期、授權與涵蓋範圍，不要混入合成時刻或價格。

`data\planner-knowledge.json` 可加入您的規劃準則、目的地提案與**人工核准網站摘要**。`approvedWebsites` 預期項目格式：

```json
{
  "url": "https://approved-tourism.example/guide",
  "title": "人工核准旅遊指南",
  "accessedAt": "2026-10-16",
  "summary": "已取得授權、經審閱的文字摘要",
  "untrusted": true
}
```

這只是結構範例，不是已核准來源。系統不會依使用者 URL 抓網頁、不會無限制爬蟲。外部文字只作知識，不可授權工具、改價或代替同意。使用者已核准將**全部合成票價作靜態參考知識**上傳；不可宣稱為即時／可售價格。選班、機位與確認價仍必須走工具與 reprice。

### 四角色知識快照

`data\knowledge\manifest.json` 列出完整15個UTF-8 TXT、50,566,840 bytes的實際檔名、SHA-256及角色對應，未截斷。overview為45機場／86航線摘要；geography保存全部地理／航線欄位；planner-context只有現有示例；flights-01～06保存20,640航班；fares-01～06保存48,000票價及航班關聯。資訊問題如「介紹台北到東京的合成航班時刻資料」直接使用flight agent的file_search，不要求先完成購票欄位；交易仍用本機工具。

只有目前manifest列出的檔案會被上傳；目錄中未列出的舊TXT不屬於目前快照。新版本已改掛新synthetic-demo庫；舊雲端庫保留供稽核、未自動刪除，仍可能產生儲存費。

| Agent | 知識檔案 |
|---|---|
| meihao-intent-agent | overview |
| meihao-travel-planner-agent | overview、geography、planner-context |
| meihao-flight-checker-agent | overview、geography、全部 flights |
| meihao-price-purchase-agent | overview、geography、全部 fares |

`npm run prepare:knowledge` 僅在本機產生確定性快照。`npm run ingest:knowledge` 會使用既有 CLI 登入身分上傳並索引，**有儲存／embedding 費用**，只應在明確授權後執行；不自動登入、不新增模型、不呼叫 Responses。`.foundry\knowledge-ingestion.json` 保存實際 file/store IDs、索引狀態及 agent 版本；同一快照重跑會核對並重用，未知 agent 變更或不同快照會停止。實際掛載狀態見 [Foundry 指南](docs/FOUNDRY.md)。

## MCP

```powershell
npm run mcp
```

這是標準 **stdio MCP server**，沒有 HTTP 公開端點。工具：`list_airports`、`resolve_city_airports`、`search_flights`、`get_offer`、`reprice_offer`。所有輸入使用 strict schema；輸出含 `mock: true` 與 `correlationId`。每個 MCP 連線擁有自己的報價範圍，無購買工具。

MCP client 設定示例（實際 client 欄位以其文件為準）：

```json
{
  "mcpServers": {
    "meihao-airlines": {
      "command": "node",
      "args": ["C:\\Code\\travelagent\\mcp.js"]
    }
  }
}
```

網頁代理直接呼叫**同一個 `callTool` handler**，不是另一套不相連的 demo 工具；Foundry function calls 也進入相同權限與 schema 檢查。Hosted Foundry 若要直接連 remote MCP，須另做受驗證的 HTTP transport，不能把本機 stdio 位址當遠端 URL。

## 安全與限制

- 只綁定 `127.0.0.1`；Host、Origin 檢查、SameSite／HttpOnly session cookie、CSP、12 KB JSON 上限。沒有跨使用者正式登入，**不可直接公開部署或透過 tunnel 分享**。
- 每session100完成回合；600雲端requests（100×2 agents×3工具輪）、2,400,000回報tokens後拒絕下一次（軟門檻，非帳單硬上限），避免舊40/80,000上限過早截斷100輪。60工具單位維持：機場配對×日期配對×航段數先扣總額，最多2×2×3配對、平行2、最多6候選。每response最多2,500 output tokens／60秒，工具回合3／每輪3 calls，不自動重試雲端。頻繁機票搜尋可能先用完工具額度，仍可做不需工具的正常對話。
- 本機 session 最多 100 個、閒置 1 小時失效；報價、同意與模擬確認在記憶體中，**重啟後不保留**。程式及資料檔會保留。每 session 同時只處理一個寫入請求。
- 重新搜尋、修改旅程、重新報價都會使既有同意失效。確認價到期須重新報價；冪等鍵避免網路重試產生重複模擬確認，相同 quote 即使不同鍵也只產生一筆。
- 不允許任意價格、幣別或擴大日期搜尋範圍等額外參數；代理沒有 consent／purchase 工具。僅精確的確認訊息可觸發後端 consent＋模擬確認，且需比對當時顯示的 quote ID／版本／總額／幣別／期限。舊清單、過期或已更新報價、缺少 context、含糊或否定的確認均不執行。
- 聊天請求的 UUID 在重試時不變，相同請求只執行一次；相同識別碼但不同內容被拒絕。重新整理只恢復對話，不自動確認。確認價文字中的 ISO 期限以 UTC 顯示，航班另有各地時區。
- 錯誤回傳 HTTP 非成功狀態、錯誤碼與關聯識別碼；server只記安全的error class／cause code、auth／fetch／decode階段、HTTP狀態與耗時，不輸出原始例外message、使用者文字、token或個資。Foundry失敗不回退成假成功mock回覆。原`VOICE_TURN_FAILED`事件只有舊code／ID，無法事後證明是timeout／auth；新版改為明確分類，沒有宣稱已找到那次未留存的原因。
- 不含兒童／嬰兒計價、轉機、多城市、飯店／附加商品預訂、護照／簽證判定與真實支付；支持已明確日期的合成來回。行程只是靈感，交通／營業／無障礙資訊未核驗，不是旅遊合約。

## 驗證

```powershell
npm run check
npm run check:mapping-voice
npm test
# 第一次執行且缺少瀏覽器時：
npx playwright install chromium
npm run test:ui
```

涵蓋資料關聯與全量知識快照、時區／換日／夏令時間、四代理、MCP stdio契約、有限搜尋、自然偏好／日期、來回總額、權限、過期／改價／同意／冪等、checkout session隔離與桌面／手機對話。語音測試涵蓋同session、一次性連線票券、Origin、顯示後才接受報價、轉錄重複、實際同源工具流程、錯誤、麥克風拒絕與清理。一般測試使用離線fake transport，不產生雲端費用。另已在核准下完成真實GPT-5.4七句對話驗收（`.foundry\live-smoke.json`）及實際Voice Live合成音訊迴路（`.foundry\voice-smoke.json`）。`npm run test:voice:live` 會額外付費，只應明確核准後執行。未接真實付款。
