# 本機版本交接：v1.0.6已啟用（2026-10-24）

目前3100啟動build為 **`b451311c607461c4`**，版本仍為v1.0.6；下方`f35b73acf22f25de`保留為首次啟用紀錄。現行緊湊選單僅在Option1顯示「個人化男聲／個人化女聲」，預設男聲；後端只接受`alexpun`／`athena`白名單key，連線期間禁止切換。Option4 REST／SDK維持男聲。build是啟動時快照，不代表後續工作區編修已載入；本輪文件清理未重啟服務。

**仍未解決／未驗收：** GPT委派截句、SDK漏第二句、10:36插話後`ZodError`，以及「都OK」與原始ASR不一致。選單及朗讀修正不代表上述問題已修復，也不代表真人音色／聲學效果通過。

**待啟用的原始碼清理（未升版）：** 新增Node測試先重現`savedPlan`將成田→東京交通建議錯套大阪KIX／羽田的問題；共用`airportTransferAdvice`現在只在已確認NRT＋東京時提供成田建議，其他情況改為通用且待核驗的交通說明。原先未使用的`answerPolicy`也改由`invokeFoundry`的task及`buildDefinitions`／`enable-conversation`指示建構共用，僅修改本機來源，未部署雲端agent。上述來源變更尚待受控重啟載入；3100仍為v1.0.6／`b451311c607461c4`，沒有live驗證或已在線修復的宣稱。

Option2等待工具／thinking時插話的後端來源修正位於`lib\voice.js`，45/45項voice Node測試通過：`speech_started`停止舊播放但不中止／重跑舊後端工作，最多保留一個committed音訊項目；等待pending工具完成且後端鎖釋放，或舊音訊response終止（包含取消遲到的`response.created`）後，才序列派送下一次`travel_backend`。重複audio／call ID仍去重，無效工具及交易仍拒絕；佇列超量明確回`VOICE_PENDING_LIMIT`，取消等待20秒逾時回`VOICE_REALTIME_TIMEOUT`。安全錯誤補上timestamp／mode，不含內容。這是待重啟的本機來源修正，不是3100已啟用或live插話驗收。

11:33 SDK「有partial、未見agent」截圖至少有一個final；既有stdout沒有SDK error，但沒有phase traces，尚不能定位停在哪一層。新增零PCM＋`recognized`→agent→播放完成resume的離線測試，未修改正式SDK流程；此現象及漏第二句仍未解決，不能宣稱VAD已修復。3100版本／build維持上述值。

使用者明確選擇「start now」後，已套用驗證過的前端、受控重啟3100一次，實際 **v1.0.6／build `f35b73acf22f25de`**，網址 `http://127.0.0.1:3100`。舊語音已中斷、記憶體旅程清除；舊cookie確認換新空旅程。health／bootstrap／桌面與手機頁尾版本一致，Powered by Microsoft Innovation Taipei保留，四模式及REST／SDK可選。served UI確認僅選項1顯示男聲／女聲、預設男聲、連線中disabled、停止後恢復；該UI檢查使用瀏覽器本地transport mocks，未呼叫付費語音或模型。證據：session files的`release-106-activation.json`、`release-106-picker.log`及桌面／手機截圖。

v1.0.6僅新增選項1的「男聲／女聲」Personal Voice選擇，預設男聲。後端固定白名單key經單次票券選定聲音，不修改全域預設；不同連線可同時選不同聲音。選項2／3／4不接受此參數，選項4 REST／SDK維持原男聲。UI只列男聲／女聲，隱藏資產id、speakerProfileId及顯示名稱，連線期間禁止切換。

既有Voice Live資源已唯讀確認新女聲資產唯一匹配且`Succeeded`；原始voice id與speakerProfileId各自核對，不使用Professional Voice endpoint id。新女聲最短固定文字合成確認type／name／model後收到107,936 bytes、24kHz PCM，未使用fallback。40項Node語音回歸通過（包含兩session同時選女聲與預設男聲、非法key及跨模式拒絕）；自包含browser測試確認選單字樣、預設、模式隱藏、票券key、連線禁用及停止恢復。證據在session files的`athena-metadata.json`、`athena-live-synthesis.log`、`voice-selector-node.log`與`voice-selector-ui.log`。

