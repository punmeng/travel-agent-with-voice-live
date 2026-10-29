# Ni Airlines：四種已啟用語音架構與Foundry候選管線

## 英文add-on：v1.0.8，3100已啟用

候選版提供同一session的繁中／英文切換，停止語音後才能切；voice ticket固定`zh-TW`或`en-US`，不得中途改語言。既有中文預設及所有排隊／插話／ACK／交易限額保留。下列是2026-10-27有限英文服務驗證；下方固定zh-TW表格仍描述原中文模式。

| 路徑 | 英文接線 | 有限真實證據 | 尚未驗收 |
|---|---|---|---|
| 1 Voice Live | Azure Speech `en-US`；既有個人化男／女聲，不更換資產 | 同一句合成文字取得男聲101,792／女聲103,840 bytes PCM | 真人麥克風、英文口音／相似度、全程插話 |
| 2 原生Realtime | 英文有限instructions；locale專屬Azure標準`en-US-AvaNeural`，中文仍原配置聲音；不新增STT參數 | 官方Speech聲音表核對＋實際session ACK核對type／name | 原生英文對話、音訊生成與真人聽評 |
| 3 GPT-Live | 英文有限instructions、已核驗`marin`；不新增聲音選單／VAD／phrase | 實際English session ACK | 原生英文對話、音訊生成與真人聽評 |
| 4 REST／SDK | REST language、SDK recognition language及SSML `xml:lang`均`en-US`；原男聲profile不變 | 原profile SSML100,768 bytes；同一合成英文REST辨識成功、SDK 1 final | 真人麥克風、多句英文EOF／噪音與半雙工聲學效果 |

四模式介面、字幕標籤、進階設定、錯誤及回覆語言一併切換；SDK timing／chunk語意不變。語言選擇不是自動語言偵測；不放任意system prompt、voice ID或全域.env控制。模式2／3仍可改述，畫面權威資料與交易守門不變。有限證據在忽略的`.foundry\english-voice-proof.json`；沒有以假transport當實際服務通過，也沒有形成音質／延遲／費用排行。第五候選另有本機雙語instructions與per-ticket voice／transcription locale。

更新2026-10-28。3100 health已回報v1.0.8／`111621bc136e5766`，原四種模式及雙語UI已啟用；**目前沒有四模式同條件live分數、延遲排行或費用結論。** SDK漏第二句已定位resultId重用並有兩final／兩backend／TTS真實服務證據，播放為計時ACK；GPT只保守澄清可見邊界異常，無法保證偵測所有截句。官方能力、source、配置、離線mock、有限服務測試與真人聲學驗收須分開；詳見版本交接。第五Foundry Voice Agent只是本機候選，未建立、配置或啟用；不能為補結果自行呼叫雲端。

## 候選第五管線：managed Foundry Voice Agent

