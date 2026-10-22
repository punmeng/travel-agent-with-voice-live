# 本機版本交接：2026-10-22

## 最新本機狀態

2026-10-22經使用者核准已受控重啟，3100目前載入REST／SDK切換版本，health build為`f9d470539a7cbe9a`。四模式配置均可用；模式2設定為精確`gpt-realtime-2.1`，模式4沿用已核准Direct Speech設定。實際頁面已確認SDK／WAV選項及開始按鈕，不取得麥克風、不建立語音連線。85項語音相關Node測試、24項瀏覽器測試與語法檢查通過；不代表Azure端到端語音驗收。未呼叫Azure、未改私人`.env`。

下方「四架構」及其他啟用／配置／測試敘述保留為較早工作階段的歷史記錄；其中舊model、待配置、未重啟或預覽停止描述不代表上述最新狀態。GitHub是否已提交／發布以實際Git操作結果為準，不以歷史「不commit／push」敘述推定。

2026-10-22增量：選項4新增REST／SDK可見切換；SDK使用PushAudioInputStream連續辨識、700／1000ms切段與可選phrase list。可由麥克風16kHz或上傳8／16kHz mono PCM16 WAV，以1280 bytes預設區塊實時重播（最多120秒），中間／全部最終片段及timing顯示於UI。callback排隊、worker依序交原四代理／Personal Voice，半雙工、max8待處理片段；session_stopped不當語句提交。此次未修改私人設定、未呼叫Azure，SDK真實認證與音訊需另行驗收。下方較早的啟用／配置與測試數字為歷史快照，不取代實際health及本次runner結果。

套件`meihao-airlines-travel-planner` **0.1.0**；梅好 Airlines 是專案虛構品牌，不代表任何客戶或航空公司。本機POC，非Azure發布或正式發行聲明。

## 四架構：原始碼、配置、live證據分開

固定順序如下，取代先前把標準Neural聲音列為第四方法的分類；`voice-standard`不是本次第四架構。全部共用外部同一組GPT-5.4四代理及合成工具。

| 順序／模式 | 原始碼與離線實作界線 | 私人配置／運行 | live已證明與未證明 |
|---|---|---|---|
| 1 `voice-live` | `azure-speech` zh-TW STT → 同四代理 → `pre_generated` exact-text Personal Voice；`autoanswers=false`，無額外Voice Live GPT-5.4推理 | 保留既有設定；既有預覽是舊行程，不代表已載入本次修訂 | 過往同資源Personal Voice握手及合成收到PCM；不是本次臺灣語音／真人回音驗收 |
| 2 `voice-realtime` | 需求為Voice Live **`gpt-realtime-2.1`**音訊原生 → `travel_backend` → 同四代理 → `function_call_output` → Azure標準`zh-TW-HsiaoChenNeural`；committed驅動function，無STT配置 | 私人設定仍`gpt-realtime`，新版gate應顯示`configuredModel=gpt-realtime`／`requiredModel=gpt-realtime-2.1`並不可用；沒有替使用者切model | 沒有本次2.1連線、音質、委派或延遲驗收；舊model配置不算2.1成功 |
| 3 `gpt-live` | 獨立`gpt-live-1`、client delegation、built-in聲音；目前需timed user transcript定位委派；untimed output PCM明示相容播放 | 過往已有核准配置與使用者連線觀察；本次不改endpoint／聲音／設定、不重啟 | 曾見output PCM缺兩個時間欄；不等於端到端委派／口音／延遲已驗收 |
| 4 `speech-direct` | A保留獨立REST／本機VAD對照組（1秒靜音、28秒片段、30秒硬限）；B新增SDK continuous（700／1000ms、phrase、8／16kHz PCM串流）；兩者接同四代理／SSML Personal Voice，半雙工、不呼叫Voice Live | 沿用既有私人端點／Entra resourceID／speakerProfileId，無新增env；SDK原始碼需核准重啟才可載入 | SDK僅mock事件／音訊格式離線驗證，沒有真實SDK認證或聲學驗收 |

這份文件描述本次實作契約；實作者已回報**targeted Node voice regressions 49項、browser voice cases 10項通過**。這不是完整suite最終結果，也不代表雲端成功；完整suite仍待實際runner完成，不借用舊數字。本文件編修沒有執行測試或服務；先前docs-only檢查核對文字／連結與diff，這次末尾細節修訂未再驗證。source仍需另行受控啟動才可載入。

模式2委派需求為**模型整理（MODEL-DERIVED），非原始逐字稿**；選Azure標準voice時不是模型built-in輸出。模式3的臺灣華語instructions是偏好，不保證口音；目前session契約不能替換Personal Voice。其untimed PCM相容只影響輸出播放，不能替input transcript／delegation補時間。