啟用前新前端暫存session files的`voice-selector-staged.js`並以route override隔離驗證，未熱部署到舊協定；使用者曾選擇稍後啟用，之後改為「start now」才套用與重啟。未修改插話／ASR問題、未commit／push。

## v1.0.5 Personal Voice更新

本次依使用者核准，只更新選項1與選項4 REST／SDK的既有Personal Voice參照，已受控重啟3100啟用 **v1.0.5／build `3318b7cebd424ca5`**，網址 `http://127.0.0.1:3100`。原記憶體旅程已清除、語音中斷，舊cookie確認已換新空旅程；health／bootstrap／桌面與手機頁尾版本一致，四模式及REST／SDK皆可選，Powered by Microsoft Innovation Taipei保留。使用者須重新載入頁面後開始。啟用證據為session files的`release-105-activation.json`及桌面／手機截圖。

Voice Live以同資源Personal Voices API回傳的voice資源id填`VOICE_LIVE_PERSONAL_VOICE_NAME`；直接Speech以同一資產的speakerProfileId填`DIRECT_SPEECH_PERSONAL_SPEAKER_PROFILE_ID`。兩個既有資源皆確認唯一匹配且`Succeeded`，base model維持`DragonLatestNeural`；識別值只存忽略的`.env`與本機證據，不放repo文件或前端。

啟用前Voice Live服務確認type／name／model後，固定短句合成收到107,936 bytes、24kHz PCM；直接Speech TTS以新speakerProfileId收到HTTP200、87,360 bytes、24kHz PCM。選項4 REST與SDK的辨識入口共用同一SSML／REST TTS，沒有另改SDK辨識。未建立／複製voice、身分或資源。未修改選項2／3、STT、插話或未知機場問題；未做真人音色相似度聽評。證據為session files的`personal-voice-metadata.json`、`personal-voice-live-synthesis.log`與`personal-voice-direct-synthesis.json`。

## v1.0.4啟用紀錄

本次修正完成後依用戶「restart」授權，3100已重啟為 **v1.0.4／build `aef91f4f48ac430d`**，網址 `http://127.0.0.1:3100`；該埠舊旅程與語音已清除。health／bootstrap／桌面與手機頁尾一致，四模式及REST／SDK可選，實際served前端包含inputAudioAck與未確認音訊限制。只保留3100，未新增付費runner。使用者須重新載入頁面取得新模組後再開始語音。啟用證據：session files的`release-104-activation.json`、`release-104-1440.png`及`release-104-390.png`。

09:36選項1安全日誌：`VOICE_AUDIO_LIMIT/input_rate`，`windowBytes=147456`、`inputBytes=884736`、`upstreamBufferedBytes=193165`，correlationId `f41b9b92-0dcb-4a2f-9d40-aacae2b8ad22`。超過原144000 bytes視窗限額，未達1MB上游背壓門檻。當時served前端已有48KB/s wall-clock token credit，但瀏覽器`bufferedAmount`不包含已交給作業系統／網路而尚未被後端處理的音訊。歷史日誌沒有用戶分頁模組hash或封包抵達時間，實際停頓層仍缺量測。

離線瀏覽器重現：每86ms送4096 bytes，36包均可通過舊節流且bufferedAmount始終0；若延後集中抵達，即形成147456 bytes突發。v1.0.4選項1以ready協商`inputFlow.maxUnackedBytes=12288`，後端每收到PCM回`inputAudioAck.receivedBytes`，前端最多允許12288 bytes未確認。超額的新收音略過並提示重說，不累積待送queue；確認抵達後只恢復新收音，不補送舊音訊。靜音期間仍確認收到的在途包，避免恢復時卡死；確認值須單調、整數且不超過實際送出量。

