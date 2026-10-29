# Foundry 四代理與 Voice Live 接線指南

## 目前本機啟用

最新為會員偏好分區版`1.0.8/a15841e3240904c1`：可信catalog投影提供compact Member preferences，Current trip獨立顯示；HTTP文字chat使用既有member ranking，Applied note僅根據實際≥2offer排序及匹配的member／trip／meetings／offer IDs。無會議時不宣稱已比對會議，guest／單offer／未排名無note；無新增語音協定或付費呼叫。business8/8/8/6、voice zh8/en9、長期記憶未啟用與其他界線不變，詳見[最新本機交接](CURRENT-VERSION.md)。

### 前次對話版面啟用紀錄

會員／Ni UI及第五模式已依使用者授權在隔離runtime的3100啟動，最新對話優先版面`1.0.8/b7e71a814d8692a4`。effective business mapping為intent8／planner8／flight8／price6，managed voice為zh8／en9；brand business9/9/9/7保持未啟用。第五模式保留12,288-byte credit／SDK send完成ACK與2秒timeout。代理狀態與本次旅程脈絡改為desktop側欄／窄屏底部，長期記憶明示未啟用。前版5a38使用者回報「should works」，未提供模式／語言／時長。本輪沒有新增付費測試或協定變更。原candidate／flow／診斷版及stable runtime可回復，.env與mapping未修改。下方未啟用文字保留當時驗證快照。

最新一次獲准的繁中診斷，在完整診斷snapshot啟用後重現ACK timeout：SDK534次send、server534次ACK callback與browser534次receipt全部一致（2,187,264 bytes），最大SDK send29ms，尚無後端結果／輸出音訊。71.7秒內遇錯停止，沒有English或付費retry。離線profile發現多秒同步module filesystem解析；真browser／官方SDK transport的cold business identity resolver案例可重現同型態，identity改啟動期載入、bridge共用server credential及smoke去除熱路徑import後通過。實際付費回合缺CPU stack，不能指定該次是哪個filesystem呼叫；修正版真人mic及真實往返尚待驗。詳見[最新本機交接](CURRENT-VERSION.md)。

## 最新候選：同item ASR唯一來源與真實會員搜尋（2026-10-29 09:38）

使用者明確選擇「採用ASR最終原文作唯一來源，繼續實作驗證（建議）」後，第五管線只把validated `travel_backend({message})`當處理trigger。仍驗strict function name／schema／唯一call／response ownership，但model-written message沒有輸入、指令、事實、同意或fallback權威。server等待**相同committed audio item**的final ASR，再把原始字串交給既有chat；當前票券locale及已驗證session會員偏好維持服務端控制，不將完整會員context放進managed voice instructions。不改既有immutable8／9的tool contract，也不新建版本。

缺失／失敗／錯item／非法final不派送，等待final的30秒timeout明確終止。回應／item去重、最多一個pending item、busy lock、interrupt／stop／換帳取消及ASR交易拒絕保留。工具message即使改數字、漏限制、改寫、加入惡意指令，也不能改變後端ASR；ASR本身仍是使用者資料，所有交易及權限guard繼續適用。原有terminal/general-punctuation/numeric比較全數降為診斷，不是模糊接受條件或ASR品質證明。`bridgeDiagnostics.delegations`在派送時記錄`source:"same-item-final-asr"`、`equalityIsDiagnosticOnly:true`及安全association／長度／相等布林，不記raw ASR／audio。

離線loopback證明不同tool.message仍收到exact ASR UTF-8 bytes，錯item不能派送；缺失／失敗／非法final、重複response／final、ASR交易嘗試均有回歸。最初real-backend zh有intent/member/audio但沒有flight，不能當完整搜尋。公開合成句重現搜尋詞與航班詞之間超過舊`0..16`字窗口，後端降回intent。`turnWork`修正只新增沿用flightOnly的句首明確搜尋詞分支（中文搜尋／查詢／查找，英文search／find／compare），排除飯店／規劃／價格／交易，負向與pause沿用；沒有unbounded wildcard或自動搜先前會議／summary。126/126相關離線通過後，獲准一次修正後zh確認，完整通過才執行一次en。

測試前唯讀generator確認TPE→NRT、2026-11-12在`2026-10-16 ≤ date < 2027-02-13`內，兩班economy availability為2／5；只查一成人、固定日期、單程。真實intent v8及flight v8各語各1call，兩個business request都有trusted memberPreferences／value及符合ticket的responseLocale。價格及排名由本機權威合成handlers提供，模型不覆寫。

| 真實確認 | zh-TW voice v8 | en-US voice v9 |
|---|---:|---:|
| intent／flight total tokens | 6,562／5,472 | 6,462／5,187 |
| SDK append／input bytes | 142／679,200 | 132／629,400 |
| 合成offers／value排序 | 2／8,900→9,100 TWD | 2／8,900→9,100 TWD |
| output PCM bytes | 1,226,400 | 865,200 |
| VAD start／stop／commit／final | 各1 | 各1 |
| service error／transcription failed | 0／0 | 0／0 |
| audioDone／diagnosticsFlushed | true／true | true／true |

這是合成輸入／真實voice及intent/flight服務／合成航班工具的完整會員搜尋往返。未測planner／price、未啟用brand9/9/9/7、其他persona live、真人mic或ASR聲學品質，沒有選班／訂位／付款。mock旅行backend先前兩語的音訊成功證據另保留，不能替代真實business evidence。完整trace、版本映射及manifest只在ignored staging，不入commit。

已獲授權的重現命令為`node --env-file=.env scripts\smoke-member-voice-live.js --apply --real-backend`：90秒每locale上限；先zh，只有完整real intent+flight／member context／offer+ranking／音訊通過才en，失敗不重試。這個命令會付費，不能當一般setup／offline check。預設不帶`--real-backend`只測mock旅行backend。runtime及stable3100未啟用候選或改`.env`；沒有新增版本／hosting／commit／push。

下一階段僅排隊調查中英日韓automatic LID／同session switching及voice政策；目前只有固定zh-TW／en-US已驗證，沒有四語能力聲稱或新資源。memory繼續獨立延後。下方按時間保留的舊阻塞是歷史。

## v1.0.8雙語版（3100已啟用）

使用者於2026-10-27核准四個既有Agent各新增雙語prompt版本：intent7→8、planner7→8、flight7→8、price5→6。舊版保留供回復；GET核對新舊僅instructions不同，模型、tools、file_search知識及intent JSON schema維持。因`agent_reference`拒絕每請求覆寫instructions，已移除prompt內固定中文的互斥要求，改依**後端傳入**`responseLocale`與`context.locale`（`zh-TW`／`en-US`）回答；使用者／歷史／檢索內容不能覆寫語言或權限。slot仍逐字摘原文，不翻譯、正規化或重寫證據。

候選對照位於Git忽略的`.foundry\language.json`；在原presentation對照後，必須project endpoint SHA-256、四角色名稱及source版本全部符合才一次映射，任何不符均不局部套用。沒有核准雙語mapping時，英文Foundry請求在認證／推理前以`FOUNDRY_LANGUAGE`拒絕，沒有假翻譯或mock成功fallback。不要把本機私人對照複製進公開範本。

`POST /api/language {"locale":"en-US"}`只改當前session；請求／語音進行中拒絕。`bootstrap.locale`、`state.locale`同步，chat／voice ticket可帶相同locale，錯配或未知值拒絕。切換不更改trip、contextVersion、quote、consent或歷史文字；語音ticket固定發行時locale，認證期間與連線前再核對，不能讓其他旅程改全域語言。英文規劃、航班、選班、確認價及結帳由同一權威資料呈現；語音另保留summary／detailed契約。合計機票住宿預算不轉成機票獨立上限，非TWD預算明確拒絕、未自行換匯。

實際四輪英文Foundry整合已通過：5天出差、2／3天會議、4天下午活動、4晚住宿／TWD50,000合計預算、查合成航班；8次模型呼叫、45,398服務回傳tokens。同旅程切回中文摘要未新增模型呼叫且保存條件；另有雙語版本各角色最小服務smoke。這些是有限服務驗證，非真人語音聽評。既有雙語agent對照仍為intent8／planner8／flight8／price6。最近一次3100唯讀health檢查於2026-10-29 04:56:32 +08:00回報連線拒絕；v5 Voice Agent及四個Ni品牌prompt版本皆為未啟用候選，細節見[版本交接](CURRENT-VERSION.md)。

## 會員示範登入與當次個人化（本機候選）

`data\member-profiles.json`、`member-personas.json`、`corporate-policies.json`及`member-credentials.json`都是虛構本機目錄。登入視窗列出五個`example.test`示範帳號與共用密碼`MeihaoDemo!2026`；credential檔僅保存每個帳號獨立salt及scrypt hash。這些示範憑證不可用於公開部署。後端`POST /api/member/login`僅接受email、password與可選`confirmReset`；身份來自伺服器session，agent不會收到密碼或完整會員目錄。

session只載入當次行程的persona排序提示；Felix另有獨立、僅供建議的mock公司政策。premium艙等只在尚未明確選艙時作軟性預設，所有當次明確選擇優先。搜尋排序只依既有合成班次欄位；飯店、相鄰座位、改票、公司核准及會員禮遇均無對應庫存／授權，不能宣稱已查得。會員偏好只由本機server傳給Foundry intent／planner／flight角色，price交易角色不接收persona偏好。

有旅程時，登入不同會員或登出會先回`MEMBER_CONFIRMATION_REQUIRED`；使用者確認後server停止舊voice、撤銷舊session、清除旅程／對話／報價／consent並輪替session cookie。舊voice ticket因此不能帶入新身份。`/api/reset`只清本趟旅程，保留登入身份與語言。登入UI候選資產在`staging\member-public`；目前3100仍為v1.0.8／build `111621bc136e5766`，未套用或重啟。此版本不含跨旅程記憶、歷史旅程回憶或Foundry memory服務。

`foundry-voice-agent`是唯一取得member-aware偏好的語音候選路徑；原有四種語音模式與既有四個業務Agent設定不變。依使用者核准，從已驗證v5建立繁中v6及英文v7，保留v1–v5、`gpt-realtime-2.1`、multilingual semantic VAD、strict `travel_backend`及`store=false`，不含web search或toolbox。GET已確認v6僅改instructions及`audio.output.voice_locale=zh-TW`；v7僅改instructions、transcription language、output voice及voice locale為en-US。2026-10-29 06:38 +08:00各一次真實session連線的`session.updated`均讀回相符instructions、transcription model/language、voice與voice locale。`staging\member-voice-locales.json`及本機runtime mapping仍為未啟用候選；沒有修改`.env`、啟動3100或執行模型／音訊回合。

## Ni Airlines品牌候選

提供的logo已加入主UI與`staging\member-public`候選，alt文字與繁中／英文標籤、title及checkout同步更新。四個目前Foundry商務prompt均含舊品牌詞，已依明確核准建立只改`definition.instructions`的不可變候選：intent8→9、planner8→9、flight8→9、price6→7。每個版本已GET讀回、確認其他prompt definition欄位未變，並保留來源版本；agent名稱、model、tools、knowledge stores、JSON schema均不變。候選對照在`staging\ni-brand-agent-versions.json`，沒有改`.env`或執行代理。managed voice產品品牌指示已納入已核准的繁中v6／英文v7 locale版本；未建立額外brand-only版本。

本機`scripts\prepare-knowledge.js`、`data\knowledge\manifest.json`及合成catalog coverage仍含舊專案名稱，作為共享知識／資料來源未被改寫。四個agent仍綁定file_search vector stores；本輪唯讀取得並檢查15份唯一遠端文件，未發現舊品牌文字。這項結果只涵蓋本次讀取的15份文件；本機生成器／manifest仍有舊標籤，沒有更新共享知識。

## 共用旅程與角色資料

`lib\conversation.js`驗證intent原文片段後，集中合併到既有session的`draft`／`trip`／`discovery`；`lib\journey.js`定義`discovery.planning`的逐日會議、活動、住宿、地面接送及預算範圍。`contextVersion`在資料改變時前進；模型呼叫前後核對版本，文字頁面帶版本送出，冪等重試仍優先返回原結果。會議時段不作航班時段，市內地點不覆寫目的機場，完整ISO／中文／斜線日期走同一解析。只有飛行條件變更才清掉候選；變更旅程仍清除選班／報價／同意；會議更新使舊行程版本失效。

當輪「規劃行程並查航班」同時完成兩項工作；預算提及機票不等於要搜尋。尚未補齊的搜尋只在補答條件時續辦，不劫持後續會議編輯或摘要。待回答欄位不再限flight路由。intent收到目前訊息、精簡事實與最近四則需求；planner收到旅程及規劃限制；flight只收到航班條件；price只收到選定ID、quote及consent。歷史機票清單、完整工具結果與舊報價不重送各角色。來源metadata與工具權限不變；沿用四個既有Foundry agents，本次完整回答使用下述核准新版本。

