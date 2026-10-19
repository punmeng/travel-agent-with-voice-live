# Foundry 四代理與 Voice Live 接線指南

**目前本機版本已收整，Azure工作暫停。** 重現方式與最新驗證狀態見[版本交接](CURRENT-VERSION.md)。下列Hosted Agent段落保留實驗證據，不代表已交付線上版本，也不構成後續付費呼叫、角色授權或部署許可。

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

之後切換設定仍需受控重啟（memory-only旅程會消失）；先告知使用者。明確設定`VOICE_LIVE_VOICE_TYPE=azure-standard`才改回預建`zh-TW-HsiaoChenNeural`，不是遇錯自動換聲。四代理、插話中止、50詞及交易確認管線保持不變。

本指南與官方文件存取日期：**2026-10-16**。使用者已明確核准 GPT-5.4 推論／檢索驗收與模擬結帳。**真實自然探索→五天行程→合成來回票→重新報價→明確接受→模擬結帳已通過**，包括實際 file_search；紀錄見 `.foundry\live-smoke.json`。本機 `.env` 現為 foundry；通用範本仍預設離線 mock。

公開快照不包含上述私人`.foundry`證據檔、實際資源／vector store／voice識別或憑證。管理腳本已移除硬編碼的開發環境endpoint，改要求`FOUNDRY_APPROVED_PROJECT_ENDPOINT`與`FOUNDRY_PROJECT_ENDPOINT`完全一致；預設留白會在任何操作前拒絕。這只保留明確目標核對，不是雲端變更或費用許可，不影響一般chat／Voice runtime。不要為重現本機mock而填入或執行管理腳本。

## 目前部署狀態（2026-10-19；初次部署2026-10-16）

**四個 prompt agents 已成功建立並透過管理 API GET 驗證**，皆綁定既有 `gpt-5.4` 部署：

| 角色 | 已建立名稱 | 已驗證版本 | 已驗證工具 |
|---|---|---|---|
| intent | `meihao-intent-agent` | `6` | list_airports、resolve_city_airports、file_search；JSON 原文片段理解 |
| planner | `meihao-travel-planner-agent` | `6` | list_airports、resolve_city_airports、file_search |
| flight | `meihao-flight-checker-agent` | `7` | list_airports、resolve_city_airports、search_flights、get_offer、file_search |
| price | `meihao-price-purchase-agent` | `5` | get_offer、reprice_offer、file_search |

已將實際名稱與版本寫入 `.env`，管理驗證紀錄保存在 `.foundry\deployment.json`。v2 完成知識掛載後，v3 增加自然對話／低推理強度與 intent JSON 輸出；flight v4 修正推論服務不接受的 sibling-property `$ref`（改為同源內聯 schema），並保留原功能與知識。未建立新資源／模型，未執行模型生成的 evaluation suite。工具為應用執行的 function calls，不是公開 MCP 或自動 Foundry A2A。

先前4/4/5/4由 `scripts\short-replies.js` 核對定義後追加精簡規則；本次5/5/6/5以明確`--replace-snapshot`替換synthetic-demo知識庫，保留模型、functions、reasoning、JSON格式與既有精簡指令，追加synthetic-demo及機場集合界線。新版本／附件已管理GET驗證，`.env`保留live不翻回mock。後端 `lib\replies.js` 才是<=50詞硬限制；超長內容完整分頁、說「繼續」讀取，不花模型費。中文按Intl.Segmenter zh-Hant詞分段；日期／金額／識別碼／URL不可拆，checkout按可見標籤計詞。每個候選／報價完整呈現才開放選擇／同意，voice沿用相同text。

最新intent5的真實機場追問驗收為3次Responses、13,913回報tokens，16/12/12詞；`都可以`保留桃園／松山並前進詢問日期，明確重說兩機場也不丟失，見 `.foundry\airport-dialogue-smoke.json`。新flight v6資訊問答已真實檢索新synthetic-demo庫：2次Responses、14,859回報tokens、1次file_search、零供應工具，回覆46/12詞，見 `.foundry\flight-knowledge-smoke.json`。這些不是所有歷次費用總額。

