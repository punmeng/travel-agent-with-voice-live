# Ni Airlines：同一講稿比較四種語音架構

## 英文demo add-on（v1.0.8候選，取得啟用窗口後才使用）

切換到English，確認新回覆與面板為英文；切換前的歷史訊息維持原文。先停止語音再換語言，無需清除同一旅程。四種語音仍為相同路徑與交易守門，語言選擇不是自動語言偵測，也沒有新增真人音質排行。

依序輸入或在支援的英文語音連線說：

> Plan a five-day business trip from Taoyuan to Narita on November 12, 2026 for two adults, economy, with less walking.
>
> Meetings on days 2 and 3 from 09:00 to 17:00 at Tokyo Station. Day 4 afternoon visit Asakusa for shopping.
>
> Stay near Tokyo Station for 4 nights. The flights and accommodation budget is TWD 50000, with transport and meals separate. Arrange airport transfers.
>
> Search flights.

核對5天／economy（business trip不是business艙）、TPE→NRT、2026-11-12、2人、少步行；會議09:00–17:00不排活動，Asakusa不改航班目的地，合計預算不套成機票獨立預算。平常語音摘要、畫面完整；`Explain day 2 in detail`只展開第2天。這四輪已作真實Foundry整合，但四模式真人聽評仍要逐條記錄，不能把有限ack當聲學測試結果。

要展示交易，先停止語音，再以文字`select flight 1` → `reprice`，核對當前總額、版本、幣別與期限後才說`confirm current quote`。`confirm`、否定或附條件文字不執行同意。結帳仍是session專屬的模擬頁，不訂票、不扣款；切回繁中時同一旅程、quote與既有文字都保留。

## 示範前先說明

2026-10-24補充：使用者核准後v1.0.7 queue／進階設定已整批啟用，3100為`578ae578a2f9b6f5`；重啟已清除旅程並中斷舊語音，請reload。後續真人驗收包含SDK同connection兩句EOF、Option2工具中插話、Option1無效需求後下一輪、GPT疑似片段澄清、舊segment ACK及模式獨立設定。已有SDK服務與離線回歸證據不取代四模式共同講稿或真人聽評。

「這是非官方航空旅遊POC，四種語音前端都委派**同一組外部GPT-5.4四代理**。航班、價格與付款都是合成，不會扣款、訂位或開票。今天比較自然臺灣華語、意圖／欄位保留、錯誤、更正及等待時間，不預設哪個最好。」

**本文件是待核准live驗收講稿，不是已完成結果。** 2026-10-22經使用者核准已載入新版3100預覽；四模式配置可用，模式2為精確`gpt-realtime-2.1`，模式4提供REST／SDK切換。這只證明配置與本機介面，不代表四條已通過Azure端到端試聽；不能為準備demo自行登入、查資產、切model或執行付費測試。

實際設定與歷史證據見[版本交接](CURRENT-VERSION.md)；正式測試矩陣／評分／量測欄位見[四架構比較](VOICE-COMPARISON.md)。每模式約5–8分鐘；完整重複／聲學條件需另排時間及費用批准。

## 四條路徑：按這個順序介紹

1. **Voice Live `voice-live`**：`azure-speech` zh-TW STT → 外部同四代理 → `pre_generated` exact-text Personal Voice。`autoanswers=false`，沒有額外Voice Live GPT-5.4推理。
2. **Voice Live `voice-realtime`**：指定`gpt-realtime-2.1`音訊原生前端 → 受控`travel_backend` → 同四代理 → `function_call_output` → Voice Live音訊。本次輸出是Azure標準`zh-TW-HsiaoChenNeural`，不是模型built-in；無STT配置，畫面委派需求標「模型整理」，非原話。
3. **`gpt-live`**：獨立`gpt-live-1` API、built-in聲音 → client delegation → 同四代理。現接線靠timed user transcript定位委派，不是原音訊直交四代理；臺灣instructions不保證口音，也不能改為Personal Voice。
4. **`speech-direct`**：A為原Speech REST 16kHz WAV zh-TW STT對照組；B為Speech SDK連續串流辨識（固定zh-TW、700／1000ms停頓切段及可選phrase list），可選即時麥克風或8／16kHz mono PCM16 WAV，以預設1280 bytes實時推送並顯示辨識事件與timing。兩者接同四代理及Speech REST SSML Personal Voice，完全不經Voice Live，用核准speakerProfileId與base model。REST按開始後先安靜約300ms，停頓約1秒自動送出；最長28秒片段／server硬限30秒。SDK每個final辨識片段依序委派，不以session_stopped當語句完成。兩者均為聲學切段、非語意VAD，排程PCM播完才恢復收音，仍為半雙工；WAV上限120秒，非MRCP／RTP閘道。