摘要由保存的事實組合，無額外模型呼叫。航班候選與價錢仍只取本機核准工具，飯店僅提供區域及配置額度，不能標成查得房價。每輪`diagnostics.modelCalls`列role、inputBytes及服務實際提供的input/output/total tokens；沒有usage時記null，不能用bytes推估成實測token或聲稱未量測的成本節省。`history.agent`保存實際回覆角色，重新整理不把全部歷史改標為意圖協調。

所有交付路徑的`result.text`完整顯示本輪答案，不要求「繼續」。`result.speech`另外提供平常摘要／明確詳細的朗讀文字，不能改動canonical或交易資料。「give me the ticket option」及「how much?」重用有效工具結果。完整航班／確認價納入畫面回覆後才標記呈現，語音還須收到displayed才取得該輪quote context，下一輪明確同意仍須綁定完整quote。摘要與播放確認都不是交易同意。

Foundry intent版本7的嚴格`text.format`取得presentation（summary/detailed、指定day、是否包含flights），planner版本7依本輪語意與已確認事實回答，沒有另加摘要模型。實際API不允許`agent_reference`每請求instructions覆蓋，因此使用者核准各新增一個版本，僅修改完整回答指示／intent schema。部署專屬對照移至Git忽略的`.foundry\presentation.json`，只有endpoint SHA256、agent名與原version全部符合才對照新版本；檔案不存在就不重映射，保留配置reference。既有本機對照保留，不改`.env`或雲端，也不把私人對照放進公開範本。Option1／REST／SDK詳細朗讀依句界切成最多48段、每段120字元，段與段之間等瀏覽器`segmentPlayed`確認播放排程已排空才送下一段；45秒逾時明確停止。停止／插話刪除待播，原buffer、排程及音訊總量限制保留。Realtime依detail生成回答；GPT-Live超長資料分成最多64個thinking片段（各380 UTF-8 bytes，再加短標籤），同一delegation最後只送一次commentary，原生模型自行生成連續語音，沒有新增未定義的音訊完成事件。

詳細行程的planner task要求只回`days[{day,advice}]`，同一次原有呼叫、不開工具；本機核驗日期及每段500字上限後，將標示為待核驗的建議放在各日權威資料下，避免整份日程重複。缺日、重複日或格式錯誤回`FOUNDRY_PLAN`，不以空建議假裝成功。intent只依本輪明確詳細要求決定完整朗讀，普通規劃／會議編輯／住宿／預算仍用摘要語音，畫面不縮減。

只查到去程時，總預算扣去該票價後的餘額仍須涵蓋回程與住宿，不當成已確定的飯店額度。交通／餐費使用可見的每人假設計算（機場2程×TWD1,000、市內每日TWD200、每日3餐×TWD400），乘以同行人數與天數；這是配置額度，沒有飯店空房、房價或交通即時查價。

## 候選第五語音管線：Foundry Voice Agent

`foundry-voice-agent` 是語音入口，不是新增的第五個業務代理。瀏覽器傳送PCM16 mono 24 kHz到本機server；server以Entra認證連到managed Foundry Voice Agent（`gpt-realtime-2.1`），限定它只呼叫一個strict `travel_backend({message})` function。server把與該音訊item關聯的最終Azure Speech轉錄與function參數比對，通過後只將最終轉錄交給既有 `chat()`；四個業務agent及既有 `list_airports`、`search_flights`、`get_offer`、`reprice_offer` handlers繼續由後端控制。語音Agent不直接持有這些業務工具，亦不能選班、reprice、同意、購買或要求個資；voice transaction在server拒絕。v5的GET確認唯一VAD變更為`azure_semantic_vad_multilingual`，service另加`remove_filler_words=false`預設；v1–v4及模型、instructions、tools、store=false等均保留。繁中v6／英文v7均為不可變locale候選；雙語session ACK已讀回完全相符設定，但尚未播放合成語音、執行voice delegated-turn或驗證真人麥克風，亦未啟用第五模式。

工具參數只允許 `{message}`、`additionalProperties:false`。工具呼叫須唯一且完成，並和現行response／audio item對應；需有最終服務轉錄才派送，僅正規化空白後逐字相同才接受。若有差異，或最終轉錄未到達，保持不派送並請使用者重說完整需求；不以模型改述、interim、offset外文字或另一回合補句。此檢查會拒絕部分標點／數字格式差異，且無法判定ASR與function同時漏掉的內容；需真實服務測試才能確認可用邊界。

繁中／英文依每個voice ticket的 `zh-TW`／`en-US` 設定transcription、語音及有限instructions。SDK `@azure/ai-projects` 2.9.0 的 session-update type與serializer支援 `instructions`、`audio.input.transcription`、`audio.output.voice` 及 `voice_locale`；Microsoft文件說明音訊設定為session defaults，支援的欄位可由 `session.update` 覆寫（[voice agent設定文件](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-voice-agent)）。本機線路重建確認en-US要求送出 `azure-speech/en-US`、`en-US-AvaNeural`、`voice_locale=en-US` 及英文instructions，沒有被SDK serializer丟棄。

有界契約調查確認：`connect()`只建立WebSocket，不送初始session設定；`configureSession()`送出`{type:"session.update", session:{type:"realtime", instructions, audio:{input:{transcription:{model,language}}, output:{voice,voice_locale}}}`。SDK 2.9.0的session update serializer保留instructions並序列化audio子欄位，沒有發現本機wire nesting或序列化遺失。官方文件將定義中的audio/avatar稱為session defaults，允許client用`session.update`覆寫「supported fields」；但文件沒有逐欄確認managed endpoint對上述每個語言／voice欄位的支援。SDK型別將`session.updated.session`定義為service回傳的effective settings，且明載client `event_id`不會出現在ACK。既有兩次ACK沒有回傳全部預期值，服務也沒有回傳拒絕錯誤；目前只能判定設定未獲完整確認，不能區分服務未支援、忽略或轉換欄位，亦不能把問題歸因於wrapper。

使用者已核准從v5各建立一個不可變locale版本。實際v5 GET省略optional `audio.output.voice_locale`；建立腳本容許此已觀察到的省略，並將v6明確固定為zh-TW，故v6的GET diff為`instructions`及`audio.output.voice_locale`。v7的GET diff為`instructions`、`audio.input.transcription.language`、`audio.output.voice`及`audio.output.voice_locale`；其餘definition與v5一致。`staging\member-voice-locales.json`保存project endpoint雜湊、v6／v7、GET差異與definition雜湊。`lib\voice.js`只在mapping與endpoint／agent名稱吻合且兩版本完整GET驗證時載入，並依ticket凍結的locale選v6或v7，WebSocket升級時再核對版本。已配置的source version只能是v5；未改`.env`，故候選未啟用。

SDK定義的 `event_id` 是選用client ID，只會在錯誤事件回傳，`session.updated` 不會帶回該ID；其 `event_id` 是server事件ID，不能充當request correlation。每條連線只送一個`configureSession`，以事件順序識別ACK並核對effective session設定。2026-10-29 05:42 +08:00的v5測試曾讀回舊繁中音訊，英文設定亦未套用；該歷史結果促成固定版本方案，不視為v6／v7驗收。2026-10-29 06:38 +08:00對v6 zh-TW及v7 en-US各連線一次，`session.updated`分別讀回完全相符的instructions、`azure-speech` transcription model／語言、output voice及voice locale，結果保存於`staging\member-voice-locale-ack.json`。此為session設定ACK，不是推理、音訊品質或真實使用者語音驗收。bridge仍對必需欄位不符fail closed；optional `voice_locale`若ACK省略則不單獨判錯，但若回傳錯誤locale即拒絕。

會員語音v4/v5由`scripts/create-member-voice-version.js`受限建立；v5只改multilingual semantic VAD，mapping記錄在`staging/member-voice-version.json`。locale v6／v7由`scripts/create-member-voice-locale-versions.js`依已核准的v5 source hash及遠端latest guard建立；每版GET後逐欄比對，並保留v5。Foundry GET確認v5/v6/v7皆設定`azure_semantic_vad_multilingual`、`create_response=false`、`interrupt_response=false`及唯一`travel_backend`（`tool_choice`固定該函式，參數`additionalProperties=false`）。SDK 2.9.0將`greeting.type=llm_generated`定義為session-start greeting；其專用`greeting.tool_choice`省略時預設`none`。所以`create_response=false`只關閉VAD自動建立回合，不會關閉獨立的啟動問候。候選mapping明確記錄此問候；runtime會在第一個使用者音訊前取消僅一次的啟動response，避免把無工具的歡迎語當成使用者委派，使用者回合仍需明確`response.create`要求唯一function。Foundry managed WebSocket不是avatar mode；SDK的`clearOutputAudio()`會送出avatar專用`output_audio_buffer.clear`。一次v6唯讀握手收到明確錯誤`invalid_request_error`／`avatar_not_configured`、`param=output_audio_buffer.clear`、`message="output_audio_buffer.clear is only supported in avatar mode."`，而同一response仍以`status=cancelled`結束，證明取消有效、avatar清除命令才是`VOICE_AGENT_SERVICE`來源。bridge已移除問候、打斷及待建立回應路徑的avatar-only清除呼叫；瀏覽器已在`interrupted`事件清除本機播放佇列。聚焦mock regression檢查不得呼叫該SDK方法，且問候取消後仍能將使用者回合送到`travel_backend`。

2026-10-29 07:09 +08:00以會員`ohsung-seoul`（value persona）和zh-TW v6進行一次有界合成音訊回合；Azure Speech合成 `請列出首爾到東京的航班選項。`（24 kHz PCM、174,000 bytes），經本機臨時port測試伺服器送出282,000 bytes。v6 session ACK的transcription、voice、locale、instructions hash均吻合。90秒內沒有最終轉錄、應用程式沒有要求user response、沒有`travel_backend` function call或後端/會員偏好呼叫，亦無輸出音訊；唯一`response.created`是啟動問候且成功取消。證據及音訊SHA-256保存在`staging/member-voice-live-evidence.json`；English未測，因中文回合未通過即停止，不作重複付費重試。這定位新阻塞在「音訊送達後沒有可提交的辨識回合」，但目前沒有記錄該session完整的speech/VAD event序列，因此無法分辨semantic VAD未觸發、transcription事件缺失或模型音訊處理問題。`staging/member-voice-locales.json`仍為ready但`activated=false`、`inferenceTested=false`；真實delegate、後端會員偏好行為與account-switch live ticket驗收仍未完成。未改`.env`、未啟動3100或建立hosting／Azure資源。

### 音訊送出、VAD與診斷契約

本機安裝的`@azure/ai-projects` 2.9.0實作確認`sendAudio(Uint8Array)`會送`input_audio_buffer.append`，`audio`欄位是base64；append本身沒有server ACK。foundry voice definition使用PCM 24 kHz；本地smoke以24 kHz、16-bit mono PCM，每100 ms送4,800 bytes（4800 = 24000 samples/sec × 0.1 sec × 2 bytes/sample）。官方[Voice Live API reference](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-api-reference-2026-06-01-preview)說明append格式必須符合session的`input_audio_format`，較小區塊可讓VAD更即時，但沒有規定本案必須採用的chunk大小或固定送包間隔。

SDK與官方API都定義獨立的`input_audio_buffer.commit`。官方API明確指出：server VAD會自動commit；關閉server VAD時才需要client commit；commit會建立user item並可啟動transcription，但**不會**建立model response，另需`response.create`。本agent實際使用的是`azure_semantic_vad_multilingual`；已查閱的官方頁面沒有明確逐項保證此特定semantic VAD的speech event/commit時序。前次逾時證據沒有保存該連線的VAD/commit/transcription事件序列，因此只能確認沒有應用程式response request，不能判定服務端是否曾commit或是哪個語音階段停住。bridge不因逾時自行commit；已加入有界、隱私安全的診斷，記錄允許事件名稱、相對時間、PCM frame/byte計數與有限狀態，不記原始音訊、逐字稿、item/response ID或服務錯誤訊息；測試smoke另將相同安全事件計入候選證據。這些新計數尚未套用到舊逾時回合，需待下一次另行核准的live驗證才會有實際服務事件結果。