原144000 bytes入站視窗、1MB上游背壓、session累計限制、timestamp freshness及48KB/s節流均保留；新診斷補上windowMs。此協定只套選項1，其餘模式不改。39項Node語音回歸與15項browser播放／收音測試通過，涵蓋延遲傳輸重現、未確認上限、恢復、錯誤確認及既有guards，log為session files的`input-ack-node.log`及`input-ack-browser.log`。沒有付費雲端runner。

## v1.0.3啟用紀錄

使用者明確核准後，3100已受控重啟至 **v1.0.3／build `d82582b2ba1f910e`**，網址 `http://127.0.0.1:3100`。舊記憶體旅程已清除、語音連線已中斷；用舊cookie讀bootstrap確認建立新空旅程。intent／planner解析為7，flight7、price5。health與bootstrap版本一致，實際served完整文字及播放ack前端；桌面／手機頁尾為v1.0.3與Powered by Microsoft Innovation Taipei，四語音模式及REST／SDK可選，頁尾位於輸入區下方。啟用檢查沒有呼叫付費語音或模型。

依後續「remove all non 3100 server」授權，停止本專案自有3102舊服務；3101／3103原已停止。核對已知shell與Node命令後，僅保留3100自有服務（Node PID 170364），3101／3102／3103連線皆關閉。未刪除程式碼或資料。啟用證據：session files的`release-103-activation.json`、`release-103-1440.png`及`release-103-390.png`。

## v1.0.3：完整畫面與獨立朗讀

完整canonical答案不再50詞分頁，不再要求說「繼續」，新問題清除舊reply queue。行程依已保存天數、會議及活動逐日列出；明確要求詳細時補充標示為建議的餐食、交通與休息安排，指定某日就先回答該日。「第2天／這兩天」不再誤改整趟天數。

詳細planner使用原本的一次呼叫輸出有界`days[{day,advice}]`，後端核驗日期集合、順序、每段最多500字，再併在對應的權威日程後；不重複整份模型行程。錯誤JSON、缺日、重複日及超長建議回傳`FOUNDRY_PLAN`，會議資料保留。此補充不呼叫外部工具、不查即時場所資訊，建議標明待核驗。會議全段保留，不自行切分會議或指定午休。

一般語音摘要放在獨立`result.speech`，畫面`result.text`與quote不刪減。Option1及REST／SDK使用最多48段、每段120字元的內部朗讀，下一段等瀏覽器確認本段播放完才合成；原60秒解碼buffer、30秒排程窗口、音訊總量守門及停止控制保留。播放確認45秒逾時明確停止，畫面文字保留。Realtime收到完整朗讀資料與detail；GPT-Live以有界thinking資料片段加commentary生成語音，沒有虛構audio-done事件。

intent依本輪語意判斷朗讀深度；一般規劃、推薦住宿、會議更新及預算估算使用摘要，前一輪要求詳細不延續至新問題。畫面完整與語音詳略分開，不以問題工作量決定完整朗讀。

Foundry實測拒絕`agent_reference`同時傳入instructions（HTTP400），已移除該不支援寫法。依使用者確認，既有intent／planner各從6新增為7，僅更新完整回答指示及intent presentation schema，管理GET核對模型、工具、知識與身分設定原樣。當時`data/foundry-presentation.json`（現已移至Git忽略的`.foundry\presentation.json`；缺檔不重映射）以完整project endpoint的SHA256＋明確agent名＋原版號6精確匹配才選用7；flight／price不變，`.env`不變。尚在執行的3100／3102載入舊程式與舊固定版本，不受對照檔影響。一般詳細請求仍intent＋planner，沒有額外摘要模型；整理已存事實不另外呼叫模型。