模式2／3／4後端禁止選班、reprice、同意及購買；這份四模式比較**全部唯讀**。想展示交易，先停止語音，於末尾另用文字示範。

## 示範前一分鐘：控制比較條件

- 經授權受控載入新版後才核對實際build／availability；不可用模式記「設定阻擋，未測」，不fallback。不要公開`.env`、voice ID、token或endpoint。
- 使用同一瀏覽器版本、麥克風、輸出裝置、音量、網路、語者、相對距離；每模式開等效乾淨旅程／相同資料版本。切換先停止，不在同一旅程累積前一模式偏好當比較。
- 先耳機安靜，再做喇叭、固定可控背景噪音。四者都只要求browser best-effort `noiseSuppression`／`echoCancellation`；沒有相同AEC效果保證。不得含旁人談話／個資，不錄音留存作metrics。
- 以下固定日期**2026-11-12**仍在合成資料範圍2026-10-16～2027-02-12且為未來時才能用；日期失效就先修訂整套共同腳本，不讓各模式自行猜年份。
- 先暖機與否要一致，正式測試每條件／模式至少重複5次，另報失敗；不要把單次感受當p50／p95。評測順序輪替，介紹順序仍固定1→2→3→4。

## 0:00–1:30｜自然臺灣華語與規劃

先說：「我想去東京玩五天，帶媽媽，不要走太多路，想要有地方坐著休息。」

預期：intent／planner保留東京、五天、少步行、休息偏好；不從「帶媽媽」自猜人數或年齡，不強迫先填機場／日期才能規劃。五天不能少成三天；交通、無障礙、景點營業未即時核驗。

畫面一次顯示完整canonical，不說「繼續」。依序測「整理目前行程、建議行程和機票資訊」→「五天全部展開」→「第二天詳細一點」：摘要語音簡短、詳細自動接續、工作時段保留、指定日不改旅程天數。停止應清除待播段。模式2／3依後端完整資料生成語音；選班、報價與明確同意以畫面及權威quote context核對。

## 1:30–3:00｜同一個搜尋需求

逐字說：

> 「幫我看二零二六年十一月十二號，桃園TPE到東京成田NRT，兩位成人，經濟艙，總預算新臺幣三萬元。先看去程，不要買；行程還是不要走太多路。」

共同核對：`2026-11-12`、`TPE`、`NRT`、2 adults、economy、`TWD 30000`、少步行、唯讀搜尋；若追問只回答同一預先定義資訊，不額外提示某模式。發生空結果也如實呈現，不放寬預算／機場／艙等去湊結果。

講者：「這裡是同一份合成資料的搜尋，不是真實庫存或可售價格。Voice Live Realtime畫面的『模型整理』不是辨識逐字稿，我們評的是原話意圖／slot有沒有留住，不能拿它冒充STT準確率。」

## 3:00–4:00｜口語、中英混說與班號發音

說：「一樣桃園到Narita，two adults，economy，budget三萬。先不要訂，媽媽走路不要太多。」

確認不丟失原日期、不改人數／預算／目的地。若模型不確定應澄清，不能因英文就任意切換所有語言或補其他機場。模式1／4是固定zh-TW，不是auto LID；模式2／3原生多語也未保證此混說成功。

再說：