模式2／3／4後端唯讀，選班、reprice、同意／購買都要停止後回文字；四模式客戶比較連模式1也不交易。麥克風輸入僅要求瀏覽器best-effort `noiseSuppression`／`echoCancellation`，WAV不要求麥克風或這些處理。直接Speech REST使用本機聲學VAD、SDK使用700／1000ms聲學停頓切段，都不是語意VAD／全雙工；REST無phrase list，SDK可選phrase；兩者無auto LID或server AEC。手動提早送出只適用REST可選備援。

Direct Speech只接受精確`DIRECT_SPEECH_ENDPOINT=https://<resource>.cognitiveservices.azure.com`資源root；用`DIRECT_SPEECH_RESOURCE_ID`配Entra或`DIRECT_SPEECH_KEY`。`DIRECT_SPEECH_PERSONAL_SPEAKER_PROFILE_ID`必須為獲核准GUID，不能重用／猜Voice Live的私人voice name。`DIRECT_SPEECH_PERSONAL_VOICE_MODEL`為`DragonLatestNeural`、`DragonHDOmniLatestNeural`或`PhoenixLatestNeural`。送出flush包含最後partial worklet buffer，排程PCM播完才恢復收音。Professional Voice接點已實作：明確`azure-custom`加`VOICE_LIVE_CUSTOM_VOICE_NAME`／`VOICE_LIVE_CUSTOM_VOICE_ENDPOINT_ID`映射`name`／`endpoint_id`；須訓練完成、獲授權且同資源，**目前未配置資產**。