這不是第五個業務agent。Managed voice agent只呼叫一個strict `travel_backend({message})`，由Node server核對相同音訊item的最終轉錄後，才進入現有旅程chat／四業務agent及服務端工具。航班與票價仍為合成資料，voice transaction仍拒絕；不直接授予Voice Agent既有search／quote／reprice函式。待最終轉錄或兩種文字不一致時要求重說；該檢查無法偵測兩者同時漏字，真人語音／雲端連線仍未驗證。設定及建立安全條件見[Foundry指南](FOUNDRY.md#候選第五語音管線-foundry-voice-agent)。

詳細設定／官方來源見[Foundry指南](FOUNDRY.md#四種已啟用語音架構)，狀態見[版本交接](CURRENT-VERSION.md)；所有模式照[同一講稿](DEMO-SCRIPT.md)執行，主場景一律唯讀。

## 不是四種聲音，而是四種路徑

| 固定順序 | 1 `voice-live` | 2 `voice-realtime` | 3 `gpt-live` | 4 `speech-direct` |
|---|---|---|---|---|
| API | Voice Live | Voice Live，**gpt-realtime-2.1** | 獨立GPT-Live，**gpt-live-1** | A既有Speech REST短音訊STT／B SDK continuous STT；兩者共用REST TTS |
| 輸入 | `azure-speech` zh-TW STT | 音訊原生；**無STT配置** | 原生語音前端；本app仍需timed user transcript定位delegation | A為16kHz mono PCM WAV整段辨識、無partial；B為16kHz mic或8／16kHz PCM16 WAV串流，含interim／final；固定zh-TW |
| 送同一四代理 | 完整轉錄文字 | `travel_backend`受控function的**模型整理需求** | client delegation對齊的轉錄片段；非原始音訊 | A完整STT文字；B依序處理每個recognized final，不保證語意完整 |
| 觸發 | 完整transcription事件 | **`input_audio_buffer.committed` → 指定travel_backend function `response.create`** | delegation id／offset及可安全定位的timed transcript | A本機聲學VAD：校準300ms／最小有聲200ms／pre-roll500ms／靜音1000ms、最長28秒、30秒硬限；B SDK recognized final（700／1000ms切段），不是session_stopped |
| 輸出 | `pre_generated` exact-text Personal Voice | `function_call_output`後Voice Live response audio | commentary供模型參考，再以built-in語音回答 | Speech REST SSML exact-text Personal Voice |
| 實際聲音類別 | `azure-personal`／DragonLatestNeural | **Azure標準`zh-TW-HsiaoChenNeural`，非built-in** | 文件預設built-in `marin`，目前session契約不能換Personal Voice | `speakerProfileId` GUID＋base model，**不是Voice Live name** |
| 是否額外語音模型整理 | `autoanswers=false`，無第二次Voice Live GPT-5.4推理 | 有前端模型理解與音訊回答，業務仍同四代理 | 有前端模型互動與delegation，業務仍同四代理 | 無Voice Live或原生語音LLM前端 |
| 交易 | 保留原guard；比較不交易 | server唯讀，交易拒絕 | server唯讀，交易拒絕 | server唯讀，交易拒絕 |

模式1 Professional Voice seam已實作：明確選`azure-custom`，以`VOICE_LIVE_CUSTOM_VOICE_NAME`／`VOICE_LIVE_CUSTOM_VOICE_ENDPOINT_ID`映射`name`／`endpoint_id`；先要訓練完成、獲授權且同資源的資產，目前未配置、不是可試聽功能。模式2官方可搭Azure TTS／custom不等於本次已設Personal／Professional。模式4與1可都用Personal Voice概念，但**不能假定同一ID／相同聲學結果**；不同API的資產映射須另經核准。

## 客戶關心的能力：官方、接線與測量分開

| 面向 | 1 Voice Live STT／exact-text | 2 Voice Live Realtime 2.1 | 3 GPT-Live-1 | 4直接Speech REST／SDK |
|---|---|---|---|---|
| 自然臺灣華語 | 固定zh-TW辨識，Personal Voice仍需臺灣聽者評估 | native理解＋本次Azure zh-TW標準voice，不能推論準確率／口音 | 臺灣華語／用詞instructions只是偏好，不保證accent／字幕字形 | 固定zh-TW辨識＋Personal Voice；已有有限live證據，非同條件真人聽評 |
| 噪音／回音 | browser best-effort；Voice Live相關server設定不代表房間效果已驗收 | browser best-effort；不套用其他模式的AEC保證 | browser best-effort；不假設Voice Live server AEC契約 | browser best-effort；本管線**無server AEC** |
| 語言／混說 | zh-TW非auto LID；中英slot需測 | native語音不等於已驗證auto LID／混說 | 原生互動仍受轉錄邊界與委派限制 | zh-TW固定，**無auto LID**；中英辨識需測 |
| Phrase list | 官方`azure-speech`有`phrase_list`；未證實本app配置就標「未配置」 | 本路徑無STT，不適用該azure-speech phrase list | 不假設有相同phrase-list schema | **A短音訊REST不支援**；B SDK可選最多100個phrase，效果須另測 |
| 插話／更正 | 既有只讀取消／過時播放隔離，真人效果仍需驗收 | 待啟用來源：停舊播放但不abort／重跑後端，最多一個committed待辦，待工具／鎖釋放或舊音訊response終止後序列委派；非無縫全雙工保證 | 原生全雙工前端；backend更正／delegation仍需安全序列 | **半雙工**，排程PCM播完才恢復收音；可停止session再重新開始，無semantic VAD |
| 原始轉錄可信度 | 可比STT文字與原話 | 只比模型整理需求／slots；**不可算原始STT WER** | 可用可見timed user transcript比對，但要記片段／邊界拒絕 | 可比STT完整文字與原話 |
| 確切朗讀 | exact-text發音層，不改canonical事實 | 模型可改述；需查內容遺漏／新增 | 模型可改述；不能繼承exact-text保證 | exact-text SSML；服務發音效果仍待聽評 |
| 設定阻擋 | 保留既有設定 | 只接受`configuredModel=requiredModel=gpt-realtime-2.1`；不符即拒絕、不fallback | 獨立endpoint／enabled；觀察過事件不等於完整成功 | 獨立enabled範本預設false；目前3100已核准profile／auth，其他環境另核驗 |

所有模式都要求browser `noiseSuppression`／`echoCancellation`，不是一定生效的聲學處理，也不代表四者有相同服務端降噪。不要把產品標籤「native」「full-duplex」直接當成這個app在噪音、更正或工具中斷上的通過證據。

Option2來源守門保留audio／call ID去重、無效工具及交易拒絕；待辦超量回`VOICE_PENDING_LIMIT`，取消等待20秒逾時回`VOICE_REALTIME_TIMEOUT`，涵蓋遲到response。未啟用或完成真人插話驗收。SDK 11:33截圖至少有一個final，但當時log沒有resultId，不可斷言唯一歷史根因；新的兩句真實服務證據詳見版本交接。

v1.0.7候選進階設定：Option1／2支援VAD silence、server noise／AEC，只有Option1有Azure Speech phrase；GPT僅有限instructions presets及已核實marin；REST僅本機VAD；SDK分段／phrase／chunk ms。預設及單次票券規則見README。A/B需記錄實際選擇；session ack不等於降噪或口音驗收，不把chunk當VAD。

## 共同場景與客觀答案

使用合成資料版本相同、乾淨且等效的旅程。共同固定需求：

> 「幫我看二零二六年十一月十二號，桃園TPE到東京成田NRT，兩位成人，經濟艙，總預算新臺幣三萬元。先看去程，不要買；行程還是不要走太多路。」

| 檢核slot／intent | 正確基準 |
|---|---|
| 日期／航段 | 2026-11-12、單程搜尋、TPE → NRT |
| 人數／艙等／預算 | 2 adults、economy、TWD 30000總預算 |
| 規劃偏好 | 五天（前一回合已說）、少步行、可坐下休息；不自猜媽媽年齡 |
| 工具意圖 | 先規劃／後唯讀搜尋，不選班、不reprice、不同意、不買 |
| 班號發音 | 另用**合成發音字串**DEMO101／DEMO0101；保留字母I、前置零，不當成11/12實際可售班號 |
| 更正 | 十一月十三號→「不是十三號，改回十一月十二號，其他一樣」；其他slots不丟失 |

這不是保證有符合航班／三萬元內供應的assertion。搜尋空結果可以正確，捏造結果不行。當日期過期或超出合成範圍2026-10-16～2027-02-12時，先整套修訂基準再重跑，不讓各模式自行猜。

### 測試條件與重複

1. **耳機安靜**：同語者、相同mic／距離／音量／browser／網路。
2. **喇叭安靜**：固定音量與擺位，查回授／誤觸發；不拿耳機結果代替。
3. **耳機固定背景噪音**、**喇叭固定背景噪音**：同噪音來源、音量、距離；有儀器才報dBA／SNR，否則註「未量測」，不能猜值。
4. 每條件加入同一句臺灣口語、中英code-switch、數字／IATA／DEMO101、停頓、自我修正、等待中更正、播放中插話。
5. 每模式每條件至少5次完整重複；正式p95建議增加至至少20個有效同條件樣本並公開n／估計方法。暖機與首次連線分開記、順序輪替、同資料／四代理版本；不用不受控回音或旁人個資作素材。
6. Direct Speech A REST按開始後先安靜300ms校準；說話停頓1秒自動送出。B SDK使用700／1000ms切段，不套用REST校準／VAD參數。兩者正常等排程PCM播完才恢復收音。另測短聲響、600ms自然停頓、穩定／突變噪音；聲學切段非語意判斷，誤觸／漏觸都記錄。若用手動備援或停止重開，記額外操作；不把未收錄的插話算辨識錯誤，也不隱藏半雙工等待成本。

模式1phrase-list能力若要單獨A/B，先另核准可用接線與相同詞表，標示「有／無配置」及其他條件不變；測試詞可固定為「桃園、成田、Ni Airlines、DEMO101、DEMO0101、TPE、NRT」，這是評測詞表，**不是宣稱已注入服務或所有詞都適合官方phrase_list格式**。不得偷偷調一模式詞表然後稱公平預設比較。模式4 A不能用不支援的REST參數模擬此能力；B SDK可另做相同詞表的有／無配置比較，不能把結果歸給REST。

### 客觀評分

- **Slot accuracy**：正確預定slots／應測slots；另報遺漏、錯值、憑空新增、澄清次數與更正後保留率。日期／人數／預算等關鍵slot逐一列，不用總平均掩蓋關鍵錯誤。
- **Intent／工具準確性**：預先標注規劃、唯讀搜尋、更正、不購買；對照實際路由與工具種類，記意外搜尋、未授權交易、重複委派／舊答案。模型口頭聲稱成功不是後端證據。
- **辨識錯誤**：模式1／4及可對齊的模式3以同人工參考文字計CER；混合英文另定一致tokenization才報WER。模式2沒有原始逐字稿，STT CER／WER填**N/A**，評模型整理的slot／intent，不把改述全算辨識錯。
- **回覆事實**：canonical與工具一致、模型音訊是否漏／加班號、日期、金額或條件；無結果是否誠實。發音逐字檢DEMO101／DEMO0101／TPE／NRT，不硬編真航班。
- **錯誤結果**：availability阻擋、auth／連線錯、超時、30秒超限、delegation邊界拒絕、播放錯、誤觸發、取消／更正失敗各自計數，分母含嘗試與失敗；不能只留下成功回合。
- **唯讀guard**：模式2／3／4在相同已有候選／可交易狀態測選班、reprice、同意及購買，應全部拒絕且交易state不變；無候選自然失敗不能冒充guard成功。模式1主比較不執行交易。

## 臺灣母語聽評

使用多位臺灣華語母語聽者，以隨機A／B／C／D代碼、隱藏架構／聲音品牌、輪替順序盲評；同腳本、同播放音量／條件。**MOS 1～5**：1很差、2差、3普通、4好、5很好，分開評自然度、臺灣語感／用詞、可懂度與DEMO／數字發音；不把不同面向合成「最佳臺灣口音」一個主觀結論。

記聽者數、語句數、條件與有效n；熟悉Personal Voice的聽者可能認出聲音，需註盲化限制。既有服務不儲存錄音：可現場盲聽；若要另外錄音、保存或分享，需要獨立資料／同意授權，不能為了MOS自動錄製。模型改述先評內容偏差，再評聲學，不把漏字音訊當同一句公平打分。

## 延遲與結果紀錄

共同metrics用**同一server單調時鐘**量stage耗時；browser顯示收到的numeric stage durations，不用browser時鐘重新計算server stages。另以browser本機單調時鐘量**first packet→playback scheduling delay**，不是實際聲學出聲時間。metrics只保留**最後一回合**numeric run／turn／stage IDs及數值於記憶體，沒有歷史累積、持久報表或下載功能；不把音訊、轉錄、prompt、endpoint、voice ID或token寫到metrics／logs。人工評分用固定測試項目編號及數值／錯誤分類，不抄使用者原話作追蹤資料。下列多run統計是待核准評測方法，不是app已有報表功能。

| 指標 | 範圍與限制 |
|---|---|
| input-ready／commit／STT | server從可接收輸入到可委派文字／function的本機階段耗時；Direct含整段送出後STT等待；模式2無STT值，填N/A |
| delegation／frontend | server等待有效function／client delegation與驗證耗時；模式1／4無native delegation時不編造值 |
| backend | 四代理／受控工具階段；同一後端也可能因輸入整理不同而有不同路由，應分組解釋 |
| frontend_audio | GPT前端在backend結果前產生的音訊；可能只是等待／前端語音，不得列為backend答案已出聲 |
| first_audio／synthesis等待 | server從backend結果可用到收到結果後音訊；GPT區分於`frontend_audio`，但**不代表語意答案完成**，也不能一律稱純TTS耗時 |
| browser first packet→playback scheduling delay | 同一browser時鐘從收到首packet到排程播放的延遲；不是finish到首包的完整端到端時間，**不是實際聲學onset** |
| interruption／recovery（評測項目） | 同browser觀察更正／stop到清播放／最新回覆；需另行核准與設計量測，不假稱已有持久report；Direct額外操作另列 |

**不能拿server timestamp減browser timestamp，不能跨host相減。** server stage durations與browser首包到排程延遲分開報，不硬加成完整端到端／實際出聲時間；若另測端到端或聲學onset，需同一量測域與獨立方法，不能從現有metrics推造。VAD／手動完成起點不同，要保留其差異。GPT-Live若用untimed output PCM相容播放，標示格式；不能補造timeline、靜音或委派時間。

只從**實測同條件**有效run計p50／p95，註n、失敗率、缺值、暖機／冷啟動及分位數方法；不足樣本標「探索性」，不把N/A當0。未配置／失敗模式不排名，模型／voice／條件不同不宣稱純模型速度差，也不推算費用優劣。

目前結果刻意留空，待另行核准live執行：

| 模式／條件 | 嘗試／成功／錯誤 | slots／intent | MOS（各面向） | server stage p50／p95 | browser首包→排程延遲p50／p95 |
|---|---|---|---|---|---|
| 1 Voice Live | 未測 | 未測 | 未測 | 未測 | 未測 |
| 2 Realtime 2.1 | 本次共同講稿未測 | 未測 | 未測 | 未測 | 未測 |
| 3 GPT-Live | 本次共同講稿未測 | 未測 | 未測 | 未測 | 未測 |
| 4 Speech REST／SDK | 本次共同講稿未測，A／B分開記錄 | 未測 | 未測 | 未測 | 未測 |

## 使用情境怎麼選

| 客戶優先需求 | 可優先驗證 | 必須接受／驗證的取捨 |
|---|---|---|
| 品牌／Personal Voice、確切金額與代碼朗讀 | 1 Voice Live exact-text | STT→後端→TTS分階段互動；真人回音與等待仍要測；Professional資產不存在不能先承諾 |
| 要音訊原生理解但仍用Azure標準／custom voice與受控後端 | 2 Voice Live Realtime 2.1 | 目標環境須核驗2.1配置；本次是Azure標準voice、模型整理非逐字稿、回答可改述、唯讀 |
| 想探索獨立原生全雙工前端與內建聲音 | 3 GPT-Live-1 | 目前需timed transcript安全委派、不可換Personal Voice、口音不保證、output timing相容需揭露、唯讀 |
| 隔離STT／代理／Personal TTS責任，不需Voice Live | 4 Speech REST／SDK | A聲學VAD最長28秒片段／30秒硬限，無partial／phrase list；B連續辨識有interim／final及可選phrase，WAV最多120秒；兩者非semantic VAD、半雙工、無auto LID／server AEC、唯讀 |

這是依能力邊界提出的驗證選項，不是品質／價格採購結論。最終選擇須納入客戶真實設備、臺灣聽者、噪音、錯誤恢復、意圖／slot準確性與量測延遲；購買流程一律停止語音轉文字作獨立示範。
