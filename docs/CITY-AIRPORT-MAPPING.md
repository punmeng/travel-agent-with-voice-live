# 城市／機場地理對照與 Excel 維護

本工具回答「已維護的城市有哪些候選機場」，**不回答哪家航空實際營運、可售或有機位**。台北群組包括服務都會區的桃園及松山，不代表兩座機場行政區相同。所有預設資料均為本專案人工整理參考，未宣稱官方完整核驗。

## 共用工具及資料

`lib\city-airports.js` 是唯一的地理別名／群組 resolver。自然對話的 Place 原文正規化、機場偏好與排除、MCP handler 及 Foundry functions 共用它；不是只放進 prompt 的建議。`data\cities.json` 維護 43 個城市群組、國家碼、繁簡中文／英文別名及少量原有機場別名；機場名稱／時區仍重用 `data\network.json` 的 45 座參考機場。預設共 122 列 city-alias-airport 關係。

```json
{"query":"Taipei","countryCode":null}
```

兩個參數都必須存在，`countryCode` 可為 `null` 或兩碼大寫。嚴格 schema 拒絕其他參數。回傳：

| 欄位 | 意義 |
|---|---|
| `status` | `matched`、`ambiguous`、`not_found`；不以第一個結果猜城市 |
| `matchKind` | `city`、`airport` 或 `null`；IATA／已維護機場別名可指單座 |
| `cities` | cityId、cityName、countryCode、候選 airports |
| `airports` | 每座含 iata、name、IANA timezone、source、updatedAt |
| `scope` | 固定 `geographic-membership-only` |
| `routeEligibility` | 固定 `not-determined`；地理對照不證明任何航線或航空公司營運 |
| `provenance` | 本機維護資料；`officialNetworkVerified=false` |

別名只作 Unicode NFKC、大小寫及空白正規化後的完整比對。`Taipei`、`臺北`、`台北`及`Tokyo`、`東京`、`东京`已維護；`Taipie`不模糊改成Taipei。自然對話中的「東京成田或羽田都可以」可由已維護完整詞及明確連接／偏好語句組合；含未識別文字的「東京火星」不偷偷選東京。

同名別名可存在不同國家，工具回`ambiguous`；對話保留待解城市，在下一句國家回答後續解。不同城市不能因在同國就默選；真正未知國家／城市自然澄清。已接受的機場集合不反覆問，`都可以`綁定最近機場問題，`不要松山`縮小集合，變更失效舊報價。地理解析不消耗航班查詢額度；模型／MCP明確呼叫工具仍受既有60工具預算限制。

intent、planner、flight可呼叫`resolve_city_airports`；price不新增這項權限。一般intent理解仍`tool_choice=none`、只摘當則原文，後端直接執行相同resolver，不讓模型猜IATA。Foundry工具定義由`node scripts\export-tools.js`自同源MCP schema產出。

## Excel 範本

檔案：`data\templates\city-airport-mapping.xlsx`。Arial字體、表頭／篩選／凍結列；含完整預設地理列、空白RouteReferences表頭及繁中README，**沒有航空公司營運航線樣本或公式**。

| Sheet | 欄位（精確名稱及順序） |
|---|---|
| CityAirportMapping | city_id、city_name、alias、country_code、airport_iata、airport_name、timezone、source、updated_at |
| RouteReferences（選用） | origin_iata、destination_iata、marketing_carrier、operating_carrier、valid_from、valid_to、source、updated_at |

每列是一個city+alias+airport關係。每個別名須重複列出該城市相同完整機場集合；不以某些別名偷偷縮小城市範圍。城市id為小寫英數／連字號，國家及IATA大寫；日期全部以文字填`YYYY-MM-DD`。同城市名稱／國家不可衝突，同國家同別名不可指多城市；重複city+正規化alias+IATA、錯誤日期／IANA時區皆拒絕。

本版只接受既有inventory的機場及相同名稱、國家、時區；若要新增機場或修正地理inventory須另行維護，不能透過Excel悄悄變更生成器。每城市最多兩機場，保留2×2搜尋上限。RouteReferences只檢查航空公司代碼格式、日期有效性與區間不重疊；**它只是獨立參考，不會建立任何營運資格、排程、機位、價格或目前假設合成路線**，來源也不自動升格為已核驗官方事實。

## 檢查及套用

本機Excel維護需要Python3及`openpyxl`（`scripts\requirements-workbook.txt`）；Node runtime及已完成的JSON對照不需要Python。Excel不送往LLM、file_search或任何雲端，沒有UI上傳介面。

```powershell
# 本機範本重建並讀回比對；不呼叫雲端
node scripts\create-mapping-template.js

# 唯讀 dry run：整本驗證，沒有寫入
node scripts\import-city-airports.js .\data\templates\city-airport-mapping.xlsx

# 使用者明確決定套用完整快照後才加 --apply
node scripts\import-city-airports.js .\data\templates\city-airport-mapping.xlsx --apply
```

`--apply`把驗證完整的快照原子替換至`data\city-airport-import.json`；它只替代地理對照，不修改cities.json、network.json、合成flight/fare匯出或價格工具。未加apply不建檔；任何一列不合法，舊檔完整保留。寫入前會再次檢查目的檔未被其他程序修改；競爭或錯誤明確失敗，不輸出假成功。服務在下次受控重啟載入；先提醒使用者memory-only旅程會消失，不在匯入時自行重啟。

只接受2MB內的`.xlsx`、展開20MB內、最多1000 ZIP entries／每sheet10001列；工作表只可為上述兩表及README。禁止巨集、公式／錯誤值、外部relationships／資料連線、嵌入物件、隱藏sheet及非文字欄位；不執行Excel、公式或巨集。現有欄名不同的活頁簿先人工對照，不自動猜欄位。