2026-10-29 07:21 +08:00依既有一次性授權執行一輪zh-TW v6合成音訊診斷，session ACK仍符合v6設定。測試端送出59個PCM frame／282,000 bytes；本次只有一個自動啟動問候response，已取消，應用程式response request、`travel_backend` call、tool output、後端／會員呼叫及輸出音訊均為0，未收到服務錯誤，90秒後`VOICE_TURN_TIMEOUT`。**VAD及轉錄事件是否發生仍未知：**smoke evidence在首次運行時分別保存client送出計數與server traced connection計數，沒有合併server trace；本次證據已將SDK append數及事件序列標為缺失（null），不是0。最新live證據見`staging/member-voice-live-evidence.json`，候選仍`inferenceTested=false`且未啟用。現階段暫停live支出，先完成以下離線鏈路證據並交付審閱；既有付費驗證授權保留。

### 診斷持久化離線端到端證據

`tests/smoke-member-voice-live.test.js`直接使用正式smoke的`createVoiceSmokeHarness`、`runLocale`及`persistVoiceEvidence`。真實HTTP server只監聽隨機loopback port；bootstrap、示範會員登入、旅程設定、票券及WebSocket upgrade均走實際路由，僅SDK connection與語音合成注入離線實作。憑證stub一旦被使用就拋錯。三個相同locale、獨立session的連線各有不同票券hash及ACK次數，驗證JSON匯出沒有按locale錯接到其他連線。

前兩條連線在實際bridge成功append PCM後依序注入`speech_started`、`speech_stopped`、`committed`、transcription `completed`／`failed`。持久化後重新解析JSON，逐項核對wire及bridge事件順序、相對時間、狀態、eventCounts、2／3次append（9,600／14,400 bytes）與0次手動commit；預期以`VOICE_AGENT_TRANSCRIPTION`停止，僅證明診斷捕捉。第三條連線刻意讓runner timeout，SDK在延遲close期間再送`timeout_triggered`；匯出必須保存該wire事件，bridge停止後忽略的事件則仍為0。測試同時確認原始PCM／base64、逐字稿、item ID、服務訊息、權杖及登入密碼sentinel未出現在檔案或診斷log。

綁定使用server連線WeakMap及單次票券SHA-256，不輸出票券或cookie。`runLocale`的finally等待client WebSocket close、送出工作、bridge input chain、SDK close與事件迴圈，再取`bridgeDiagnostics`；關閉／捕捉失敗會保存明確錯誤，缺失trace的計數為null。已移除runner中原本額外建立、未接到server bridge的SDK連線。正式main及離線測試共用同一JSON writer；schemaVersion 2新增`results[].connectionId`、`diagnosticsFlushed`及`bridgeDiagnostics`，原`inputDiagnostics`持續保存wire層計數。離線證據另存`staging/member-voice-offline-capture-evidence.json`，不覆寫歷史live檔。

重現離線測試：`node --test tests\smoke-member-voice-live.test.js tests\voice-agent.test.js tests\voice.test.js`；可設`VOICE_OFFLINE_CAPTURE_EVIDENCE`為指定JSON完整路徑以保留產物，未設定則在測試臨時目錄檢查後清理。65/65通過；沒有雲端呼叫、3100啟動或候選啟用。下一個動作是審閱這份持久化證據，審閱前不執行下一輪live。

### 單一SDK連線真實診斷：2026-10-29 07:33 +08:00

協調session審閱上述離線JSON後，依既有授權只執行一次zh-TW v6診斷。`--zh-only`明確禁止接續英文，timeout仍為90秒；結果`VOICE_TURN_TIMEOUT`後停止，未重試。最新`staging/member-voice-live-evidence.json`為schemaVersion 2，`connectionTopology.serverConnectionsCreated=1`、`inputDiagnostics.captured=true`、`diagnosticsFlushed=true`；舊的缺失trace檔另保存在session files的`member-voice-live-before-single-path.json`。

| 階段 | 持久化結果 |
|---|---|
| locale契約 | 兩筆ACK均為zh-TW transcription／voice／voice_locale、預期instructions hash、multilingual semantic VAD、`create_response=false`、strict `travel_backend` tool choice |
| PCM送出 | client、tracked SDK及bridge均為59 frames／282,000 bytes；SDK sendAudio均完成，明確commit呼叫0 |
| 接收事件 | wire及bridge的speech_started、speech_stopped、committed、timeout_triggered、transcription completed／failed、error計數全部0，events為空；這次為已捕捉且flush完成的0，舊回合仍為未知 |
| response／業務 | 1個非應用程式要求的啟動greeting，終態cancelled；app response request、function call、tool output、後端／會員context委派及輸出音訊均0 |

拓撲由「runner建立一條未使用SDK連線，server另建一條」改為「只有server-owned一條」。修正後仍有同類逾時，尚無證據把多餘連線判定為舊根因。本次同一句TTS重新合成，原始PCM仍174,000 bytes、格式及送出長度相同，但SHA-256與舊回合不同，沒有宣稱是bit-identical重播。

離線檢查SDK 2.9.0確認`sendAudio`仍走base64 append serializer；speech/VAD/commit及轉錄事件在SDK的deserializer表都有對應，並非未支援事件被統一轉成unknown。現在的明確邊界是「本機bridge已交付59次SDK append；SDK迭代器沒有回傳任何允許的VAD／commit／轉錄事件」。append沒有服務ACK，缺少服務端接收、PCM解碼及VAD處理紀錄，尚不能定位其中哪一步未前進。現有證據沒有支持補送commit、再改immutable VAD設定或其他安全本機修正；保持`inferenceTested=false`，不自動重試或進入英文。下一步應以既有連線證據查明服務端音訊接收／解碼契約或支援端trace，先取得可驗證原因再決定新的測試或設定差異。未改`.env`、新建版本、啟動3100、啟用或commit/push。

### 最新音訊契約阻塞：2026-10-29 08:09 +08:00

續查官方managed Voice Agent文件及JavaScript／Python範例，確認入口為JSON `input_audio_buffer.append`＋base64 PCM16；官方JS sample同樣用24 kHz mono、100 ms／4,800 bytes分包及尾端靜音，不需另做媒體協商或手動commit。SDK的Node transport在`ws.send` callback成功後才完成send promise；這仍不是服務端音訊解碼ACK。managed定義的audio是session defaults，官方文件允許supported欄位的session update；哪些欄位可變仍須實際服務確認。

**找到確實的聲道衝突：**唯讀GET v6得到`audio.input.format={type:"audio/pcm",rate:24000}`，但`audio.input.echo_cancellation={type:"server_echo_cancellation",reference_source:"client",channels:2}`。GET latest確認目前v7也有相同echo設定。官方[Configure a voice agent](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/configure-voice-agent)及SDK `VoiceAgentEchoCancellation`契約指出client reference需要兩聲道交錯：mic及實際speaker reference；目前client送的是mono。只檢查24 kHz而未核對echo channels，讓錯格式曾通過ready。

本機修正以`session.update.audio.input`明確要求24 kHz PCM及`echo_cancellation={type:"server_echo_cancellation",reference_source:"server",channels:1}`；不改locale、instructions、VAD或tools。新增effective input/output格式及echo ACK gate，初始舊defaults不會誤開ready，最多20秒等待符合設定，未套用時明確`VOICE_AGENT_AUDIO_UNAPPLIED`且不開始收音。SDK wire離線斷言確認完整巢狀欄位被送出，沒有wrapper序列化遺失。

在離線驗證後依既有授權執行一次有理由的zh-TW確認，服務約366 ms即回：

```json
{
  "type": "invalid_request_error",
  "code": "change_in_ec_channels_not_allowed",
  "param": "session.input_audio_echo_cancellation"
}
```

本輪`captured=true`／`diagnosticsFlushed=true`，client／SDK／bridge輸入皆0、手動commit 0、backend／會員委派／輸出音訊0；沒有進入English或重試。這明確確認既有v6 session不接受echo聲道數2→1；先前無VAD逾時的單聲道／雙聲道衝突已確立，但改正後是否成功仍待驗證。新live檔保存這次拒絕；07:33的59次append檔另保存在session files的`member-voice-live-before-mono-contract.json`。

另找到SDK輸出型別相容性問題：SDK會把wire `response.output_audio.delta.delta` base64解碼成`Uint8Array`，bridge原本只接受string而略過。已在後端以實際byteOffset／byteLength處理typed PCM並轉回browser base64，保留PCM16偶數檢查、48 KB每包與總量限制；舊base64事件相容性保留。離線測試涵蓋安裝SDK的wire解碼與bridge輸出，沒有宣稱取得真實音訊。

**待用戶核准的最小差異：**各從精確v6／v7新增中／英版本（latest唯讀為7，預期8／9；寫入前必須重查），每份只替換`audio.input.echo_cancellation.reference_source:"client"→"server"`及`channels:2→1`，再以精確locale mapping指向新版本。所有其他欄位、舊6／7、品牌9／9／9／7及`store=false`保留；不啟用。此調查沒有建立新版本或實作未核准的creator。較大替代方案是端到端實作真正雙聲道mic＋同步speaker reference；不以複製mono或虛構reference代替。

唯讀GET快照：`staging/member-voice-ingress-contract.json`。完整去識別重現事件、確切錯誤、官方來源及待核准JSON patch：`staging/member-voice-ingress-resolution.json`。沒有對外送支援請求、原始音訊或憑證；目前已有明確API決策邊界，先取得版本／方案核准再繼續，不再付費探測。

### 核准mono版本與新voice錯誤：2026-10-29 08:14 +08:00

使用者明確核准新增兩個單聲道相容版本後，`scripts/create-member-voice-mono-versions.js`先GET latest=7，再比對精確v6／v7的既存definition hash；只替換echo reference為server及channels為1。zh v8及en v9各建立一次，GET diff只有上述兩欄；回讀確認舊6／7未變。`staging/member-voice-mono.json`保存來源與新hash，未覆蓋舊locale記錄。建立前若latest/hash不符即無寫入；第一個寫入前持久化attempt，部分失敗不得自動重跑。

runtime在endpoint／agent符合且原6／7 lineage通過後，才載入完整mono 8／9映射；匹配但不完整的檔案明確失敗。每個ticket凍結locale並再次核對精確version。最初session只要求PCM24k格式、不改echo channels；下方記錄的是當時失敗。最新runtime已移除完整audio override，只送`{type:'realtime'}`，effective ACK仍驗證mono/server-reference、PCM、locale、instructions及VAD／tool guards。當時95/95離線測試涵蓋版本建立guards、SDK wire／typed output、診斷落檔、會員與ticket隔離。

一次真實zh v8測試已獲完整相符的ACK，但約264ms收到`invalid_request_error`／code=`invalid_request_error`／param=`voice`，因此停止；未測英文或重試。captured／diagnosticsFlushed皆true。client送出1 frame／4,800 bytes，bridge接受及SDK append均0，兩層speech_started/stopped、committed、轉錄completed/failed皆0；app response request、travel_backend/tool output、backend／會員context及output audio均0。SDK追蹤另看到一個非app要求的啟動greeting response.created，沒有終態。

唯讀GET 8／9的output皆為`voice_type=azure-standard`、PCM24k，voice分別為`zh-TW-HsiaoChenNeural`／`en-US-AvaNeural`，locale正確。官方設定文件列出managed `gpt-realtime-2.1`與azure-standard配置，但沒有本次拒絕的精確原因。當時診斷刻意不保存service error message及client event ID，因此無法事後取得actionable message或確定是greeting還是format-only session.update引發；optional SDK voice型別也未要求format-only更新必須帶voice。現階段不推測改voice／greeting或再建版本。下一個可支持的調查需要保留隱私安全的錯誤分類及client-event關聯，或取得服務端trace；本輪沒有再開付費連線或對外送支援資料。新音訊推理與會員委派仍未驗證，`inferenceTested=false`。

上述mapping、GET hashes、live trace及release manifest都是本機私有產物，已由`.gitignore`排除；public source只包含必要scripts、tests及`staging/member-public`候選UI。四商務品牌候選仍9/9/9/7。未改.env／啟動3100／啟用／commit／push。

### 移除audio override後的進展與逐字稿阻塞：2026-10-29 09:00 +08:00

08:59的隱私安全instrumented回合仍在append前收到`param=voice`。保留文字為`Cannot [redacted] voice from [redacted] to [redacted]`；服務未給`error.event_id`，無法精確歸因configureSession或greeting。沒有保存原始message。審閱後只作本機修正：`session.update`的session僅`{type:'realtime'}`，不再發任何audio／voice／instructions mutation，使用GET驗證的persisted8／9。84/84離線通過後，執行一次zh v8確認，未另建版本。

