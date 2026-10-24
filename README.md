# 梅好 Airlines · AI 旅遊規劃師

目前程式版本 **v1.0.6**，3100已啟用（啟用狀態見`docs\CURRENT-VERSION.md`）。版本來源為`package.json`，health、bootstrap、MCP與頁尾共用；後續發布更新該版本及lockfile。頁尾顯示`Powered by Microsoft Innovation Taipei`，不加入額外標誌或官方認證聲明。

畫面完整顯示本輪答案，不需說「繼續」。語音平常摘要，要求全部展開或指定某一天詳述時提供詳細內容；Option1及直接Speech內部按句分段，播放完一段自動接下一段，停止即清空。原生Realtime／GPT-Live依完整後端資料與詳略要求生成語音。畫面、選班與報價資料不因語音摘要而刪減，所有交易仍須完整畫面與目前報價綁定的明確同意。

繁體中文、本機優先的可執行示範。梅好 Airlines 是專案虛構品牌；**不是任何航空公司的服務，未使用客戶名稱或標誌**。

**架構說明更新：2026-10-22，套件版本0.1.0。** 梅好 Airlines 是非官方示範品牌；航班與票價是虛構合成資料，不代表任何客戶或航空公司。最新本機狀態見[版本交接](docs/CURRENT-VERSION.md)，語音測試設計見[四架構比較與量測](docs/VOICE-COMPARISON.md)。Azure發布、demo-key登入、跨session月額度治理仍暫停且未實作；`prototypes\hosted-adapter`只是隔離離線原型，不屬於正式網站功能。本機版本保存於[GitHub原始碼repository](https://github.com/punmeng/travel-agent-with-voice-live)，這不是已部署的線上網站。

## 啟動

需求：Node.js 22 或以上。此專案刻意採原生 ES modules、Node HTTP 與原生瀏覽器 UI，沒有前端編譯或打包步驟。

```powershell
Set-Location C:\Code\travelagent
npm ci
npm start
```

開啟 **http://127.0.0.1:3100**。範本預設 `APP_MODE=mock`，不需要 Azure、登入或憑證，不會呼叫雲端。**此開發機的 `.env` 已依使用者明確核准改為 `APP_MODE=foundry`，使用真實 GPT-5.4 自然對話／知識檢索，會產生用量費用；航班、機位、票價及結帳仍為 mock。** 可改回 mock 離線示範；不得將秘密放進前端。

**所有業務選擇僅透過聊天輸入**，沒有表單、快捷選項、選擇卡或購買按鈕。可以從「我想去日本玩幾天」開始，接著聊「想賞楓，不要走太多路，下個月中，五天，帶媽媽」→「那東京好了，幫我安排五天」。不用機場代碼，也不用先交齊日期、人數與艙等才能規劃。助理先回應旅行想法，再問下一個有用的問題，保留國家、主題、同行者、步調及天數。

介面已精簡為小標頭、聊天與單一輸入區。**文字回覆直接回答本輪問題並完整顯示，不必輸入「繼續」**：會議編輯先回答會議與交通，預算編輯先回答分配，詢問機票選項直接列工具取得的班號、日期、時間與含稅總價。`delivery: "text"`、`delivery: "voice"`及未帶格式的API均回傳完整`result.text`，沒有50詞分頁；`result.speech`另提供摘要或明確要求的詳細朗讀。Option1及直接Speech以最多48段、每段120字元自動接續，超過朗讀安全上限會明確停止，畫面答案保留。**文字／語音共用100個成功回合**；相容的「繼續」只提示上一則已完整顯示，仍計一回合，不另呼叫模型。重試、等待及失敗不計成功回合，失敗仍可能有雲端費用。完整航班呈現後才允許選擇，完整最新報價呈現後才允許明確同意；兩種格式都保留報價版本、總額、期限及冪等檢查。

詢問機場後回答「都可以／沒差／任何一個／你幫我選」，會按最近問題接受該城市候選集合，不忘記城市或默選機場；「不要松山」可縮小集合。最多2×2機場組合、每組最多三對日期，總工具預算與平行2仍有效。沒有符合的合成示範路線會明確回傳無結果，不補入真實航空公司航班。文字／語音等待超過15秒會顯示「我還在查詢，請稍等一下。」；語音等待提示僅為畫面狀態，不開第二個朗讀／模型回覆，不佔回合或授權交易。

找機票時才逐步確認出發地、日期、同行成人數與艙等。東京／台北的多機場偏好用自然名稱確認，不默選成田或桃園。支援「2026年11月12日」與以台北當天為基準的「下個月12號」；「下個月中」只記偏好，絕不猜成15日。「帶媽媽」不自行當成兩人，仍會自然確認總人數。明確來回日期可組合來回合成票；「早去晚回」是排序偏好，不保證時段一定有機位。

航班與總價用編號文字呈現，例如「選第二班」→「幫我看看現在這個票價，準備結帳」→核對完整確認價後說「我同意這個報價，請給我模擬結帳連結」。最後回覆一般可點擊的**模擬結帳連結，不收款、不收卡號、不訂位或開票**，不是選擇卡。「確認」、「同意」或附帶條件的訊息不構成同意；明確接受仍需綁定瀏覽器當時顯示的 quote ID／版本／總額／幣別／期限。選擇與確認不由模型自行決定。

離線 mock 僅支援已列出的有限語句，不宣稱任意自然語言理解；真正自由旅行對話使用已核准的 GPT-5.4 agents。上游出錯會明確顯示關聯識別碼，不偷偷改回 mock 假成功。

## 已實作範圍

### 四種語音架構（固定順序；不是四種聲音）

全部共用**同一組外部GPT-5.4四代理**與合成資料。開始收音前選模式，停止後才能切換；未設定／模型不符時明示不可用，不先取麥克風、不靜默fallback。下表取代舊版將標準Neural列為第四架構的分類。

| 模式 | 真正路徑 | 聲音與限制 |
|---|---|---|
| 1 `voice-live` | Voice Live `azure-speech` zh-TW STT → 外部同四代理 → `pre_generated` exact-text TTS | 既有Personal Voice；`autoanswers=false`，不是再加一次Voice Live GPT-5.4推理 |
| 2 `voice-realtime` | Voice Live **`gpt-realtime-2.1`**音訊原生前端 → 受控`travel_backend` → 同四代理 → `function_call_output` → Voice Live音訊 | 本次選Azure標準`zh-TW-HsiaoChenNeural`，不是模型內建聲音；不配置STT，畫面委派需求是模型整理、非原始逐字稿；唯讀 |
| 3 `gpt-live` | 獨立`gpt-live-1` API → client delegation → 同四代理 → built-in語音 | 目前用有時間戳的使用者轉錄定位委派，不是把原始音訊交四代理；依目前session契約不能換Personal Voice；唯讀 |
| 4 `speech-direct` | A **Speech REST**短音訊STT／B **Speech SDK**連續辨識 → 同四代理 → Speech REST SSML Personal Voice | 完全不呼叫Voice Live；speakerProfileId＋base model；A本機聲學VAD停頓約1秒送出，片段最長28秒／server硬限30秒；B可用mic或8／16kHz PCM16 WAV（最多120秒），每個final依序處理；半雙工、唯讀 |

模式2以`input_audio_buffer.committed`觸發要求function的`response.create`，不依賴可選STT事件。只接受精確`gpt-realtime-2.1`；若實際`configuredModel`不符`requiredModel`就拒絕，不改設定、不降級。模式4獨立opt-in，通用範本`DIRECT_SPEECH_ENABLED=false`；目前3100已核准配置四模式及REST／SDK，配置可用不代表同條件真人驗收完成。實際啟用與歷史證據見[版本交接](docs/CURRENT-VERSION.md)，不能猜資源或profile ID。

四者都要求瀏覽器`noiseSuppression`／`echoCancellation`，只是best-effort，不保證硬體／房間降噪或回音消除。模式4無短音訊REST phrase list、自動語言辨識或server AEC，不能說是語意VAD／全雙工。GPT-Live的臺灣華語指令只是偏好，不保證口音；未帶時間戳的輸出PCM僅用明示連續播放相容處理，不能拿來補造委派時間。

模式1保留既有交易guard；**客戶四模式比較一律唯讀**。模式2／3／4後端阻擋選班、reprice、同意及購買，停止後回文字完成。未有同條件live資料前，不列音質、準確率、延遲或費用排名。完整能力／設定／官方來源見[Foundry指南](docs/FOUNDRY.md#四種語音架構)，同講稿、臺灣聽評與p50／p95量測見[客戶比較](docs/VOICE-COMPARISON.md)。

| 流程 | 行為 |
|---|---|
| Discover → Plan | 自然探索與逐步偏好收集；可在日期未定前安排五天等行程、保留少步行需求 |
| Search → Compare | 單程／來回合成航班、艙等／成人數／總預算；最多 3 組前後一天日期配對、6 個文字選項 |
| Select → Reprice | 後端選擇、候選報價 10 分鐘有效、確認價最多 3 分鐘有效 |
| Book → mock checkout | 綁定最新確認價的明確接受；冪等模擬確認與限時、session 專屬結帳連結 |
| 真實 Pay → Service | 未串接供應商；不實際訂位、開票或付款，不收護照／信用卡資料 |

四代理分工位於 `lib\agents.js`：`intent`、`planner`、`flight`、`price`。Foundry intent 以嚴格 JSON schema 摘取當則原文片段，後端驗證原文證據及型別、解析機場／日期並維護獨立的 discovery/draft 與可搜尋 trip。planner 提供自然文字與知識引用；flight/price 不能用模型文字覆寫工具結果。權限與選班、報價、同意、結帳保留後端控制，確認與選擇回合不呼叫模型。詳見 [Foundry 設定指南](docs/FOUNDRY.md)。

2026-10-23共用旅程修正：Node以`contextVersion`驗證每輪合併，拒絕過時的頁面或模型更新。`discovery.planning`分開保存商務目的、逐日會議時段、活動、住宿晚數／區域、地面機場交通及含機票／住宿的TWD預算；不把東京車站、淺草或「往返交通」當成改目的地／來回機票。支援完整斜線日期`2026/11/12`，所有角色共用待回答欄位與機場接受集合。改飛行條件會清除相關候選與報價；只改少步行或會議資訊不重查航班。四代理按角色收到精簡資料，摘要讀已保存事實而不重跑模型／工具；`diagnostics.modelCalls`提供實際回傳的token數與本機輸入bytes，未提供的usage保持null。住宿金額只作預算配置，不查空房或即時房價。狀態仍僅存本機session記憶體，重啟／新旅程／閒置一小時會清除，沒有新增資料庫。

架構與邊界詳見 [AI 系統設計文件](docs/SYSTEM-DESIGN.md)；示範流程見 [繁中講稿](docs/DEMO-SCRIPT.md)。

**原模式1曾接上真正Azure Voice Live。** 以下是原模式1的既有行為，不是新四架構的live驗收。它明確使用Personal Voice、不遇錯換聲，轉錄與canonical回答顯示在同一對話；所有模式都不使用瀏覽器STT/TTS。原模式1思考或朗讀時可插話，例如「不是十月，是十一月中」；舊只讀模型請求取消後，依最新更正序列處理，過時答覆不顯示／朗讀。交易不強制中斷或假回滾。按停止或關閉後可繼續文字，旅程與報價共用。Professional Voice設定接點已實作：明確選`azure-custom`，搭配`VOICE_LIVE_CUSTOM_VOICE_NAME`／`VOICE_LIVE_CUSTOM_VOICE_ENDPOINT_ID`對應`name`／`endpoint_id`；須先有訓練完成、獲授權且同資源的資產，目前**未配置資產**。

Personal Voice已於2026-10-19完成同資源唯讀核對及少量真實合成：`azure-personal`／`DragonLatestNeural`，收到100,768 bytes PCM音訊，沒有替代聲音。Voice Live的`name`使用服務回傳的voice資源`id`，不是入口網站顯示名稱，也不是一般SSML的speakerProfileId；identifier只保留於忽略的後端`.env`。未處理錄音或評估人聲相似度。詳見[Personal Voice接線及限制](docs/FOUNDRY.md#personal-voice)。

發音由`lib\speech.js`在送入Voice Live的exact-text合成前正規化一次：`DEMO101`逐碼讀出，`DEMO0101`保留前置零，`DEMO-FLT-30`保留模擬意義並逐字母／數字朗讀，`TPE`→`T，P，E`。一般英文單字不盲目拆字。日期／時間讀繁中語意（如`2026-11-25T08:30`→`二零二六年十一月二十五日上午八點三十分`），TWD金額讀「新臺幣…元」，時區路徑讀臺灣／日本等當地時間標籤。結帳連結只說已放在對話中，不朗讀安全token；畫面原始碼、日期、總額、版本、期限及可點擊連結不改。canonical顯示回覆不受50詞限制；逐碼發音展開後仍受有界朗讀限制，不能為縮短而丟掉金額／期限等事實。實際Personal Voice已收到正規化合成音訊，但字母辨識與聲音效果仍需本人試聽。

可直接開啟本機`.foundry\pronunciation-preview.wav`試聽固定合成句（不是錄音、真實航班或購買）；內容含DEMO101、DEMO0101、TPE、日期時間及TWD總額。重新產生會使用付費雲端語音，須明確授權：`node --env-file=.env scripts\smoke-voice-output.js --apply --pronunciation --save-preview`。不透過模型捏造可售航班來測試。

月／日區間`11/26–11/30`朗讀為「十一月二十六號到十一月三十號」，也支援半形連字號、長破折號及波浪號；只處理兩端均為有效月日的獨立區間，不更改畫面日期、不推定年份，代碼／路徑／URL不當作日期。既有試聽WAV未包含此後續規則，沒有重新付費合成。

對話上方常駐「目前代理」顯示後端**實際當前處理角色**：意圖協調／旅遊規劃／航班查詢／票價與購買，不需打開語音面板。語音使用同session的`progress` WS事件；文字以只讀`/api/progress`查詢目前requestId，不呼叫額外AI。新回合重設，完成明示「已完成」，聆聽無任務、停止、錯誤回到「等待對話」；忽略被取代回合的延遲事件。這不是第五個語音agent，標籤不會朗讀。

語音面板可用「面板高度」滑桿（鍵盤方向鍵亦可）或右下角拖曳調整高度；「放大對話寬度」可切換寬版。較長對話保留於獨立可捲動對話區；「語音與模擬資料說明」預設收合，不遮住對話。四模式編號固定為1–4；僅Option1顯示緊湊的「個人化男聲／個人化女聲」選單，預設男聲，連線期間停用；Option4 REST／SDK維持男聲。

四種模式均保留畫面原始來源與引用，但送往朗讀／語音前端的回答會移除明確標記的來源行、來源清單中的網址／檔名及引用標記。合成資料、未核驗限制、金額／期限及交易警語仍保留；不刪除回答正文。模式2／3另指示前端不朗讀或補出來源，模型自行改述仍需真人驗收，不能保證逐字朗讀。

### 選項4：REST對照組／SDK串流辨識切換

在選項4的「辨識方式」選擇 **A REST API** 或 **B Speech SDK**，必須停止連線後才能切換。A保留既有24kHz麥克風→本機聲學VAD→16kHz短音訊REST，適合與選項1對照；沒有套用SDK的700ms屬性。B使用伺服器端`microsoft-cognitiveservices-speech-sdk`連續辨識及`PushAudioInputStream`，固定`zh-TW`，可選`Speech_SegmentationSilenceTimeoutMs` 700／1000ms及最多100個phrase（每行一詞，每詞100字）。不是語意VAD，也不新增業務代理。兩者使用同一四代理及既有REST SSML Personal Voice TTS，保留只讀交易限制。

SDK串流來源可選：
- **即時麥克風**：24kHz瀏覽器PCM平均重取樣為16kHz mono PCM16，預設1280 bytes一包（40ms）。
- **本機WAV重播**：選擇8kHz或16kHz、單聲道、未壓縮PCM16 WAV（最多120秒），在開始前嚴格驗證RIFF及格式。只讀入記憶體，不存檔、不要求麥克風權限；按開始才會傳送Azure並可能計費。預設1280 bytes一包，在8kHz為80ms、16kHz為40ms；可選320–6400偶數bytes。半雙工思考／TTS時暫停檔案位置，不丟樣本或快速補送；停止取消後續傳送。

SDK `recognizing`只作可更正中間顯示；所有`recognized`最終片段含sequence、SDK offset／duration與本機接收elapsed時間，保留於本次UI（最多100片段、最近200個非interim事件）。這些不保存在後端日誌。**一個final是ASR片段，不保證語意完整**；本POC每片段依序交四代理，回呼只排隊、不等待LLM／TTS，最多8個待處理final，超量明確停止。當前回答播放完、瀏覽器`resume`後才處理下一片段。若要跨final組成一個語意回合，需要另外定義合併／提交策略。

WAV真正結束才關Push輸入，等待SDK尾端final；`session_stopped`只標示工作階段結束，絕不拿它觸發額外代理工作。SDK canceled／未預期停止／15秒EOF等待逾時會明確報錯，不fallback REST。半雙工不是barge-in／server AEC；已送入SDK的音訊可能在靜音後才產生final。格式模擬不包含MRCP協定、Avaya連線、RTP、DTX、G.711解碼或timestamp重建，Gateway仍負責這些工作。示範沿用`C:\download\gateway_speech_sdk_sample.py`的PCM、事件與EOF分離模式，未複製其key需求。

SDK沿用後端既有`DIRECT_SPEECH_*`設定，無需修改`.env`或把key放入瀏覽器。Entra使用同資源custom domain、Speech scope與`aad#RESOURCE_ID#TOKEN`，約8分鐘更新recognizer token；key設定亦可。SDK telemetry已關閉。票券以strict schema綁定模式／取樣率／切段／phrase；瀏覽器不能指定endpoint、token或工具權限。既有同旅程單連線、全域4連線、回合／音訊／背壓預算仍適用。套件安裝與mock SDK測試不證明資源的SDK串流認證、phrase品質或真人語音已成功，需另行live驗收。

「11月15號／十一月十五日」可直接解析，會明說按今年或已給定年份；已過日期不暗中改成明年，無效日曆會自然澄清。「11月中」仍是模糊偏好，不猜成15日；「20號回來」依出發月／年，跨月不猜。找來回機票的任務會持續到必要條件補齊後自動查詢，不需再說「搜尋航班」；使用者說「預設經濟艙」就是明確艙等選擇。完整展示合成去回時間與候選後才允許選班，完整最新確認價呈現後才允許明確同意。

2026-10-18日期修復：原本模型摘出「2026年11月15號去」時，後端把尾端「去」誤當不可解析而一直追問。現在先從原文抽取日期token與去／回角色，保留`dateEvidence`的raw、canonical date、status與yearSource；同一句去回兩日期、中文數字、空白標點均走同一解析。`26年`按當前世紀解讀為2026並明說，不猜下世紀。舊版留下的有效但未解析偏好可在下一句自然回覆時修復；不相關的無法解析片段不清掉已確認日期。`GET /api/health`的`build`為啟動時程式SHA-256短碼，可辨識實際載入版本，健康回應不是雲端連線保證。

模式1私人`VOICE_LIVE_ENABLED=true`源於過往核准，East US 2資源曾實際連線；通用範本仍false。模式1 WebSocket橋接PCM16 24kHz，憑證僅留後端，不代表模式4使用相同STT格式。**已移除應用五分鐘截斷**，文字與語音共用100回合；不限制每旅程累計連線次數、不自動重連。仍有timeout、音訊／背壓安全上限，不保證供應商無斷線。文字pending時不能開始語音；停止音軌不提前釋放交易鎖。**過往模式1合成音訊曾通過轉錄→GPT→朗讀；本次四架構、真人麥克風／喇叭與房間回音未完成同條件驗收。** 語音與推論會產生費用；航班、價格與結帳仍為模擬。

## 資料與知識

城市／機場對照工具`resolve_city_airports`已供自然對話、MCP與intent／planner／flight共用；地理會員不代表任何航空公司的實際營運或可售航線。預設43城市群組／45機場／122列別名關係。Excel範本：`data\templates\city-airport-mapping.xlsx`；先執行`node scripts\import-city-airports.js <file.xlsx>`整本檢查，明確套用才加`--apply`。支援country ambiguity、已接受集合及排除；公式／巨集／衝突／無效時區／非DEMO參考航線會拒絕，未通過不改舊檔。完整欄位、Python依賴及原子套用界線見[對照維護說明](docs/CITY-AIRPORT-MAPPING.md)。

`data\network.json` 為可編輯的生成來源；`npm run generate` 可確定性重新產生：

| 檔案 | 內容 |
|---|---|
| `data\generated\airports.json` | 45 個機場、城市、IATA 代碼、IANA 時區 |
| `data\generated\routes.json` | 86 條有方向性的合成示範路線 |
| `data\generated\flights.json` | 20,640 個含日期、UTC／當地時間的 `DEMO-FLT-*` 合成班次 |
| `data\generated\fares.json` | 48,000 筆按航班／艙等連結的合成單價與機位數 |

範圍為 **2026-10-16 至 2027-02-12**。`marketingCarrier=DEMO`與`operatingCarrier=DEMO`只是本專案的合成資料標籤；所有航班／時刻／機位／票價均由本機生成，不來自航空公司或官方航網資料。標記`synthetic-demo-not-real-world`，不表示任何真實航線或航空公司營運；`DEMO-FLT-*`不是實際班號。45個機場僅是地理參考，不代表各機場間有真實或可售航線。

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

`data\knowledge\manifest.json` 列出完整15個UTF-8 TXT、50,821,970 bytes的實際檔名、SHA-256及角色對應，未截斷。overview為45機場／86航線摘要；geography保存全部地理／航線欄位；planner-context只有現有示例；flights-01～06保存20,640個合成班次；fares-01～06保存48,000筆合成票價及班次關聯。資訊問題如「介紹台北到東京的合成航班時刻資料」直接使用flight agent的file_search，不要求先完成購票欄位；交易仍用本機工具。

只有目前manifest列出的檔案會被上傳；目錄中未列出的舊TXT不屬於目前快照。`meihao-*`是此範本的新部署預設名稱，不表示任何既有雲端資源已重新命名；新快照是否已上傳須以私有環境核驗。

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

既有測試涵蓋資料／知識、時區、四代理、MCP、有界搜尋、日期／總額、權限／同意／冪等與session隔離；語音使用離線fake transport測票券、同源工具、錯誤及清理，不證明真人聲學效果。本次新實作是否通過以本次runner結果為準。過往核准的GPT-5.4七句對話及模式1合成音訊紀錄在私人`.foundry`，**不是新四架構live驗收**。`npm run test:voice:live`會付費，僅另行核准才可執行，本次未執行。未接真實付款。