最終隔離build `d82582b2ba1f910e`。原始三則商務講稿後接「整理目前行程、建議行程和機票資訊」→「五天全部展開」→「第二天詳細一點」，真實Foundry瀏覽器6回合通過；核對完整DOM文字及角色標籤，沒有隱藏頁。普通三回合皆使用摘要語音。整理畫面896字／語音129字；全部展開1237字、13個內部朗讀段，每日只列一次；第二天225字、2段，先回答09:00–17:00東京車站會議與會前會後建議。兩天會議、淺草、四晚住宿與TWD40,000範圍保留，沒有選班或quote。票價來自本機`search_flights`示範工具。

最終這組10個Responses、服務回報55,019 tokens，角色為intent7／planner7；整理0模型呼叫，flight／price模型未呼叫。內容調整四次run合計40個有完整usage的Responses、219,691 reported tokens。新語音序列本輪以Option1橋接、REST／SDK及browser離線測試驗證，沒有新增Speech／Voice Live付費合成。完整Node 170/170、browser 38/38及語法檢查通過。主要本機證據：session files的`full-delivery-live.json`、`full-delivery-live.png`、`full-delivery-all-node-final.log`、`full-delivery-ui.log`與`presentation-versions.json`。

隔離驗證收尾時3103已停止，當時3100仍為v1.0.2／`4c47a200c7e71aff`，3102為`0c561892106926ca`。後續授權啟用與服務清理結果見本文件開頭。已知GPT截句及SDK漏第二句留待原任務處理。

## v1.0.2整合

使用者明確核准重啟3100。此版本保留Option1前端傳送節流，並啟用共用有效期限朗讀：帶時區ISO期限轉台北時間、讀至分鐘，不讀秒或毫秒。畫面、offer、quote與同意資料保留完整原期限；Realtime函式朗讀輸入也套用相同格式。77項相關語音回歸通過，涵蓋UTC跨日／跨年及原始資料不變。本次沒有新增付費語音測試。3100旅程於重啟清除，3102保留。

實際啟用：`http://127.0.0.1:3100`，health版本`1.0.2`、build `4c47a200c7e71aff`。bootstrap與實際瀏覽器頁尾版本一致；四種語音模式可選、Option4 REST／SDK可切換，桌面／手機頁尾無重疊。3102仍為build `0c561892106926ca`。

## v1.0.1整合

依使用者要求，將下方隔離驗證已完成的未知機場保護、機場澄清綁定、GPT重連旅程投影及完整句委派提示整合至3100，版本更新為1.0.1，實際health build為`f48ffcb8b672509d`。受控重啟清除3100記憶體旅程，3102保留`0c561892106926ca`。頁尾版本與Powered by Microsoft Innovation Taipei沿用集中來源。啟用前29項相關Node與語法檢查通過；啟用後health/bootstrap及手機UI確認四種模式、REST/SDK皆可選，未建立語音連線。3103保持停止。

GPT第六句截斷、SDK第八句第二段缺失仍未解決。本次不變更STT預設、不新增付費語音測試。

23:08 Option1日誌記錄`VOICE_AUDIO_LIMIT/input_rate`，視窗147,456 bytes、累計1,593,344 bytes、上游buffer 0，關聯碼`2153c353-429c-4992-ad86-0c8420cf503f`。前端補上獨立於音訊時鐘的48,000 bytes/s傳送額度，最多12,288 bytes突發／待送；超額積壓直接略過並提示重說，不排隊補送。原有timestamp freshness及後端守門保持。此修正熱更新`public/voice.js`、未重啟3100；需重新載入頁面取得新模組，旅程仍保留。health build記錄啟動時版本，前端熱修正另以此節辨識。

## v1.0.0啟用紀錄

經使用者要求，最新程式已整合至`http://127.0.0.1:3100`，Foundry模式，health build為`fdccdce342289665`。版本來源為`package.json`；health、bootstrap、MCP與頁尾使用同一版本。頁尾顯示 **v1.0.0** 與 **Powered by Microsoft Innovation Taipei**。受控重啟會清除3100原有記憶體旅程；3102維持原行程、未重啟。