此次mono／locale／instructions／VAD／tool ACK符合，service error為0。client、SDK及bridge均59 frames／282,000 bytes；speech_started、speech_stopped、server committed、final transcription completed各1，failed為0，explicit commit為0。取消自動greeting後，app要求的response完成，含唯一`travel_backend` function call。bridge以committed item對應的ASR final和工具message作trim／whitespace比較，回`VOICE_AGENT_TRANSCRIPT_MISMATCH`，因此實際backend／會員context／tool output／output audio皆0。captured／flushed皆true，未接續English或再試。原始成功ingress證據另保存於工作區外session files；沒有事後加入不存在的比較證據，實際文字差異仍缺資料。

後續僅離線調查確認SDK2.9 final event保留`item_id`、`content_index`及`transcript`，沒有欄位改名。工具由app-requested active response綁定到committed input，ASR可先到或後到，必須使用相同item；不拿最新任意ASR取代。新增`bridgeDiagnostics.delegations`，上限64筆：

```json
{
  "type": "transcript_comparison",
  "elapsedMs": 12,
  "association": {
    "appRequestedDelegation": true,
    "responseMatchesActive": true,
    "committedInputKnown": true,
    "transcriptForCommittedInputPresent": true
  },
  "comparison": {
    "transcriptLength": 20,
    "delegatedLength": 19,
    "exactEqual": false,
    "whitespaceEqual": false,
    "punctuationOnlyEqual": true,
    "numericOnlyEqual": false
  },
  "accepted": false
}
```

上面是schema示例，**不是這輪live差異**。標點旗標先摺疊whitespace，再移除Unicode punctuation；數字旗標將Unicode數字序列換成固定佔位符。兩者只做診斷，絕不作接受條件。長度使用JavaScript字串length。未保留原始文字、數字值、item ID或雜湊。

真實loopback／SDK注入的七條獨立連線，以同一smoke runner落檔再讀回斷言：exact與whitespace兩條可執行會員mock backend並收4,800 injected output bytes；標點差、數字替換、漏掉限制、語意改寫全部拒絕；不相關item最終稿保持等待且timeout、未派送。先到／後到final都覆蓋，SDK async close完成才輸出JSON，privacy sentinels不出現在metadata或日誌。這些是離線注入證據，未補足live會員委派／語音輸出。

同時修正smoke成功路徑的驗收bug：原先將工具message與帶「需求摘要：」UI前綴的文字相比，會誤判成功回合；現在讀bridge已通過的同item／同response比較結果。工具參數及後端request原文不再落檔。這個runner bug位於backend／audio完成後的驗收，沒有造成09:00的bridge拒派。bridge原有精確／whitespace gate未放寬，尚無可支持的新live mismatch根因修正。新capture與提案待審閱，未再開付費連線、提交外部支援資料或啟用候選。

### 比較metadata審閱後的單次確認：2026-10-29 09:06 +08:00

審閱七案例的實際持久JSON後，只執行一次zh v8。服務error為0，仍為59次SDK／bridge append、282,000 bytes，speech_started／stopped／committed／final completed各1；沒有manual commit。app要求的唯一tool call通過response／item association，但comparison為：

```json
{
  "transcriptLength": 14,
  "delegatedLength": 13,
  "exactEqual": false,
  "whitespaceEqual": false,
  "punctuationOnlyEqual": true,
  "numericOnlyEqual": false
}
```

四個association布林皆true、accepted=false。此輪標點差異類別已有真實證據；未保存原始字元或位置，因此不能斷言是句末句號，亦不能補推09:00的原因。gate繼續回`VOICE_AGENT_TRANSCRIPT_MISMATCH`，backend／會員context／tool output／output audio全部0；捕捉與flush成功，未接英文、未重試、未改版本或啟用。

下一步需要審閱「只允許句末句號／問號／驚嘆號的差異」是否符合產品安全契約；若採用，backend仍須用同item的ASR final，數字、內部標點、漏詞及改寫繼續拒絕。目前沒有實作此放寬；診斷的`punctuationOnlyEqual`會忽略所有Unicode標點，不能作為安全接受條件。英文v9和live會員委派／輸出仍待驗證。

### 核准窄化句末處理與新非標點差異：2026-10-29 09:26 +08:00

使用者明確選擇「允許這項狹窄句末標點處理，繼續驗證（建議）」後，本機comparator只移除一個末尾enum字元：`。 . ？ ? ！ !`。移除前的body不能為空、不能以空白或另一個enum標點結束。ASCII dot另拒絕數字結尾（小數／數字的歧義）、含點token、initial／短ASCII token、全大寫縮寫及已知縮寫。保守拒絕仍可用完全相同的原文通過。數字、負號、內部標點、漏詞及改寫不被忽略；`punctuationOnlyEqual`永遠只做診斷。accepted只可由原有whitespace相等或新`terminalOnlyEqual`成立。

同item原始ASR final繼續作後端message，沒有trim、刪標點或用model參數取代；UI原文保持原樣。86/86離線通過，八條real loopback／injected SDK結果落檔再讀回。新增句末差異成功案例，backend observer在記憶體逐byte比對原始ASR UTF-8，包含whitespace及原始句末標點；metadata不保留原文。內部逗號、數字改變、漏詞、改寫、錯item仍阻擋，decimal／abbreviation／negative等回歸亦通過。

之後只執行一次zh v8真實確認，結果是另一種差異：

```json
{
  "transcriptLength": 14,
  "delegatedLength": 12,
  "exactEqual": false,
  "whitespaceEqual": false,
  "terminalOnlyEqual": false,
  "punctuationOnlyEqual": false,
  "numericOnlyEqual": false
}
```

association四個布林皆true，accepted=false；服務error0，59次append／282,000 bytes，speech start／stop／server commit／final各1。app產生唯一`travel_backend` call，但bridge仍以`VOICE_AGENT_TRANSCRIPT_MISMATCH`拒派，實際backend／member context／tool output／output audio全部0。未保存原文字詞，具體變更位置與漏詞／改寫類型仍未知；不能沿用09:06標點結論。按授權立即停止，未English、未再試、未放寬其他差異、未新增雲端版本。live會員委派及語音輸出仍未驗證。

## 四種已啟用語音架構

選項1的收音流量協定：後端ready公告`inputFlow.maxUnackedBytes=12288`，每個收到的PCM包回傳累計`inputAudioAck.receivedBytes`。前端除48KB/s wall-clock credit與本機bufferedAmount外，另限制未獲後端確認的PCM最多12288 bytes；延遲時略過收音並提示，不排隊補送。這能限制已離開瀏覽器queue、但尚未由後端處理的在途音訊。原入站速率／總量／上游背壓限額不變，其他語音模式沿用原協定。重新載入頁面及新後端連線後才協商此功能。

2026-10-21重新定義比較範圍；此節取代舊版「Personal／GPT-Live／Realtime／標準聲音」分類。**順序固定為1 Voice Live、2 Voice Live Realtime 2.1、3 GPT-Live、4直接Speech REST／SDK。** 四條都用既有外部GPT-5.4 `intent`／`planner`／`flight`／`price`代理、同一旅程與合成工具，不新增第五個業務代理。

| 模式 | 輸入 → 業務後端 → 輸出 | 交易界線 |
|---|---|---|
| 1 `voice-live` | Voice Live `azure-speech` zh-TW STT → 外部同四代理 → `pre_generated` exact-text Personal Voice | 保留原交易guard；本次比較只讀 |
| 2 `voice-realtime` | Voice Live `gpt-realtime-2.1`音訊原生前端 → 受控`travel_backend` function → 同四代理 → `function_call_output` → Voice Live音訊 | server拒絕選班、重新報價、同意／購買 |
| 3 `gpt-live` | 獨立`gpt-live-1` API → client delegation → 同四代理 → built-in語音 | 同上；模型字幕／語句不具交易權威 |
| 4 `speech-direct` | A Speech REST短音訊16kHz WAV／B Speech SDK連續串流zh-TW STT → 同四代理 → Speech REST SSML Personal Voice | 同上；不呼叫Voice Live；B支援mic或8／16kHz PCM16 WAV，逐final委派 |

原始碼／離線測試、配置可用、雲端驗收須分開報告。目前3100已啟用v1.0.6，四模式及選項4 REST／SDK配置可用；這不是同條件真人聲學驗收。實際啟動build與歷史證據見[版本交接](CURRENT-VERSION.md)，同條件客戶驗收見[四架構比較](VOICE-COMPARISON.md)及[講稿](DEMO-SCRIPT.md)。

### 1｜Voice Live STT → 外部代理 → exact-text

2026-10-23輸入診斷：24 kHz單聲道PCM16每秒48,000 bytes；每包最多48,000 bytes，每個本機1秒視窗最多144,000 bytes，上游WebSocket待送最多1,000,000 bytes。單次連線總輸入576,000,000 bytes（含靜音，200分鐘），輸出288,000,000 bytes（100分鐘），均不因此次修改提高。`VOICE_AUDIO_LIMIT`安全日誌現在包含`limitReason`（`session_input`／`input_rate`／`upstream_backpressure`）、mode與實際數值，不記音訊、文字或憑證。舊日誌只有共用code，不能回推原事件命中的分支。

已重現主執行緒延遲後，AudioWorklet訊息集中回補可令短句觸發速率限制。選項1／2／3的worklet標記音訊擷取時間，前端不再補送超過1秒的舊音訊；偵測延遲即捨棄尚未送出的該批舊片段、提示使用者重說，再繼續即時收音。伺服器原有限制保留；未靜音時的即時無聲PCM仍計入總量，保留雲端VAD及插話能力。REST／SDK封包格式不變。選項3實際合成音訊測試確認一次`input_rate`為3ms內147,456 bytes、連線總輸入356,352 bytes、上游待送193,200 bytes；擷取時間保護修正後，同一句完成client delegation、Foundry結果及瀏覽器播放排程。沒有使用真人麥克風或宣稱人工聽評。

`azure-speech`以`zh-TW`完成轉錄後才交Node既有後端，答案經同一發音正規化一次，再以`pre_generated`確切文字合成。`autoanswers=false`停用自動回答；即使Voice Live session有`gpt-5.4`模型欄，**不能畫成另一次Voice Live GPT-5.4推理**。業務推理由外部同四代理完成。