完整設定及官方來源見[Foundry指南](FOUNDRY.md#四種語音架構)；同一客戶講稿、臺灣聽評、slot／intent及量測方法見[比較指南](VOICE-COMPARISON.md)與[示範講稿](DEMO-SCRIPT.md)。browser顯示同一server單調時鐘算出的numeric stage durations，另量本機first packet→playback scheduling delay，非實際聲學出聲。GPT分開記backend結果前`frontend_audio`及結果後`first_audio`，後者不代表語意答案完成。metrics只保留最後一回合numeric IDs／數值於記憶體，無持久報表／下載、不存錄音／逐字稿，不跨host相減、不列未量測排名。

## 既有業務基線

| 已交付項目 | 行為與限制 |
|---|---|
| 繁中聊天 | 梅好 Airlines 專案示範品牌；原生Node HTTP／browser modules，無前端build；自然探索、五天規劃、合成搜尋與文字模擬結帳 |
| 四代理 | 後端協調intent／planner／flight／price，不是自主A2A；工具與旅程權威在後端 |
| 同源票價工具／MCP | 有界機場／日期搜尋、選班、expiry、reprice、完整呈現、明確同意及冪等模擬確認 |
| 城市／機場維護 | 43城市群組、45參考機場、122別名關係；多機場／排除／跨國同名澄清；地理不代表可售航線 |
| 對話呈現 | canonical每則最多50 meaningful words；「繼續」保留完整內容；文字／語音共用100成功回合，15秒等待提示不另呼叫模型或TTS |

既有agent refs（歷史部署資料，未為本次管理GET核驗）：

| 角色 | 此程式的新部署預設名稱 | 既有雲端資源是否重新命名 |
|---|---|---|
| intent | `meihao-intent-agent` | 否；本次未操作雲端 |
| planner | `meihao-travel-planner-agent` | 否；本次未操作雲端 |
| flight | `meihao-flight-checker-agent` | 否；本次未操作雲端 |
| price | `meihao-price-purchase-agent` | 否；本次未操作雲端 |

使用既有`gpt-5.4` deployment及四個managed vector stores；新環境不能複製名稱就假定有權限。合成資料涵蓋**2026-10-16至2027-02-12**，45機場、86有向路線、20,640 dated flights、48,000 fares；全數為虛構示範資料，不代表航空公司營運、真實庫存或價格。`DEMO-FLT-*`不是實際班號；無付款、訂位、開票、退款或卡號／護照收集。15個TXT知識快照由manifest列出，不代替工具查價、reprice及同意；重新上傳／索引須另核准。

發音層不改canonical識別碼／價格：`DEMO101`逐碼讀出、`DEMO0101`保留前置零，`TPE`逐字母；日期、月日區間、時間與TWD按繁中語意，安全URL只說連結在畫面。Personal Voice的Voice Live `name`與Speech SSML `speakerProfileId`不同。歷史取得音訊不等於字母正確性、相似度或新規則已試聽。

## 重現與維護

Node.js >=22。此開發機私人`.env`為已核准付費foundry模式，**離線重現不要直接沿用**。在乾淨副本使用下列方式，不讀私人`.env`：

```powershell
Set-Location C:\Code\travelagent
npm DEMO
$env:APP_MODE = 'mock'
$env:VOICE_LIVE_ENABLED = 'false'
$env:VOICE_LIVE_REALTIME_ENABLED = 'false'
$env:GPT_LIVE_ENABLED = 'false'
$env:DIRECT_SPEECH_ENABLED = 'false'
$env:PAYMENT_PROVIDER = 'mock'
$env:PORT = '3102'
node server.js
```

這是重現命令，不表示本次有啟動3102。Ctrl+C只停止自己啟動的程序；`npm start`會載入`.env`，不得為比較自行啟動live。mock支援有限離線語句，不等於任意GPT理解。舊checkout若還有`VOICE_LIVE_STANDARD_ENABLED`也應保持false，不把它當新版第四模式。

離線檢查：`npm run check`、`npm run check:mapping-voice`、`npm test`、`npm run test:ui`。Playwright使用獨立mock 3101；缺瀏覽器時依組織核准政策準備，不為此下載非核准來源。不要為重現執行`deploy:agents`、`ingest:knowledge`、`test:voice:live`或任何雲端`--apply`腳本。

城市Excel範本與dry run／原子apply見[對照維護](CITY-AIRPORT-MAPPING.md)。需Python3與固定`openpyxl==3.1.5`；缺依賴時使用`scripts\requirements-workbook.txt`指定的組織核准feed。apply只替換地理快照，不建立可售航線，下次受控重啟才載入。

## 歷史證據：不是新四架構驗收

- 2026-10-19的3100 health曾回build `6b6814aca5deb4b2`；其後經核准曾重啟至`95454a00cfb73382`並配置GPT-Live。兩個都是**歷史build**，不能當成本次新source已載入證據；health也不保證雲端依賴健康。本次未重新讀取／重啟預覽。
- 舊收尾曾有XLSX Python reader約30秒逾時，後續連續讀取與suite通過；根因未證明、未加timeout或略過測試。當時79/79 Node、8/8 UI及後續舊四選項96/96、12/12為不同階段歷史數字，**不證明本次Speech REST或Realtime 2.1通過**。
- GPT-Live output曾觀察有效PCM但缺`start_ms`／`end_ms`，新增明示連續播放相容；先前base64／timing診斷不能概括為整體live成功。沒有在本次代使用者重試。
- Personal Voice過往同資源metadata／握手／固定合成取得音訊，沒有錄音／訓練／複製聲音，未評估聲學相似度。未為比較重新合成私人預覽WAV。
- `prototypes\hosted-adapter\`僅隔離離線原型：官方Python Invocations host接loopback Node，過往SDK ASGI、HTTP／WS smoke成功；不證明Azure/Linux雙行程映像、managed identity、平台路由或公開HTTPS／WSS完成。

## 記憶體、費用與分享

旅程／報價／同意／模擬收據memory-only；session最多100、閒置1小時失效，重啟／失效遺失，不跨instance恢復。既有全域Voice上限4，不宣稱已支援5人並行。不限制每旅程累計Voice連線次數；每旅程100成功回合、60工具單位、600雲端requests／2.4M回報tokens軟門檻不是帳單上限。

Azure部署仍暫停；沒有正式登入、公開URL、Dockerfile／IaC或持久化月用量ledger。未來US$100 admission估算需求不是已實作功能或Azure帳單硬上限，不做費用優劣推測。

公開來源目的地為[GitHub repository](https://github.com/punmeng/travel-agent-with-voice-live)，不是已部署網站；push結果以實際命令為準，本次不commit／push。`.gitignore`排除私人`.env`、`.foundry`、`.copilot-azure`、憑證、logs、WAV／recordings、venv與依賴等。不要整個資料夾ZIP分享；只發布核准來源／合成資料／manifest所列知識檔，不加入私人證據或過期快照。
> 最新離線驗證：完整 Node **113/113**、Playwright **15/15**、兩組語法檢查與 diff 檢查通過。這不是雲端語音驗收。
>
> 啟用狀態補充：本次最後檢查 `http://127.0.0.1:3100/api/health` 連線遭拒，未發現 3100 listener；先前預覽命令亦不在目前命令登錄中，結束原因未確認。本次未停止或重啟預覽，也未變更私人 `.env`。不得把先前 `gpt-realtime` 的啟用結果視為新 `gpt-realtime-2.1` 已啟用；後續須另行核准設定與啟動。
> 語音失敗診斷補充：`response.done`失敗或不符唯一completed function契約時，新增僅含allowlist狀態／錯誤分類、output數量、最多8個item類型／狀態／是否預期工具的本機診斷。不記錄原始錯誤訊息、參數、逐字稿、音訊或服務識別碼。前端模型失敗使用`VOICE_REALTIME_RESPONSE`，朗讀失敗仍為`VOICE_SYNTHESIS`。沒有放寬委派或交易檢查；需要核准重啟後才會生效。