文字聊天採完整當回回答，不再要求「繼續」才能看到重點；語音仍保留分段。單一版本化旅程保存目的地、機場選項、會議、活動、住宿區域、預算範圍與待回答問題。普通場地提及不改目的地，詢問住宿理由不覆寫住宿區域；既有票價可直接列出，不必重新搜尋或進入購買流程。未計回程時，去程票價扣除後的餘額須同時保留回程與住宿；交通、餐費列明按人數／天數的預算假設，沒有飯店即時庫存或房價查詢。

實際Foundry瀏覽器驗證涵蓋21回合的東京、短句追問與大阪情境；本次啟用後再於3100完成原四回合商務講稿加英文票價追問，共5回合首屏直接回覆、全部通過。實際模型依當回任務呼叫，並非每回都呼叫四個模型；摘要可使用已保存內容、不另呼叫模型／工具。160項Node及36項瀏覽器回歸通過，包含同意／報價界線及桌機／手機頁尾不重疊。

四種語音配置均可用，選項4包含REST與SDK；五條路徑已各完成單句真實服務、後端結果與瀏覽器音訊排程驗證。GPT-Live曾量得147,456 bytes在3ms內送入，命中輸入速率守門；已補上延遲錄音批次防護，沒有提高守門限額。完整九回合各模式驗證仍在進行；目前不列為完成，也未作真人聲學試聽結論。

### 後續隔離驗證（尚未啟用於3100）

3103隔離測試修正未知機場短答保留已確認城市／機場候選、依待答問題綁定角色，以及句內已核准機場別名的澄清。GPT啟動另附最小旅程與待答問題，避免重連後自行介紹機場。這些追加修正未重啟用戶3100，不能把其驗證結果歸給3100的`fdccdce342289665`。

九句音訊使用同一旅程cookie、每句重開語音連線，不是單一連線連續九輪。選項1一輪九句完成，但前一輪「步行→不行」曾漏存偏好；選項2與選項4 REST各在明確補說「少走路」後完成九句與摘要。GPT重連修正後前五句完成，第六句後端委派文字仍只到「東京車站附近開」，雖然字幕稍後包含「會」，未保存兩天會議；完整句instructions重試後仍重現，故GPT九輪尚未通過。官方沒有承諾delegation offset是使用者完整語句終點；這是現有轉錄前綴選取與完整需求解析的整合缺口，不能只稱服務故障。未把後續字幕擅自併入既有委派；原始offset數值未列入此次瀏覽器證據。

最後隔離build為`5a048697722bd3ea`。SDK完成前七句，其中第三句將「成田」辨成「陳田」後保留東京，明確補說「我要選東京的成田機場」才保存NRT。第八句「步行→不行」仍失敗；兩句式澄清在等待WAV輸入耗盡、SDK session_stopped及全部final處理後，也只得到第一句的final，未收到「少走路」第二句。SDK第九句因此未執行，九句驗證未通過；第二句在哪層缺失尚無封包級證據。所有模式此次未見先前的速率守門錯誤。後端結果、PCM送達、瀏覽器排程／ended與真人聲學聽評分開，不把前者當作後者。

最後離線回歸163項Node、36項瀏覽器及語法檢查通過。Node初輪曾有Python工作簿子程序逾時，完整串行重跑163項全部通過。3103測試helper已停止；3100保持`fdccdce342289665`、3102保持`0c561892106926ca`。

## 2026-10-22歷史紀錄

下方內容保留當時狀態及實作背景；舊build、版本、待重啟、未驗證與文字分頁敘述以本次啟用資訊為準。

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

模式2／3／4後端唯讀，選班、reprice、同意／購買都要停止後回文字；四模式客戶比較連模式1也不交易。麥克風輸入僅要求瀏覽器best-effort `noiseSuppression`／`echoCancellation`，WAV不要求麥克風或這些處理。直接Speech REST使用本機聲學VAD、SDK使用700／1000ms聲學停頓切段，都不是語意VAD／全雙工；REST無phrase list，SDK可選phrase；兩者無auto LID或server AEC。

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
npm ci
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