原登入身分的 agents/read 403 已在使用者自行完成新登入後解除；重新檢查四個名稱均不存在才進行建立，沒有覆寫任何既有 agent，亦未自行登入／授予角色／切換 subscription。沒有新增 Foundry 資源、project、模型部署或變更地區；後續 Voice Live 僅使用同一既有資源與應用端設定。

`scripts\deploy-agents.js` 保存初始四角色繁體中文指令與嚴格工具定義。**掛載知識後不要用 `deploy:agents` 還原初版**：其保護機制會因新增 file_search 而拒絕不同定義。知識版本請使用 `scripts\ingest-knowledge.js` 的核對／重用流程；未知 agent 修改會停止而非覆寫。不可將這些命令當成新一輪雲端變更或推論的授權。

## 四個既有 prompt agents

2026-10-19城市工具增量更新：intent **6**、planner **6**、flight **7**、price **5**。`scripts\add-city-tool.js`先GET核對四角色最新definition與保存快照完全相同，再只為前三者追加`resolve_city_airports`及地理界線說明；原model、instructions、JSON格式、reasoning、file_search及相同vector stores保持，price沒有新增權限／版本。新版本已管理GET逐一核驗，exact refs保存在`.env`及`.foundry`。較早部署紀錄的5/5/6/5是更新前版本。一般intent仍只摘原文，後端使用同源resolver；不讓LLM直接修改機場state。工具／Excel規格見[城市對照](CITY-AIRPORT-MAPPING.md)。

朗讀另經`lib\speech.js`的確定性繁中發音層後才送入既有`pre_generated_assistant_message`，不是另一個模型答案或未確認支援的SSML。canonical顯示／工具資料不變：字母分開拼、識別碼數字逐個讀零一二，日期／時間及TWD金額按語意讀；安全URL不唸token。50詞仍限制canonical回覆，不截掉展開後的必要事實。已對同一Personal Voice做一次固定中文班號／日期／金額合成，收到923,872 bytes PCM；這是服務輸出證據，不是人工發音正確性或人聲相似度驗證。

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

以下是本次已核准並驗證的設定：

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

foundry 模式會將當回合、最近12筆對話（最多6輪）、探索偏好、結構化旅程與必要工具結果送給指定agents並產生費用。請不要輸入個資。未建立雲端conversation；每次送有界history，本機最多保留40筆訊息。token不寫log或傳瀏覽器。離線 mock 完全不呼叫雲端。

目前開發機的 skill 相依檢查發現 azd 1.23.0 安裝 `microsoft.foundry` extension 失敗（缺 `azure.ai.agents` 相依）。本機程式使用 REST 與 Node credential，不依賴該 extension，無需為 mock 升級全域工具。

## 靜態知識 vs 動態票價工具

規劃準則與已取得授權的官方航點資料可放 Foundry 檔案／搜尋索引；請保存來源、擷取日期、適用範圍與核驗狀態。`data\network.json` 含未逐項驗證的官方參考入口，不能把示範 routes 當官方事實。

網站請先人工核准並提供摘要或授權快照，在 `data\planner-knowledge.json` 的 `approvedWebsites` 加入。此版本不爬網頁。網站／使用者內容都屬不可信資料，不能新增工具、覆寫價格或構成確認。

使用者核准全量合成資料（含票價）與synthetic-demo替換的儲存／embedding索引。新15個TXT共50,566,840 bytes；45地理機場、86有向假設DEMO航線、20,640航班、48,000票價，日期不變，全量無截斷。每筆marketing／operating均DEMO、codeshare=false，**但所有航線仍是synthetic-demo-not-real-world，沒有逐航線官方營運核驗**。已刪原松山-羽田、桃園-奧克蘭直飛、桃園-宿霧示範；不以AE／合作航空補位。舊22,080不能再當目前計數。詳見manifest與`.foundry\knowledge-ingestion.json`。

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

## Voice Live：真正音訊與四代理共用流程

官方文件已查閱：