目前聲音為`azure-personal`／`DragonLatestNeural`。Voice Live的`name`是同資源Personal Voices API的voice資源id，不是顯示名稱或Speech SSML speakerProfileId。原始轉錄與canonical回答有別；發音展開不修改班號、日期、金額或畫面事實。歷史合成證據見[Personal Voice](#personal-voice)，不代表本次四模式已聲學驗收。

Professional Voice設定接點已實作，須明確選`VOICE_LIVE_VOICE_TYPE=azure-custom`，搭配`VOICE_LIVE_CUSTOM_VOICE_NAME`及`VOICE_LIVE_CUSTOM_VOICE_ENDPOINT_ID`，輸出`{"type":"azure-custom","name":"<authorized voice>","endpoint_id":"<authorized endpoint>"}`。只有訓練完成、已授權且同資源的資產才可另行配置；目前**未配置資產，不宣稱已有聲音或可試聽**。

### 2｜Voice Live gpt-realtime-2.1 → function → 外部代理

2026-10-23：`travel_backend.message`明確限制為本次使用者的需求內容，不附加角色、四代理步驟、前端輸出或安全指令；session及欄位描述含「你好你聽得到我說話嗎？」的原意保留範例。畫面標為「需求摘要」，不是STT逐字稿；舊版歷史前綴只在顯示時換成同一標籤，不刪改需求內容。一般問候／收音確認由既有intent入口直接短答，不搜尋、不呼叫Foundry、不修改旅程或交易。模型仍可能聽錯音訊，此次只有離線契約驗證，不宣稱已驗證真人辨識正確率。

前端播放改為有界佇列：最多保留60秒的24 kHz PCM16（與每回合語音輸出預算對齊），每次只向AudioContext排程未來30秒；每個播放片段最多1秒。已播放即釋放計數，停止或插話時清空排程與待播音訊，半雙工仍等待完整播放完才恢復收音。這修正一次收到30秒以上有效音訊就斷線的問題；不是移除背壓限制。UI移除管線與驗收說明，保留單一啟用前雲端／費用提醒、模擬航班／交易揭露、可操作錯誤及進階設定。

這是Voice Live原生模型，不是GPT-Live、不是直接Azure OpenAI Realtime API，也不是以Speech轉錄驅動的原管線。**不配置STT transcription**；音訊已進入native context，收到`input_audio_buffer.committed`才送要求function的`response.create`，以`tool_choice: { type: "function", name: "travel_backend" }`指定工具，session設`parallel_tool_calls=false`。可選轉錄事件不是必要觸發條件，不能等一個沒有配置的`transcription.completed`。

**待啟用的Option2插話守門：** 本機來源中，`speech_started`停止舊播放，不abort或重跑既有後端工作；工具／thinking期間最多保留一個committed音訊項目。下一個`travel_backend`須等pending工具及後端鎖釋放，或舊音訊response終止；遲到的`response.created`也須取消並等待終止，不平行派送。audio／call ID去重、strict工具及唯讀交易檢查保留；超量回`VOICE_PENDING_LIMIT`，取消等待20秒逾時回`VOICE_REALTIME_TIMEOUT`。安全錯誤僅補timestamp／mode、不記內容。45/45項voice Node測試通過，但3100仍為v1.0.6／`b451311c607461c4`，未重啟、未做live修復驗收。

只接受completed response內唯一`travel_backend`呼叫；call的status可為`completed`或省略，明確`in_progress`／`incomplete`仍拒絕。允許同一output附帶message／reasoning（status為completed或省略）；這些項目不作後端答案、不顯示或朗讀。核對response／call ID、工具名與strict message schema後才委派既有四代理；重複完成事件不重做委派。不單憑`response.function_call_arguments.done`或`response.output_item.done`開工具。結果用`conversation.item.create`的`function_call_output`回送，再要求Voice Live回音訊；不並發兩個response，無有效委派就逾時／失敗、不fallback。模型只能提出受控旅行需求，不能指定endpoint、工具權限、offer／quote或自授同意。

`VOICE_REALTIME_TOOL`表示本機委派契約拒絕，不代表Foundry已執行後失敗。日誌保留`voiceResponseDetails`的allowlist狀態、output數量、function數量及最多8個item的類型／狀態／工具名是否符合；另以`delegationFailure`區分response未完成、call數量、item狀態、未知output、工具名、call ID、重複call、response關聯、參數型別／長度、JSON及schema錯誤。工具名只記是否`travel_backend`，不輸出任意名稱、參數、逐字稿、模型文字或服務ID。此次以離線事件重現舊gate的過嚴限制；沒有原失敗事件日誌，不能斷言當次是缺item status或額外output，仍須另行核准live驗收。

畫面顯示的委派需求是**模型整理（MODEL-DERIVED），不是使用者原始逐字稿**；原話slot錯誤需由測試講稿人工比對。後端canonical結果為權威，模型朗讀可能改述，不承諾exact-text、50詞或發音展開照念。此處明確選`azure-standard`／`zh-TW-HsiaoChenNeural`：它是Azure TTS輸出，**不能標為模型built-in聲音**。官方模型表列2.1支援Azure TTS／custom，不表示本次改用了Personal／Professional Voice。

opt-in為`VOICE_LIVE_REALTIME_ENABLED`，endpoint沿用`VOICE_LIVE_ENDPOINT`。**只接受`gpt-realtime-2.1`**；目前3100已使用核准的2.1配置。availability顯示實際`configuredModel`與`requiredModel=gpt-realtime-2.1`，若配置舊`gpt-realtime`或其他值即拒絕開始，不自改model或降級。官方支援、配置可用及實際語音驗收是不同證據。

### 3｜GPT-Live-1獨立API與client delegation

有效期限的語音文字使用台北時間、精確到分鐘，省略秒與毫秒；畫面及quote保留完整ISO期限。共用speech formatter涵蓋Personal Voice、直接Speech與GPT commentary；Realtime函式回傳的朗讀文字也先套用同一有效期限格式。

獨立`/openai/v1/live/sessions`／`session.start`，需要既有`gpt-live-1`部署與獨立resource root；不是套用Voice Live的session／VAD schema。`GPT_LIVE_ENABLED=false`預設停用，`GPT_LIVE_ENDPOINT`不可猜測為Voice Live或project URL。後端Entra bearer使用`https://ai.azure.com/.default`，瀏覽器不能選endpoint／token／工具。省略`audio.output.voice`使用文件預設built-in `marin`；**目前文件session契約不能替換為Azure Personal Voice**。

`session.delegation.created`只有metadata，不帶task text。現有接線必須由有序、**帶時間戳的使用者轉錄**定位`end_ms <= offset_ms`片段，才交同四代理；不是把原始音訊交給四代理。零碎`input_transcript.delta`本身不跑工具；缺時間、跨界或過時委派拒絕，不用停頓或播放sample數猜位置。重複id不重跑，更正／停止只取消只讀工作，等settle才解鎖。

重連時，`session.start.instructions`附上最小的已保存旅程與待答問題JSON（城市、日期／人數／艙等、機場選項與版本），不含完整歷史、票價結果、quote或同意。短句「成田機場」、「都可以」、日期與整理要求也須委派，避免新語音連線把後續回答當成獨立機場介紹。這仍依賴服務實際送出client delegation；不偽造回合邊界或用字幕直接觸發工具。未辨識機場的短答保留原城市及機場候選，請使用者澄清，不做同音字自動改機場。真實服務測試曾將「步行」辨成「不行」；改述「少走路」可用作明確澄清，不能把這類辨識差異描述成已驗收的穩定語音理解。

多輪實測另發現：第六句完整字幕為兩天東京車站09–17開會，但所選委派文字只到「附近開」，因此後端沒有保存會議。調整完整句instructions後仍重現；現有瀏覽器證據未保留原始offset數值，尚不能宣稱已解決。官方文件沒有把delegation offset定義為使用者語意回合終點；目前依offset選取轉錄前綴與本地完整句解析之間仍有整合缺口，不能只歸咎雲端故障。字幕完整與後端收到完整需求需分開檢查；不能用尾字猜測、無時間窗拼接或宣稱提示詞已保證完整委派。

canonical結果顯示於聊天；`session.commentary.append`供模型參考，不是exact-text TTS。語音／字幕可改述且非權威，不回寫旅程、價格或quote。臺灣華語、臺灣常用詞及繁體中文instructions只是**偏好，不保證臺灣口音或字幕字形**，不可新增未受文件支持的accent／locale欄位。

官方描述timed output audio；既有使用者事件曾出現兩個output時間欄皆缺少。現有相容路徑只在`start_ms`／`end_ms`都不存在時明示`pcm-contiguous`，按PCM samples連續播放，不能還原被省略的靜音。只缺一欄、null、無效值或同連線格式切換仍拒絕。**這不是放寬input transcript／delegation時間契約**，也不是證明音訊／委派全流程成功。

### 4｜直接Speech REST／SDK切換：不經Voice Live

瀏覽器按鍵開始後，本機伺服器聲學VAD自動分段：20ms PCM frame、先校準300ms環境底噪，adaptive RMS起始門檻`max(0.012, noise×3)`／持續門檻`max(0.007, noise×2)`、120ms起音、至少200ms有聲、500ms pre-roll、連續靜音1000ms送出。片段達28秒也自動送出；server硬限30秒。開始後先短暫安靜，待校準再說話；低音量可能漏偵測，突變大聲噪音仍可能誤觸，不宣稱語音分類器。安靜／短聲響只在本機有界記憶體等待，不呼叫Azure；長時間連線仍受原音訊總量上限約束。靜音丟棄未送片段，解除後重新校準。16kHz mono PCM WAV送短音訊STT、固定`zh-TW`，完整結果才交同四代理。答案以SSML `<mstts:ttsembedding speakerProfileId="…">`與base model合成。**沒有Voice Live websocket／session呼叫**，也不是Speech SDK streaming。

REST對照組是**半雙工**：聲學VAD結束輸入後辨識／思考／播放，等排程PCM播完才恢復收音，不以最後一包抵達當作播完。不是semantic VAD、部分轉錄或全雙工barge-in，VAD本身不提供降噪／回音消除。REST官方上限60秒不等於本app硬限30秒；REST沒有phrase list、auto LID或server AEC。`Speech_SegmentationSilenceTimeoutMs=700`不能加到REST請求，也不是語意VAD。停止可清理工作／播放，不回滾完成的工具。

2026-10-22新增B SDK分支，A REST不變。`lib\speech-sdk.js`用continuous `SpeechRecognizer`與`PushAudioInputStream`，`fromEndpoint(wss://<custom-domain>/stt/speech/recognition/conversation/cognitiveservices/v1)`；固定zh-TW，silence property可選700／1000ms，可選phrase list，後端同資源key或Entra授權（Speech scope、`aad#RESOURCE_ID#TOKEN`，更新到recognizer），不向瀏覽器發權杖。Azure custom endpoint會回HTTP redirect；Node 22全域WebSocket不會走此redirect，因此後端明確使用Speech SDK內建、支援redirect的npm WebSocket transport。無Entra key時`SpeechConfig.fromEndpoint`省略auth參數，取得token後才設定授權，不能傳空字串。SDK telemetry關閉。8／16kHz WAV與16kHz麥克風PCM以預設1280 bytes實時節奏推送，WAV最多120秒，server總音訊／背壓及回合預算不變。

回呼只發ASR事件／排隊，代理及Personal Voice TTS在獨立非同步worker逐段執行；max8排隊、max100 final，超額明確錯誤，不丟失後冒充完成。全部final及數值timing顯示於本次UI，中間結果可更正；一個final只保證ASR片段，不是完整語意回合。`session_stopped`不觸發代理，只代表SDK session結束；檔案EOF才關Push，最多15秒等待尾端事件。半雙工暫停WAV位置／mic送出，播放完成後處理下一final或恢復輸入。不自動fallback A，也未建立MRCP／RTP協定服務。SDK啟動錯誤會在語音狀態與診斷區顯示安全分類（驗證、連線、逾時或一般啟動），不會顯示SDK原始錯誤／權杖／端點細節。參見README「選項4」；來源為本機GatewayASR範例模式及[JS SpeechConfig](https://learn.microsoft.com/javascript/api/microsoft-cognitiveservices-speech-sdk/speechconfig)、[音訊輸入串流](https://learn.microsoft.com/azure/ai-services/speech-service/how-to-use-audio-input-streams)、[Entra授權](https://learn.microsoft.com/azure/ai-services/speech-service/how-to-configure-azure-ad-auth)。SDK後續已有單句真實服務及多輪測試，但漏第二句仍未解決；結果與限制見[版本交接](CURRENT-VERSION.md)，不能視為完整聲學驗收。

v1.0.7候選已定位SDK漏句：實際Azure在同continuous connection重用resultId；原ID-only去重丟掉不同offset的final。改為ID＋offset＋duration，原兩句WAV、原EOF與endpoint取得2final，真實WebSocket→SDK→Foundry→Personal Voice TTS皆2次，896,832 bytes、errors=[]；計時ACK模擬播放，不是喇叭試聽。未新增尾端假靜音或partial提升。11:33舊截圖缺resultId，無法追認唯一根因。新安全pipeline traces只含stage／計數／時間，不記語句。3100尚未啟用。

候選進階設定以strict `voiceOptions`綁定單次票券；Option1／2的VAD、noise、AEC使用既有API2026-07-15官方session欄位，Option1另用`input_audio_transcription.phrase_list`。實際session.updated已ack測試選擇；GPT session.started已ack `audio.output.voice=marin`。這些ack沒有輸入音訊、不代表聲學效果。GPT有限語言／風格preset不替換工具／交易守門；沒有已核實的其他voice清單，不開任意prompt。REST本機VAD與SDK切段／phrase／chunk ms分開，沒有跨模式假控制。完整值與未部署前端位置見版本交接。

下列只是後端設定契約，**不是要求本次填入、取得token或執行付費測試**：

| 設定 | 要求 |
|---|---|
| `DIRECT_SPEECH_ENABLED` | 預設`false`，獨立opt-in，不受`VOICE_LIVE_ENABLED`代開 |
| `DIRECT_SPEECH_ENDPOINT` | 精確`https://<resource>.cognitiveservices.azure.com`資源root；不是Voice Live／project／完整STT或TTS URL |
| `DIRECT_SPEECH_RESOURCE_ID` 或 `DIRECT_SPEECH_KEY` | 前者用Entra，後者resource key；秘密只在後端，不混用／猜測 |
| `DIRECT_SPEECH_PERSONAL_SPEAKER_PROFILE_ID` | 已核准同資源speakerProfileId **GUID**；不是Voice Live的`name`，不可自行重用／推算 |
| `DIRECT_SPEECH_PERSONAL_VOICE_MODEL` | `DragonLatestNeural`／`DragonHDOmniLatestNeural`／`PhoenixLatestNeural`其一；是base model，不是resource id |

TTS path為root下`/tts/cognitiveservices/v1`；Entra Speech bearer依文件為`aad#RESOURCE_ID#TOKEN`，或使用resource key。設定／權限／profile映射未核准即不可用；不為了湊齊比較自行查雲端、登入、建立profile或更換資產。

### 共通界線、延遲與來源

四者都要求瀏覽器`noiseSuppression`／`echoCancellation`，屬裝置best-effort；不能外推成server AEC、同等房間效果或聲學驗收。模式1的`azure-speech`官方有`phrase_list`能力，是否本app有接入／實際配置須分開說；其餘模式不假設通用phrase list。固定zh-TW不等於auto LID，native多語能力不等於本app已驗證code-switch。

模式2／3／4唯讀guard在任何選班、reprice、同意、購買前阻擋；請停止語音改用文字。本次四模式同講稿也不在模式1進行交易。模型不可授權工具、改寫合成供應或繞過quote／consent檢核。模式票券／同源cookie／nonce及busy檢核不交給瀏覽器控制；共用記憶體旅程，沒有持久化帳單上限、錄音保存或自動fallback。

量測用共同server單調時鐘分階段記錄，browser顯示的是該server計算的numeric stage durations；另以browser本機時鐘量first packet→playback scheduling delay，**不是實際聲學出聲時間**。GPT metrics區分backend結果前的`frontend_audio`與結果後的`first_audio`，後者也不代表語意答案完成。只留最後一回合numeric IDs／數值metrics於記憶體，沒有持久化報表／下載，不保存音訊／逐字稿為量測資料。**不同host時鐘不相減**；沒有同條件live樣本就不列p50／p95、品質或費用排行。方法與未測結果欄位見[比較指南](VOICE-COMPARISON.md#延遲與結果紀錄)。

官方依據（本次沿用已閱讀文件，沒有新雲端呼叫）：

- [Voice Live模型與Azure TTS／custom支援](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live)
- [Voice Live how-to：VAD create_response=false與可選transcription](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to)
- [Voice Live customize：azure-custom endpoint_id與azure-speech phrase_list](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to-customize)
- [Voice Live事件契約](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-api-reference-2026-07-15)
- [GPT-Live連線與音訊](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/gpt-live)、[事件契約](https://learn.microsoft.com/en-us/azure/foundry/openai/gpt-live-reference)、[client delegation](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/gpt-live-delegation)
- [Personal Voice SSML／speakerProfileId／base model](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/personal-voice-how-to-use)
- [Speech REST短音訊STT：格式、上限與無partial](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text-short)
- [Speech REST TTS：endpoint與認證](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech)

下列Hosted Agent與過往live紀錄為**歷史範圍證據**，不是本次四架構的雲端驗收或後續付費／授權／部署許可。

## Hosted Agent 本機介面原型（尚未部署）

2026-10-19，使用者核准的範圍為**隔離、本機、離線相容性驗證**，不是部署或完整移植。原型位於 `prototypes\hosted-adapter\`，未修改現有 Node 商業邏輯，未重啟 3100。Python 官方 `azure-ai-agentserver-invocations==1.2.0`／core `2.2.0` 提供 `/invocations`、`/invocations_ws`、`/readiness`；內部 loopback HTTP/WS 轉接到另一個使用原有 `createApp` 的 Node 行程。

這證明本機「官方 Python host + 保留 Node 核心」可以互通，**不代表雙行程映像已獲 Azure 接受或部署成功**。[官方文件](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/deploy-hosted-agent)沒有 Node Hosted runtime；不能把此原型描述成官方支援的 Node runtime。Linux/amd64 映像、雙行程生命週期、平台 session/identity、雲端網路與真正 Personal Voice 仍待核准後驗證。文件所列 protocol `2.0.0` 與 Python 套件版本 `1.2.0` 不是同一版本欄位。

原型故意只啟動 mock 商業模式及固定問候的 Voice Live 測試替身，不讀 `.env`、不取得 token、不執行真實 ASR／TTS／推論。Python host 停用 observability 自動設定，沒有遙測匯出。它不是 demo-key 登入網站，不可公開暴露，也未新增登入或雲端資源。

```powershell
python -m venv .foundry\hosted-adapter-venv
.\.foundry\hosted-adapter-venv\Scripts\python.exe -m pip install -r prototypes\hosted-adapter\requirements.txt
.\.foundry\hosted-adapter-venv\Scripts\python.exe prototypes\hosted-adapter\test_adapter.py
.\.foundry\hosted-adapter-venv\Scripts\python.exe prototypes\hosted-adapter\network_smoke.py
```

`requirements.txt` 明確使用 Microsoft-protected PyPI feed，不變更全域工具／設定。初次安裝曾停滯；有時限的核准 feed 安裝其後成功。直接 public wheel 嘗試失敗，未停用 TLS／憑證檢查，也不再重試不核准來源。

介面契約：

- `POST /invocations?agent_session_id=<server-owned-id>` 接受嚴格 envelope：`{"method":"POST","path":"/api/chat","body":{"message":"您好","requestId":"<UUID>"}}`。GET bootstrap／progress、既有 select／reprice／consent／purchase／voice-ticket 及精確 checkout path 為明確白名單；不接受任意 URL、header、cookie 或 reset。
- 同一 Foundry session 對應一個只留 Python 記憶體的 Node journey cookie；不同 session 不共用旅程。失去 Node journey 時明確失敗，不把新旅程偽裝成原旅程恢復。此原型最多八個 session，沒有持久化／重啟恢復。
- 語音先經 HTTP 取得既有一次性 nonce，再連 `/invocations_ws?agent_session_id=<same-id>&nonce=<nonce>`；nonce 不放入日誌。既有 Node guard 仍驗證 cookie／nonce／busy／同意狀態。真正網站應由 backend 持有 session 對應與 upstream 身分；不准讓瀏覽器任意選別人的 session。
- duplex 原樣轉送 PCM binary 與既有 JSON control／progress／result，沒有額外生成或重寫報價。輸入仍為 48,000-byte 上限，輸出最多 1 MiB；取消／斷線會關閉 Node voice，既有 transaction lock 不被當作回滾或自動重送。
- 沒有新增一般 `/cancel` 假回滾介面。HTTP 斷線不代表已取消寫入；錯誤仍保留真實 HTTP status，重送沿用既有 requestId/idempotency。

已通過八項官方 SDK ASGI 測試（session 隔離／連續性／冪等、嚴格參數、nonce、PCM／控制、停止／斷線、失去旅程 fail-closed、搜尋到模擬結帳與同意門檻），以及真正 Hypercorn loopback HTTP/WS 測試，`/readiness=200`。另外保留核心四項中止／插話／交易 lock 測試通過。這些都是本機／離線證據；沒有真實聲音相似度、Azure authentication／session routing、Linux 映像或公開 HTTPS/WSS 驗收。

下一個核准關卡仍為具體架構／費用與實作範圍：獨立的 key-login HTTPS 網站閘道、官方 Python Hosted Agent 介面加 Node 核心（有待雲端接受驗證）、受限 session 數及總用量、managed identity 最小權限、記憶體旅程遺失政策。Dockerfile／IaC／雲端 build／push／角色／部署均未建立或執行。

## Personal Voice

v1.0.6選項1可選「個人化男聲／個人化女聲」。既有`VOICE_LIVE_PERSONAL_VOICE_NAME`是預設男聲資產id；選填`VOICE_LIVE_PERSONAL_VOICE_ATHENA_NAME`為同資源、已唯一核驗且`Succeeded`的女聲資產id。只有`azure-personal`且配置第二資產時才提供選單；兩者沿用既有base model及端點，UI只收到`alexpun`／`athena`固定key及男聲／女聲標籤，顯示上述個人化標籤，不收到資產識別值。`POST /api/voice/session`僅在選項1接受`personalVoiceKey`，缺省用`alexpun`；其他模式或未知key回`VOICE_SELECTION`。票券把選擇固定於該連線，並行使用者不互相更改設定。連線時選單disabled，停止後才切換；選項2／3／4不顯示此選單，選項4 REST／SDK仍使用既有男聲speakerProfileId。

2026-10-24 v1.0.5依使用者核准更新既有Personal Voice。先在Voice Live與Direct Speech現有資源核對同一資產的唯一metadata及`Succeeded`狀態，再分別設定Voice Live資產id與Speech SSML speakerProfileId；不把顯示名稱、profile或Professional Voice endpoint id混用。base model不變。Voice Live短句收到107,936 bytes PCM，選項4 REST／SDK共用TTS短句HTTP200、87,360 bytes PCM；私人identifier只存本機忽略設定。未變更辨識或選項2／3。

2026-10-19使用者自行完成聲音訓練後，本app核對同一Foundry資源的既有voice為`Succeeded`，以`azure-personal`及`DragonLatestNeural`完成少量付費握手／固定中文合成，收到100,768 bytes、24kHz PCM音訊，沒有fallback。未評估人聲相似度；沒有錄音、上傳、建立／複製voice或申請權限。不要把聲音樣本、同意錄音、資源key或token傳給本app或貼進聊天。

[Voice Live官方自訂輸出文件](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to-customize#personal-voice)及[RealtimeAzurePersonalVoice schema](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-api-reference-2026-01-01-preview#realtimeazurepersonalvoice)確認原生設定為：

```json
{"type":"azure-personal","name":"<Voice Live personal voice name>","model":"DragonLatestNeural"}
```

這與[一般Speech SSML](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/personal-voice-how-to-use)的`mstts:ttsembedding speakerProfileId`介面不同。實測入口網站顯示名稱雖可通過`session.updated`，合成仍失敗：`speech_synthesis_error`，服務表示無法存取該personalVoiceName或不可用。透過[Personal Voices List](https://learn.microsoft.com/en-us/rest/api/aiservices/speechapi/personal-voices/list)在**相同資源**唯讀取得對應voice的`id`，它與顯示名稱及speakerProfileId都不同；把該資源`id`放入Voice Live的`name`後，握手及音訊合成才成功。因此不可只憑session.updated或標籤宣稱成功，也不需改送SSML。

必要條件：已獲Personal Voice limited access、本人同意／使用授權、聲音完成且可用，並位於呼叫Voice Live的**同一Foundry資源**。目前East US 2既有資源已經實際核對該voice並完成合成；這不是所有區域／帳戶均可用的保證。沒有移動／佈建資源或修改授權。錄製成功不代表任意Voice Live資源可存取。

準備好後只需在本機後端`.env`設定：

```dotenv
VOICE_LIVE_VOICE_TYPE=azure-personal
VOICE_LIVE_PERSONAL_VOICE_NAME=<同資源Personal Voices API回傳的voice資源id>
VOICE_LIVE_PERSONAL_VOICE_MODEL=DragonLatestNeural
```

官方自訂輸出指南此接點列出的base models為`DragonLatestNeural`及`DragonHDOmniLatestNeural`；本app只接受這兩個，不因其他Speech／SDK介面列出更多值就擴張已驗收範圍。缺值／不支援值會明確拒絕啟動，不靜默換回預建聲音。僅填名稱不會啟用：必須明確切換type。identifier只留後端`.env`，browser ready event只顯示`personal-voice`，health只回傳type／available，不記錄voice name。這是設定接點，不是聲音註冊／錄製介面，故不增加前端上傳或profile選擇表單。

`node --env-file=.env scripts\configure-personal-voice.js --apply`只唯讀查詢同資源voice metadata，要求完整結果中唯一匹配且`Succeeded`，將真正資源id寫入本機`.env`；不改雲端，也不輸出identifier。輸入可為已知資源id或唯一顯示名稱；不要拿speakerProfileId猜測。`node --env-file=.env scripts\smoke-voice-output.js --apply`是需明確核准費用的單次固定中文合成，核對服務確認的type／name／model與真實音訊，不保存音檔。錯誤會明確失敗，不自動重試或fallback。

之後更改後端設定仍需受控重啟（memory-only旅程會消失）；先告知使用者。已配置的選項1男／女聲則在停止後選擇，不需重啟。明確設定`VOICE_LIVE_VOICE_TYPE=azure-standard`才改回預建`zh-TW-HsiaoChenNeural`，不是遇錯自動換聲。四代理、插話中止及交易確認管線保持；畫面完整、語音獨立摘要／詳細並有界自動接續，沒有50詞分頁。

以下為**2026-10-16～19歷史驗收紀錄**，不涵蓋本次四架構。當時使用者已明確核准GPT-5.4推論／檢索及模擬結帳；自然探索→五天行程→合成來回票→重新報價→明確接受→模擬結帳通過，包括實際file_search，紀錄見`.foundry\live-smoke.json`。本機`.env`為foundry，通用範本仍預設離線mock；本次沒有重新核驗這些私人證據。

公開快照不包含上述私人`.foundry`證據檔、實際資源／vector store／voice識別或憑證。管理腳本已移除硬編碼的開發環境endpoint，改要求`FOUNDRY_APPROVED_PROJECT_ENDPOINT`與`FOUNDRY_PROJECT_ENDPOINT`完全一致；預設留白會在任何操作前拒絕。這只保留明確目標核對，不是雲端變更或費用許可，不影響一般chat／Voice runtime。不要為重現本機mock而填入或執行管理腳本。

## 歷史部署說明與此範本的預設名稱

私人環境曾建立並管理驗證四個 prompt agents；本文件不公開其原始資源名稱，也不表示本次改名已套用到雲端。下列名稱是目前程式供新部署使用的預設值：

| 角色 | 程式預設名稱 | 範本工具 |
|---|---|---|
| intent | `meihao-intent-agent` | list_airports、resolve_city_airports、file_search；JSON 原文片段理解 |
| planner | `meihao-travel-planner-agent` | list_airports、resolve_city_airports、file_search |
| flight | `meihao-flight-checker-agent` | list_airports、resolve_city_airports、search_flights、get_offer、file_search |
| price | `meihao-price-purchase-agent` | get_offer、reprice_offer、file_search |

私人 `.env` 與 `.foundry\deployment.json` 不納入公開版。下列名稱變更只更新範本程式碼；本次沒有建立／重新命名雲端資源。部署版本與工具須在目標環境另外核驗。工具為應用執行的 function calls，不是公開 MCP 或自動 Foundry A2A。

先前4/4/5/4由 `scripts\short-replies.js` 核對定義後追加精簡規則；本次5/5/6/5以明確`--replace-snapshot`替換synthetic-demo-only知識庫，保留模型、functions、reasoning、JSON格式與既有精簡指令，追加synthetic-demo-only及機場集合界線。新版本／附件已管理GET驗證，`.env`保留live不翻回mock。後端 `lib\replies.js` 才是<=50詞硬限制；超長內容完整分頁、說「繼續」讀取，不花模型費。中文按Intl.Segmenter zh-Hant詞分段；日期／金額／識別碼／URL不可拆，checkout按可見標籤計詞。每個候選／報價完整呈現才開放選擇／同意，voice沿用相同text。

上述為舊版精簡／分頁的歷史行為，不是現行契約。`scripts\short-replies.js`已停用，執行只在本機回傳明確棄用錯誤，不取得token、不呼叫雲端，不能用它還原50詞指示。手動smoke現改驗非空完整答案及`moreReply=false`，不再斷言<=50詞或發送分頁續讀。`scripts\smoke-short-replies.js`保留舊檔名，但新報告寫入`.foundry\full-replies-smoke.json`並用`fullRepliesVerified`標示，不覆寫歷史`.foundry\short-replies-smoke.json`。這些smoke仍須另行明確授權才能付費執行；本輪沒有live重跑。

最新intent5的真實機場追問驗收為3次Responses、13,913回報tokens，16/12/12詞；`都可以`保留桃園／松山並前進詢問日期，明確重說兩機場也不丟失，見 `.foundry\airport-dialogue-smoke.json`。新flight v6資訊問答已真實檢索新synthetic-demo-only庫：2次Responses、14,859回報tokens、1次file_search、零供應工具，回覆46/12詞，見 `.foundry\flight-knowledge-smoke.json`。這些不是所有歷次費用總額。

原登入身分的 agents/read 403 已在使用者自行完成新登入後解除；重新檢查四個名稱均不存在才進行建立，沒有覆寫任何既有 agent，亦未自行登入／授予角色／切換 subscription。沒有新增 Foundry 資源、project、模型部署或變更地區；後續 Voice Live 僅使用同一既有資源與應用端設定。

`scripts\deploy-agents.js` 保存初始四角色繁體中文指令與嚴格工具定義。**掛載知識後不要用 `deploy:agents` 還原初版**：其保護機制會因新增 file_search 而拒絕不同定義。知識版本請使用 `scripts\ingest-knowledge.js` 的核對／重用流程；未知 agent 修改會停止而非覆寫。不可將這些命令當成新一輪雲端變更或推論的授權。

## 四個既有 prompt agents

曾有城市工具增量更新，私人環境的精確版本與資源識別不在此公開。`scripts\add-city-tool.js`會先核對目標環境既有definition與保存快照，再按其權限規則更新；操作前仍須另行授權。一般intent只摘原文，後端使用同源resolver；不讓LLM直接修改機場state。工具／Excel規格見[城市對照](CITY-AIRPORT-MAPPING.md)。

朗讀另經`lib\speech.js`的確定性繁中發音層後才送入既有`pre_generated_assistant_message`，不是另一個模型答案或未確認支援的SSML。canonical顯示／工具資料不變：字母分開拼、識別碼數字逐個讀零一二，日期／時間及TWD金額按語意讀；安全URL不唸token。canonical回覆沒有50詞限制；展開後朗讀仍受分段及音訊安全上限約束，不截掉必要事實冒充完整朗讀。歷史上已對同一Personal Voice做一次固定中文班號／日期／金額合成，收到923,872 bytes PCM；這是服務輸出證據，不是人工發音正確性或人聲相似度驗證。

四個 prompt agents 已依使用者明確授權建立於既有專案；應用 runtime 不會自動建立資源、部署模型、登入或授與角色。

**模型與既有部署名稱皆為 `gpt-5.4`**。四個 agents 已管理核對及實際呼叫；runtime 透過 agent reference 選模型，`FOUNDRY_MODEL_DEPLOYMENT` 只是管理中繼資料。既有資源經管理唯讀查詢確認 East US 2，Voice Live 實際合成音訊已通；未驗證生產負載。

Responses 使用 `agent_reference`，每次 `max_output_tokens=2500`、最多3工具輪／每輪3function calls；reasoning與intent JSON schema設於agent definition，沒有temperature／top_p。文字與語音共用100完成回合；雲端600requests、2,400,000回報tokens是獨立安全預算，取代過早截斷的40／80,000上限。軟門檻不是帳單硬上限；失敗仍可能消耗額度。未完成、拒絕、空文字或無效理解結果明確失敗。

| 角色 | 建議 agent 指令 | 允許工具 |
|---|---|---|
| intent | 辨識靈感／行程／查航班／票價意圖，指出缺少的條件；輸出繁體中文建議，不擅自確認交易 | list_airports |
| planner | 使用經人工核准的規劃準則與網站摘要，依旅客天數安排靈感（未指定才用三日），尊重少步行；不保證營業時間與無障礙 | list_airports、file_search |
| flight | 僅依明確出發、目的、含年份日期、人數、艙等搜尋；所有供應是 mock；不可自行擴大範圍 | list_airports、search_flights、get_offer |
| price | 區分候選價與確認價，不捏造即時價格；必須提醒重新報價與明確同意，不接受護照／付款資料 | get_offer、reprice_offer |

請勿在 agent 上配置會直接實際下單、付款、任意 HTTP 或修改本機狀態的 hosted tools。應用只能檢查自己處理的 function calls；無法攔截由雲端自主執行的額外工具。上線前要在 Foundry 側檢查每個 agent 的完整工具清單與最小權限。

**自然對話不再由完整 trip 閘門阻擋。** intent 在第一句就理解國家／城市／偏好及缺少資訊；嚴格 schema 只允許當則原文片段，後端逐欄檢查證據與值，不接受任意命令。discovery/draft 獨立於搜尋 trip；「下個月中」不猜日期，「帶媽媽」不猜成人數，東京／台北不默選機場，尚在探索不催問艙等。planner 可先按五天／少步行安排，搜尋前才問必要資訊。角色由後端協調，不是自動 A2A；選擇、同意與checkout永遠不由模型執行。

## 環境與身分

已將已核准的 Project Endpoint 與 live 模式寫入本機、被 `.gitignore` 排除的 `.env`：

```dotenv
APP_MODE=foundry
FOUNDRY_AUTH_MODE=azure-cli
PAYMENT_PROVIDER=mock
FOUNDRY_PROJECT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>
FOUNDRY_MODEL_DEPLOYMENT=gpt-5.4
```

私人開發環境的四個指定agents之名稱、版本、模型、工具與向量庫曾核驗；此公開版本移除實際resource／project識別，以上endpoint是待填佔位範例。沒有為版本收尾建立其他模型或deployment。

**Endpoint 本身不代表允許切換 live、登入、部署或呼叫付費服務**，也不確認資源區域、Voice Live 支援或音訊橋接已完成。`.env.example` 保留通用空白範本；分享範本不會帶出您的專案設定。

以下為既有固定版本設定示例；名稱是範本預設值，不是私人環境識別。核准環境的intent／planner原版號6只有在endpoint fingerprint、agent名及原版號精確符合本機`.foundry\presentation.json`時才解析為7，flight7／price5不變；未提供該檔案或其他環境不得假定自動升級：

```dotenv
APP_MODE=foundry
FOUNDRY_PROJECT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>
FOUNDRY_INTENT_AGENT=meihao-intent-agent
FOUNDRY_PLANNER_AGENT=meihao-travel-planner-agent
FOUNDRY_FLIGHT_AGENT=meihao-flight-checker-agent
FOUNDRY_PRICE_AGENT=meihao-price-purchase-agent
FOUNDRY_INTENT_VERSION=6
FOUNDRY_PLANNER_VERSION=6
FOUNDRY_FLIGHT_VERSION=7
FOUNDRY_PRICE_VERSION=5
```

版本放進 `agent_reference`；不填依服務預設。API 為 `{projectEndpoint}/openai/v1/responses`，不是 threads/runs。function calls 透過 `previous_response_id` 與 `function_call_output` 接續。內建 `file_search_call` 在服務端執行，不送到本機工具handler；文字引用的安全檔名會保留為靜態知識來源。

後端取得 `https://ai.azure.com/.default` token；本機設定 `FOUNDRY_AUTH_MODE=azure-cli` 重用使用者既有登入，通用範本為 `default`（DefaultAzureCredential）。瀏覽器不能傳 endpoint、agent、token 或 API key。正式部署改用 managed identity 與最小角色；此專案未自行登入或指派角色。

foundry模式會將當回合及按角色精簡的旅程／規劃資料送給指定agents並產生費用；intent另帶最近四則使用者需求（每則最多300字元），不是所有角色各送最近12筆完整對話。請不要輸入個資。未建立雲端conversation；本機history最多保留40筆訊息。token不寫log或傳瀏覽器。離線mock完全不呼叫雲端。

目前開發機的 skill 相依檢查發現 azd 1.23.0 安裝 `microsoft.foundry` extension 失敗（缺 `azure.ai.agents` 相依）。本機程式使用 REST 與 Node credential，不依賴該 extension，無需為 mock 升級全域工具。

## 靜態知識 vs 動態票價工具

規劃準則與經核准、可追溯來源的地理參考可放 Foundry 檔案／搜尋索引；請保存來源、擷取日期、適用範圍與核驗狀態。`data\network.json` 的航線與時刻為合成資料，不能當成任何航空公司的營運事實。

網站請先人工核准並提供摘要或授權快照，在 `data\planner-knowledge.json` 的 `approvedWebsites` 加入。此版本不爬網頁。網站／使用者內容都屬不可信資料，不能新增工具、覆寫價格或構成確認。

合成知識快照由本機manifest產生，包含45個地理參考機場、86條示範路線、20,640個合成班次與48,000筆合成票價；這些內容不來自任何航空公司的營運資料，也不代表真實庫存或價格。每筆marketing／operating均為合成標籤DEMO、codeshare=false；`synthetic-demo-not-real-world`明確標示非真實航線。只有manifest列出的檔案會被索引；詳見本機manifest，任何雲端上傳或更新都需另行核准。

| Agent | 完成索引檔案 | Vector store ID |
|---|---|---|
| intent | overview（1/1） | 私人metadata中保存 |
| planner | overview、geography、planner-context（3/3） | 私人metadata中保存 |
| flight | overview、geography、flights-01～06（8/8） | 私人metadata中保存 |
| price | overview、geography、fares-01～06（8/8） | 私人metadata中保存 |

四庫皆 `completed`、failed/cancelled/in_progress皆0，已核對各檔案membership。共用檔案只上傳一次，分別附到相關store。使用UTF-8 TXT、每chunk最多1200 tokens、重疊200；每筆記錄保留MOCK標示與原欄位，票價額外附航班日期／時區。規劃內容只有現有示例；沒有上傳未提供的使用者指南／網站。未新增AI Search基礎設施。

`prepare:knowledge`只產生本機快照。預設ingest重用hash並核對最新agent，未知變更或不同snapshot會停止；只有本次明確授權`--replace-snapshot`可建立新庫／替換file_search，新版本不掛舊庫，舊雲端資產保留稽核未刪除，可能繼續有儲存費。遷移保留APP_MODE與完整其他定義，失敗可從manifest續跑。不得把此命令當未來再次付費更新的授權。

**靜態RAG可解釋合成票價，但不可宣稱可售或據此確認交易。** 當前選班、機位與價格仍須以下嚴格handlers：

| 工具 | 嚴格參數 |
|---|---|
| list_airports | `{}` |
| search_flights | `origin`、`destination`：已知 IATA；`date`：YYYY-MM-DD；`travelers`：1–6 整數；`cabin`：economy/premium/business；`flexibleDays`：0/1 |
| get_offer | `offerId`：此工作階段已產生的 UUID |
| reprice_offer | `offerId`：目前已選擇的 UUID；MCP 版本只能選擇該連線已持有的 offer |

每個 JSON schema 都必須 `additionalProperties: false`；未知欄位在後端被拒絕，不能傳 `total` 或 `currency` 來改價。`search_flights` 在 Foundry adapter 額外要求與後端 trip 的所有搜尋欄位完全相同。

在 Foundry agents 上註冊同名 **function tools**（參數見 `lib\core.js` 的 `toolSchemas`）；模型請求由本機 adapter 實際執行，不是 disconnected demo。可透過 `npm run export:tools` 產生 `data\generated\foundry-tools.json`，其中包含與 MCP 同源的 JSON schema 與每個角色允許的工具，供手動註冊使用；命令只寫本機檔案，不呼叫雲端。為了維持工具輸出與對話清單的同一 session，不要讓 Foundry 再平行呼叫另一個獨立 MCP 連線取得不同 UUID。

如果改用 Foundry 原生 remote MCP 連線，須另部署認證的 HTTP MCP transport、綁定使用者／session、驗證 audience、工具權限及報價 ownership；本專案目前僅提供本機 stdio MCP，不能直接當成 Foundry 的遠端 URL。請勿開放匿名 stdio-to-HTTP proxy。

## 確認與交易邊界

Discover → Plan → Search → Compare → Select → Reprice → Book → Pay → Service。

P0 到**模擬結帳連結**，不實際訂位、開票或付款。真實Pay/Service、飯店與附加服務未實作。模型沒有consent/purchase工具。旅客可說「幫我看看現在這個票價，準備結帳」，模型辨識price意圖，由後端reprice。核對後說「我同意這個報價，請給我模擬結帳連結」或「確認目前報價」；後端精確驗證最新quote context才產生連結。否定、含糊或附帶條件絕不接受。沒有確認按鈕。

`lib\checkout.js` 是後端provider接點，目前只支援 `PAYMENT_PROVIDER=mock`，其他值會停止啟動，不能偷偷導向任意網址。連結為32-byte隨機token、同session／offer／quote版本／金額／TWD／到期綁定，與quote同時到期；重新報價、換航班、修改旅程後舊連結失效。重試同一接受請求只回同一連結。落地頁只顯示權威行程與金額、無卡號欄位／付款動作；他人session不能存取。未來真實供應商必須另外實作受控provider adapter與授權流程，不可用模型URL或泛用航空公司首頁代替所選票價的結帳。

瀏覽器每次送訊息都附上當時顯示的航班 UUID 清單與完整 quote context；選擇舊清單、context 缺漏／過期／金額版本不符、只有「同意」等含糊訊息、否定與帶條件確認，都不構成可執行同意。UUID requestId 綁定完整訊息作冪等重試，相同 quote 只建立一筆模擬收據。重新搜尋、修改旅程或 reprice 後必須重新同意，價格改變不能沿用舊同意。候選價到期不可再用，確認價不得比候選價晚到期。語音先送出文字結果並等待瀏覽器完成顯示的 turn acknowledgment，才將該報價／清單設為可接受 context；不從當前伺服器狀態盲取「最新」報價來代替使用者看過的版本。開始語音也核對既有畫面 context；後續仍逐欄驗證、期限與冪等。

冪等鍵的重試只回傳原模擬收據；同一確認價不重複建立。此示範不保留真實訂位或付款系統的交易紀錄；所有 session 都是記憶體資料。

## Voice Live：模式1既有流程與歷史驗收

本節只描述模式1及過往核准的證據；**不是四模式共通音訊格式、插話或AEC保證**。四種已啟用架構／配置gate以[上方定義](#四種已啟用語音架構)為準，不以本節歷史用量授權新呼叫。

官方文件已查閱：

- [How to use Voice Live](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to)
- [Voice Live prompt-agent quickstart](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-agents-quickstart)
- [Voice Live WebRTC](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-webrtc)
- [Voice Live 2026-07-15 API reference](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-api-reference-2026-07-15#responsecreate)
- [Foundry function calling](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/function-calling)

使用者過往曾核准模式1接線及有限用量驗收；當時資源管理查詢確認`eastus2`、AIServices、公開網路可用，沒有新建資源／模型、授權角色或更換訂閱。本次未呼叫管理API。

官方 prompt-agent 直連使用 `agent_name/project_name/agent_version`，不同於 classic `agent_id/project_id`。本應用不是單一 prompt agent：四角色協調、工具、交易與冪等都在本機。直接接其中一個會繞過既有旅程狀態；因此採**明確的伺服器控制 turn bridge**，保留所有原有代理與知識版本，未另外部署語音 agent。

```text
瀏覽器麥克風 → AudioWorklet PCM16/24kHz → 同源 WebSocket
  → 後端 Entra 驗證 → Azure Voice Live 語音辨識
  → 相同 chat(session, ...) → GPT-5.4 四角色、知識與權威工具
  → 送出對話文字（瀏覽器ack僅更新下一回合context，不阻塞合成）
  → Voice Live pre_generated_assistant_message → PCM → 瀏覽器播放
```

模式1 Voice Live使用`model=gpt-5.4`、`api-version=2026-07-15`，但`autoanswers=false`／VAD `create_response=false`，不自行生成第二個推理答案。`response.create.response.pre_generated_assistant_message`是官方支援的確切文字朗讀，不是「請模型照念」提示。輸入為`azure-speech`、`zh-TW`，輸出為既有Personal Voice／`DragonLatestNeural`；不遇錯fallback。本專案不建立／複製聲音或保存錄音，沒有browser SpeechRecognition／speechSynthesis。模式4的SSML是另一條Speech REST管線，不套用此Voice Live schema。

Voice Live標題旁代理標籤使用後端真實意圖／專責階段事件；同session文字則查詢只讀progress endpoint。不增加推論或語音用量、不把標籤送去合成、不把Voice Live當第五代理。role只允許intent／planner／flight／price，turnId／requestId隔離舊事件，完成、錯誤、停止有明確重設；不改任何已部署agent指令或工具權限。

官方通常建議瀏覽器使用WebRTC；此模式1本機POC採WebSocket PCM方便後端限制事件與同session控制。沒有同條件量測，不作WebSocket／WebRTC延遲排名。模式1 thinking／speaking持續收音；speech_started清播放並取消上游合成，完整轉錄才取代只讀模型工作。AbortSignal取消舊fetch，最多一個待辦更正、總訊息2,000字元；等舊工作settle再序列處理，過時結果不顯示／朗讀。已開始的交易不強制中斷、不自動重試、不假回滾。browser echoCancellation與模式1 server_echo_cancellation設定不代表真人房間回音已驗收，也不能外推為模式4 server AEC；建議耳機並另行實測。

```dotenv
VOICE_LIVE_ENABLED=true
VOICE_LIVE_ENDPOINT=https://<resource>.services.ai.azure.com/
```

`VOICE_LIVE_PROJECT_NAME/AGENT_NAME`舊欄位不使用，不填成直連單一agent。新四架構完全關閉須同時關閉`VOICE_LIVE_ENABLED`、`VOICE_LIVE_REALTIME_ENABLED`、`GPT_LIVE_ENABLED`及`DIRECT_SPEECH_ENABLED`；它們各自opt-in，Voice Live enabled不是總開關。舊checkout若仍有`VOICE_LIVE_STANDARD_ENABLED`也保持false，它不是新第四模式。即使`APP_MODE=mock`，另啟用語音仍可能產生Azure用量費。`GET /api/bootstrap` availability只是配置gate，不保證雲端健康；Realtime 2.1須同時揭露實際configuredModel與requiredModel，配置舊model就拒絕。

- 使用者按開始後才要求麥克風；AudioContext 必須支援24kHz，建議新版 Edge／Chrome。介面顯示連線、聆聽、思考、朗讀、靜音與錯誤；停止／關閉／pagehide會結束tracks、worklet、播放sources、AudioContext與sockets。
- `POST /api/voice/session` 先驗證同源cookie/session與顯示context，再回30秒一次性**本機**nonce；透過WebSocket subprotocol攜帶，不放URL／localStorage。它不是Azure credential，不能用於其他session。所有Entra bearer只在後端上游header。
- WebSocket升級驗證Host、Origin、session與nonce，僅接受PCM與mute/stop/displayed事件；瀏覽器不能傳endpoint、agent、instructions或response.create。CSP仍self-only，Permissions Policy只有啟用時允許self microphone。
- 移除五分鐘timer；文字／語音／續讀共用100完成回合，voice每連線最多100轉錄。不限制每旅程累計票券次數，同旅程限單一連線、全域4連線；input576MB（100×120秒PCM，包含靜音等待資料）、output288MB（100×60秒PCM）、每秒144KB突發及背壓維持。20秒session設定timeout與供應商／網路限制仍存在，不自動重連。這些不是帳單硬上限。
- 超過15秒的文字／語音模型等待顯示中性狀態，不另起朗讀／模型／工具、不計回合；更正按最新轉錄重新計時，完成／失敗／stop／retry清掉timer。文字pending時語音開始停用；語音中的新轉錄序列排隊／更正，不執行平行session寫入。停止音軌不提前釋放仍在工作的鎖。描述在按鈕下方折疊，診斷ID不擠在主錯誤文字。

2026-10-16新增真實合成音訊驗收`.foundry\voice-interrupt-smoke.json`：十月原請求注入25秒延遲，等待中說十一月中，取消原fetch、只交付最新答案、台北／大阪保留，產生373,800 bytes真實Voice Live回答；接續「11月15號出發」得到2026-11-15。不是真人mic／喇叭驗收。`.foundry\natural-flight-flow-smoke.json`以六個自然回合、7次Responses／40,546回報tokens完成兩機場皆可→11/15去→11/20回→2人→明確經濟艙，自動查出DEMO合成來回時間；最後45詞，不要求再次下搜尋命令。上述是限定驗收，不是所有歷次用量總額。

2026-10-18以現有intent5再驗模型原文span→canonical parser→draft→回覆，見`.foundry\date-spans-smoke.json`。模型確實會摘「十一月十五號去」「2026年11月15號去」及含標點的「26年11月15號出發。」；3次Responses／14,534回報tokens均正確保留出發與回程，21/13/23詞且不再追問出發日。後端日期證據解析修復，不需要新增agent版本或改雲端知識庫。腳本`smoke-date-spans.js --apply`限制三回合、90秒取消／100秒總截止、CLI token process timeout10秒，不自動重試驗證失敗。
- 語音與文字不平行寫同一旅程；語音啟用時composer停用，但文字結果與報價持續顯示。停止後可繼續文字或重新開始語音，狀態共用。尚未acknowledge的報價、舊清單、過期／改價及含糊同意均不成交；checkout仍純模擬。
- 真實雲端測試已通：Azure合成「我想去日本玩幾天。」120,600 bytes PCM → Voice Live正確中文轉錄 → 同一GPT-5.4流程保留日本偏好、零航班搜尋 → 800,400 bytes實際答覆音訊。紀錄 `.foundry\voice-smoke.json`，明確為**合成測試、非真人麥克風**。

模式1歷史付費smoke重跑命令為`npm run test:voice:live`，僅另行明確授權才執行，不能拿它代表四架構已測；一般`npm test`／`npm run test:ui`不呼叫Azure。本次未執行付費命令。四架構人工驗收用[同講稿](DEMO-SCRIPT.md)與[量測計畫](VOICE-COMPARISON.md)，先滿足配置gate再測。

## 驗收與上線前限制

既有離線測試覆蓋完整知識筆數／hash、四角色、MCP、日期／總額／艙等、探索偏好、原文證據、報價／同意／到期、session隔離及語音橋接／清理；本次新實作須看本次runner結果，不能沿用舊數字。過往真實驗收曾呼叫全部四agents／file_search、七句對話至模擬結帳，並通過模式1合成音訊迴路；這些不是新Realtime 2.1或Speech REST驗收。真人麥克風／喇叭、四模式同條件品質／延遲、真實航空庫存／付款及生產負載均未驗證。

公開部署前還必須增加正式登入／session ownership、持久化與併發控制、分散式限流與總費用控管、CORS／CSRF／HTTPS 政策、稽核與真實航空資料授權、實際交易與退款狀態機。此服務只為本機 POC，請勿直接曝光。