> 「以下只是發音測試，不是查真實航班：請讀DEMO101、DEMO0101、TPE、NRT、十一月十二號、新臺幣三萬元。」

先看canonical是否確有要求字串再評朗讀；若回覆省略，記內容遺漏，不假裝已測該字。DEMO101應能區別C／I／一零一，DEMO0101不能少前置零。**DEMO101是固定發音slot，不聲稱11/12有這班或在合成結果存在**。模式1／4有exact-text發音層；模式2／3可能改述，逐項記錯，不預填成績。

## 4:00–5:30｜更正、插話及噪音／回音

先說：「出發改成十一月十三號。」

在等待或播放時說：「不是十三號，改回十一月十二號；其他都一樣，先不要買。」

模式1測只讀舊請求／播放取消與最新更正。模式2／3記實際停止、排隊、更正／過時回覆情況，不宣稱一定無縫全雙工。**模式4半雙工時不在播放中把話當已收錄**：正常等排程PCM播完才恢復收音；若停止session，重新開始校準後說同一句、停頓自動送出。把等待、誤觸／漏觸與恢復時間列結果；VAD不能消除回音或提供插話。

依核准測試計畫，用同一講稿重跑耳機安靜、喇叭安靜、耳機固定噪音、喇叭固定噪音；觀察助理聲音會不會被當新使用者、漏字、誤觸發或自我循環。沒有實測就說「未測」。phrase list僅比較**實際已配置**的能力，短音訊Speech REST無此支援，不暗加提示替它宣稱支援。

## 5:30–6:30｜唯讀安全與結果

在每模式相同搜尋狀態說：「先不要買，只整理目前條件。」核對不產生選班／quote／consent／checkout變更。

模式2／3／4另用相同已有候選的受控測試狀態說：「選第一班，幫我重新報價，我同意，現在買。」預期server拒絕，停止後回文字；不能把「沒有候選所以沒成交」當交易guard測試成功，也不拿模式1執行這段比較。guard失敗就停止demo，不能僅相信模型說沒有買。

結語：「選擇取決於要確切文字／品牌聲音、音訊互動或聲學VAD半雙工。現在不宣稱哪個辨識、臺灣口音或延遲最佳；要用同條件重複測試的slots／intent／錯誤率、臺灣母語者盲評與實測stage metrics作判斷。」

## 選配：停止語音後的文字模擬結帳（不納入四模式分數）

以當前工具實際列出的合成候選，文字輸入「選第一班」→「幫我看看現在這個票價，準備結帳」。等**完整最新報價**、版本、TWD總額、期限均顯示後，再明確接受：「我同意這個報價，請給我模擬結帳連結。」

打開同session限時連結核對金額與行程；沒有卡號欄、不扣款、不訂位、不開票。空結果／過期就調整共同條件或重新報價，絕不硬編候選。文字與語音旅程共用；更改人數會使舊候選、報價、同意與連結失效。

## 最小故障處理

| 狀況 | 說明與處理 |
|---|---|
| 模式不可用／model不符 | 記設定阻擋；不取麥克風、不換model／聲音、不把舊preview當新版 |
| 麥克風拒絕 | 使用者自行核對網站權限；停止後可用文字，明說未完成語音測試 |
| 雲端權限／連線失敗 | 記錯誤code／numeric run ID，不貼token／音訊／原話；停止，不自動fallback或付費重試 |
| 辨識／模型整理錯誤 | 按同一更正腳本重測，記漏slot／錯intent／多問次數；不能成交 |
| GPT-Live untimed output | 明示連續PCM相容、不能還原省略靜音；不得補造input timing授權委派 |
| Direct停頓／長句／噪音 | 聲學VAD停頓約1秒送出，短於200ms聲響不送；最長28秒片段／30秒硬限。測600ms自然停頓、安靜、穩定噪音與突發聲；漏觸／誤觸／截句都記錄 |
| 回合額度用盡 | 共用100成功回合；不限制每旅程累計連線次數，新旅程會清狀態，對所有模式保持同條件 |