- [How to use Voice Live](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-how-to)
- [Voice Live prompt-agent quickstart](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-agents-quickstart)
- [Voice Live WebRTC](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-webrtc)
- [Voice Live 2026-07-15 API reference](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-api-reference-2026-07-15#responsecreate)
- [Foundry function calling](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/function-calling)

使用者已明確核准本次 Voice Live 接線與有限用量驗收。現有資源管理查詢確認 `eastus2`、AIServices、公開網路可用；沒有新建資源／模型、授權角色或更換訂閱。

官方 prompt-agent 直連使用 `agent_name/project_name/agent_version`，不同於 classic `agent_id/project_id`。本應用不是單一 prompt agent：四角色協調、工具、交易與冪等都在本機。直接接其中一個會繞過既有旅程狀態；因此採**明確的伺服器控制 turn bridge**，保留所有原有代理與知識版本，未另外部署語音 agent。

```text
瀏覽器麥克風 → AudioWorklet PCM16/24kHz → 同源 WebSocket
  → 後端 Entra 驗證 → Azure Voice Live 語音辨識
  → 相同 chat(session, ...) → GPT-5.4 四角色、知識與權威工具
  → 對話文字顯示／context acknowledgment
  → Voice Live pre_generated_assistant_message → PCM → 瀏覽器播放
```

Voice Live 使用 `model=gpt-5.4`、`api-version=2026-07-15`，但 `create_response=false`，不自行生成第二個答案。`response.create.response.pre_generated_assistant_message` 是官方支援的確切文字朗讀，不是「請模型照念」提示。輸入為 `azure-speech`、`zh-TW`，輸出目前明確設定為既有Personal Voice／`DragonLatestNeural`；預建`zh-TW-HsiaoChenNeural`需明確設定使用，不作錯誤fallback。本專案不錄製、上傳或複製聲音；沒有 browser SpeechRecognition／speechSynthesis。

Voice Live標題旁代理標籤使用後端真實意圖／專責階段事件；同session文字則查詢只讀progress endpoint。不增加推論或語音用量、不把標籤送去合成、不把Voice Live當第五代理。role只允許intent／planner／flight／price，turnId／requestId隔離舊事件，完成、錯誤、停止有明確重設；不改任何已部署agent指令或工具權限。

官方通常建議瀏覽器使用 WebRTC；這個本機POC用受支援的WebSocket PCM路徑，方便後端限制音訊／事件與同session控制。TCP與非串流GPT turn延遲仍高於WebRTC。現在thinking／speaking皆持續收音；speech_started清播放並取消上游合成，完整轉錄才取代只讀模型工作。AbortSignal取消舊fetch，最多一個待辦更正、總訊息2,000字元；等舊工作安全settle再序列執行合併上下文，過時結果不顯示／朗讀。已開始的選班／重報價／確認不強制中斷、不自動重試，補充內容排在完成後且不繼承未看過的quote同意。browser echoCancellation加官方server_echo_cancellation降低自我回授；未驗證真人房間回音品質，建議耳機。

```dotenv
VOICE_LIVE_ENABLED=true
VOICE_LIVE_ENDPOINT=https://<resource>.services.ai.azure.com/
```

`VOICE_LIVE_PROJECT_NAME/AGENT_NAME` 舊保留欄位不使用，不應填成直連單一 agent。`.env.example` 預設 false；即使 APP_MODE=mock，單獨啟用語音也仍會產生 Azure 語音用量費，只有 false 才完全停用語音。`GET /api/bootstrap` 的 available 表示設定可建立連線，不是預先保證雲端健康；實際拒絕會顯示錯誤。

- 使用者按開始後才要求麥克風；AudioContext 必須支援24kHz，建議新版 Edge／Chrome。介面顯示連線、聆聽、思考、朗讀、靜音與錯誤；停止／關閉／pagehide會結束tracks、worklet、播放sources、AudioContext與sockets。
- `POST /api/voice/session` 先驗證同源cookie/session與顯示context，再回30秒一次性**本機**nonce；透過WebSocket subprotocol攜帶，不放URL／localStorage。它不是Azure credential，不能用於其他session。所有Entra bearer只在後端上游header。
- WebSocket升級驗證Host、Origin、session與nonce，僅接受PCM與mute/stop/displayed事件；瀏覽器不能傳endpoint、agent、instructions或response.create。CSP仍self-only，Permissions Policy只有啟用時允許self microphone。
- 移除五分鐘timer；文字／語音／續讀共用100完成回合，voice每連線最多100轉錄。每旅程3次票券、全域4連線；input576MB（100×120秒PCM，包含靜音等待資料）、output288MB（100×60秒PCM）、每秒144KB突發及背壓維持。20秒session設定timeout與供應商／網路限制仍存在，不自動重連。這些不是帳單硬上限。
- 超過15秒的文字／語音模型等待顯示中性狀態，不另起朗讀／模型／工具、不計回合；更正按最新轉錄重新計時，完成／失敗／stop／retry清掉timer。文字pending時語音開始停用；語音中的新轉錄序列排隊／更正，不執行平行session寫入。停止音軌不提前釋放仍在工作的鎖。描述在按鈕下方折疊，診斷ID不擠在主錯誤文字。

2026-10-16新增真實合成音訊驗收`.foundry\voice-interrupt-smoke.json`：十月原請求注入25秒延遲，等待中說十一月中，取消原fetch、只交付最新答案、台北／大阪保留，產生373,800 bytes真實Voice Live回答；接續「11月15號出發」得到2026-11-15。不是真人mic／喇叭驗收。`.foundry\natural-flight-flow-smoke.json`以六個自然回合、7次Responses／40,546回報tokens完成兩機場皆可→11/15去→11/20回→2人→明確經濟艙，自動查出DEMO合成來回時間；最後45詞，不要求再次下搜尋命令。上述是限定驗收，不是所有歷次用量總額。

2026-10-18以現有intent5再驗模型原文span→canonical parser→draft→回覆，見`.foundry\date-spans-smoke.json`。模型確實會摘「十一月十五號去」「2026年11月15號去」及含標點的「26年11月15號出發。」；3次Responses／14,534回報tokens均正確保留出發與回程，21/13/23詞且不再追問出發日。後端日期證據解析修復，不需要新增agent版本或改雲端知識庫。腳本`smoke-date-spans.js --apply`限制三回合、90秒取消／100秒總截止、CLI token process timeout10秒，不自動重試驗證失敗。
- 語音與文字不平行寫同一旅程；語音啟用時composer停用，但文字結果與報價持續顯示。停止後可繼續文字或重新開始語音，狀態共用。尚未acknowledge的報價、舊清單、過期／改價及含糊同意均不成交；checkout仍純模擬。
- 真實雲端測試已通：Azure合成「我想去日本玩幾天。」120,600 bytes PCM → Voice Live正確中文轉錄 → 同一GPT-5.4流程保留日本偏好、零航班搜尋 → 800,400 bytes實際答覆音訊。紀錄 `.foundry\voice-smoke.json`，明確為**合成測試、非真人麥克風**。

重跑付費驗收：`npm run test:voice:live`，只在明確授權時執行；一般 `npm test`／`npm run test:ui`不呼叫Azure。人工驗收請按開始、允許麥克風、說一句旅行想法，核對轉錄與朗讀，再測靜音／停止、文字接續。詳細五至八分鐘流程見 [示範講稿](DEMO-SCRIPT.md)。

## 驗收與上線前限制

離線測試覆蓋完整知識筆數／hash、四角色、MCP、來回日期與總額／艙等、探索偏好、原文證據、舊報價／否定同意／連結到期與他人session，以及語音橋接／權限／停止清理。真實驗收已呼叫全部四個agents，觀察到內建file_search，成功完成七句對話至模擬結帳；Voice Live實際合成音訊迴路亦通過。可在核准範圍執行付費smoke，但不屬一般 `npm test`。真人麥克風／喇叭、真實航空庫存、實際付款及生產負載均未驗證。

公開部署前還必須增加正式登入／session ownership、持久化與併發控制、分散式限流與總費用控管、CORS／CSRF／HTTPS 政策、稽核與真實航空資料授權、實際交易與退款狀態機。此服務只為本機 POC，請勿直接曝光。
