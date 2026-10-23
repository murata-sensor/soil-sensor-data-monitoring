# 04. Google Apps Script セットアップ

このページは Google Apps Script（**GAS**、Googleが提供するJavaScript実行環境）を
スプレッドシートに紐付けて WebApp として公開する手順です。

v2 では GAS プロジェクトを **2 種類** に分けて使います:

| 種類 | バインドするスプレッドシート | 配置するファイル | 用途 |
| ---- | ---------------------------- | ---------------- | ---- |
| **(A) 受信用** | M5Stack / Mechatrax / PC の **各データ用スプレッドシート** に1つずつ | `m5stack_receiver.gs` / `mechatrax_receiver.gs`（+ `amedas_fetcher.gs`）/ `pc_serial_receiver.gs` | デバイスからの POST を受けて行を追記 |
| **(B) Registry 用** | 01 で作った **Registry スプレッドシート** に 1 つ | `admin_api.gs`、（`accessMode=proxy` を使う場合のみ）`read_proxy.gs` | 管理画面の書き込み / proxy 読み取り |
| **(C) アラート送信用** | **FTP データ用スプレッドシート** に 1 つ | `alert_mailer.gs` | `alerts` シートを監視してメール送信 |

> 旧 v1 にあった `weather_fetcher.gs`（Open-Meteo）はリポジトリに残っていますが、
> 新しい `amedas_fetcher.gs` の方を mechatrax 用に使います。

---

## GAS エディタの基本操作（共通）

各セクションで「Apps Script エディタを開いて〜」と書いてあるとき、以下の操作を指します。

### 0-1. エディタを開く

1. 対象のスプレッドシートをブラウザで開く
2. 上部メニュー「**拡張機能**」をクリック
3. ドロップダウンから「**Apps Script**」を選ぶ
4. 新しいタブで GAS エディタが開く

### 0-2. 既定の `Code.gs` を削除して、リポジトリのファイルを貼る

1. GAS エディタ左サイドバーの「**ファイル**」セクションに `Code.gs` がある
2. ファイル名右の「**︙**」（三点メニュー）→ 「**削除**」 → 「OK」
3. 「ファイル」セクションの **「+」** → 「**スクリプト**」 を選び、リポジトリ側のファイル名と同じ名前を入力（例: `m5stack_receiver`、`.gs` は自動付与）
4. リポジトリの `gas/m5stack_receiver.gs` を VS Code 等で開いて **全文コピー**
5. GAS エディタの空のスクリプトに **全文貼り付け**
6. 上部の **💾 保存** アイコン（または `Ctrl+S`）で保存
7. 複数ファイルを貼るときは 3-6 を繰り返す

### 0-3. スクリプトプロパティを設定

1. GAS エディタ左サイドバーの **歯車アイコン「プロジェクトの設定」** をクリック
2. 画面下部 **「スクリプト プロパティ」** セクション → 「**スクリプト プロパティを追加**」
3. プロパティ名と値を入力 → 「**スクリプト プロパティを保存**」

### 0-4. WebApp としてデプロイする

1. GAS エディタ画面右上の青いボタン **「デプロイ」** → ドロップダウンで「**新しいデプロイ**」を選ぶ
2. 左側の歯車「**種類の選択**」 → 「**ウェブアプリ**」 を選ぶ
3. 右側のフォーム:
   - **説明**: 任意（例: `v1`）
   - **次のユーザーとして実行**: 「**自分**（あなたのメール）」
   - **アクセスできるユーザー**:
     - 受信用（A / A'）と read_proxy → 「**全員**」
     - admin_api → 「**全員**」（中で ID トークン検証するため OK）
4. 「**デプロイ**」を押す
5. 初回はアクセス権限の確認ダイアログが出る:
   - 「**アクセスを承認**」を押す
   - 自分の Google アカウントを選択
   - 「Google で確認されていません」と出たら「**詳細**」→ 「**安全ではないページに移動**」を押す
   - 「許可」を押す
6. デプロイ完了画面で「**ウェブアプリ URL**」（`https://script.google.com/macros/s/.../exec` の形式）が表示される → **コピーして控える**

### 0-5. デプロイ後にコードを修正したときの再デプロイ

1. 右上「デプロイ」 → 「**デプロイを管理**」
2. 既存デプロイの右の **鉛筆アイコン「編集」**
3. 「バージョン」プルダウンを「**新バージョン**」に変える
4. 「デプロイ」 → **URL は変わらないまま** 反映される

> **新しいデプロイにすると URL が変わる** ので、運用後は「デプロイを管理 → 編集 → 新バージョン」の流れを必ず使うこと。

---

## A. 受信用 GAS（M5Stack）

M5Stack のデータ用スプレッドシート 1 つに対して、この設定を 1 回行います。

### A-1. ファイルを配置

0-1 〜 0-2 の手順で **M5Stack のデータ用スプレッドシート** に紐付けて、`gas/m5stack_receiver.gs` を貼る。

### A-2. スクリプトプロパティ

0-3 の手順で以下を設定:

| キー | 値 | 必須 |
| --- | --- | --- |
| `INGEST_TOKEN` | M5Stack と共有する任意のランダム文字列（例: `9a7b3c2d1e4f...`） | 必須 |
| `M5_TARGET_SHEET` | 書き込み先シート名。デフォルト `soil_sensor` | 任意 |

### A-3. WebApp デプロイ

0-4 の手順でデプロイ → ウェブアプリ URL を控える。これを **M5Stack 側の POST 先 URL** にする。

### A-4. ヘッダを 1 回だけ整える

最初の POST 前に、シートのヘッダ行（A〜M）を作っておくと表示が綺麗。
GAS エディタの関数ドロップダウン（上部・▶ 実行ボタンの左）から `addM5StackHeader` を選んで ▶ を押す。

### A-5. M5Stack 側サンプル POST

```cpp
HTTPClient http;
http.begin("https://script.google.com/macros/s/XXXXX/exec");
http.addHeader("Content-Type", "application/json");
String body = "{\"token\":\"<INGEST_TOKEN>\","
              "\"serialNumber\":\"24026902\","
              "\"battery_v\":4.83,"
              "\"temperature_c\":21.31,"
              "\"vwc_pct\":0.0,"
              "\"vwc_coco_pct\":0.1,"
              "\"vwc_rock_pct\":0.1,"
              "\"ec_bulk_dsm\":0.008,"
              "\"ec_pore_dsm\":0,"
              "\"ec_pore_coco_dsm\":65.5,"
              "\"error_flag\":0,"
              "\"rssi_dbm\":-79}";
int code = http.POST(body);
```

書き込まれる列（A〜M）: `Date / SerialNumber / Date from M5Stack / Battery(V) / Temperature(degC) / VWC(%) / VWC Coconut Peat(%) / VWC Rock Wool(%) / EC bulk(dS/m) / EC pore(dS/m) / EC pore Coco(dS/m) / Error flag / WiFi RSI(dBm)`

---

## A'. 受信用 GAS（Mechatrax Raspberry-Pi）

Mechatrax データ用スプレッドシート 1 つに対して、この設定を 1 回行います。

### A'-1. ファイルを配置

0-1 〜 0-2 の手順で **Mechatrax のデータ用スプレッドシート** に紐付け、以下 2 ファイルを貼る:

- `gas/mechatrax_receiver.gs`
- `gas/amedas_fetcher.gs`

### A'-2. スクリプトプロパティ

| キー | 値 | 必須 |
| --- | --- | --- |
| `INGEST_TOKEN` | RasPi と共有するランダム文字列 | 必須 |
| `MX_TARGET_SHEET` | 書き込み先シート名。デフォルト `soil_sensor` | 任意 |

### A'-3. WebApp デプロイ

0-4 の手順でデプロイ → URL を控え、RasPi の POST 先に設定。

> POST 本文に `latitude` / `longitude` が含まれていれば AMeDAS から最寄り観測点の外気温・降水・日照を自動付与（AC/AD/AE 列）。
> 取得失敗時はそれらの列だけ空欄で書き込みは継続する。

書き込まれる列（A〜AE）は SPEC §4.2 mechatrax を参照。

---

## A''. 受信用 GAS（PC シリアルロガー / pc-serial）

PC に直接つないだ土壌センサ（SLT5005〜SLT5009）の測定値を受け取ります。
送信側は [soil-sensor-samples-python](https://github.com/murata-sensor/soil-sensor-samples-python) の
`examples/continuous_log.py --upload-url ...` です。

### A''-1. ファイルを配置

0-1 〜 0-2 の手順で **PC ロガー用のデータスプレッドシート** に紐付けて、`gas/pc_serial_receiver.gs` を貼る。

### A''-2. スクリプトプロパティ

| キー | 値 | 必須 |
| --- | --- | --- |
| `INGEST_TOKEN` | PC 側と共有する任意のランダム文字列 | 必須 |
| `PC_SERIAL_TARGET_SHEET` | 書き込み先シート名。デフォルト `soil_sensor` | 任意 |

### A''-3. WebApp デプロイ

0-4 の手順でデプロイ → ウェブアプリ URL を控える。これを PC 側で指定する。

```powershell
$env:SOIL_UPLOAD_TOKEN = "<INGEST_TOKEN>"
python examples/continuous_log.py --product SLT5009 --port COM3 --address 1,2 `
    --interval 300 --out data.csv `
    --upload-url https://script.google.com/macros/s/XXXXX/exec
```

ヘッダ行（A〜J）は初回 POST 時に自動作成されます。

### A''-4. POST フォーマット

1 台分：

```json
{
  "token": "<INGEST_TOKEN>",
  "serialNumber": "24107928",
  "ts": "2026-07-31T14:30:00+09:00",
  "battery_v": 3.311,
  "temperature_c": 21.5,
  "vwc_pct": 45.2,
  "vwc_coco_pct": 44.1,
  "vwc_rock_pct": 43.8,
  "ec_bulk_dsm": 0.51,
  "ec_pore_dsm": 1.82,
  "ec_pore_coco_dsm": 1.75
}
```

同じバス上の複数台をまとめて送る場合（`continuous_log.py` はこちらを使います）：

```json
{ "token": "<INGEST_TOKEN>", "rows": [ { "serialNumber": "...", "...": 0 } ] }
```

センサの区別は `serialNumber` で行うため、1 本のバスの複数センサを 1 シートに
まとめられます（ダッシュボードでは自動的に別系列になります）。

書き込まれる列（A〜J）: `Date / SerialNumber / Battery(V) / Temperature(degC) / VWC(%) / VWC Coconut Peat(%) / VWC Rock Wool(%) / EC bulk(dS/m) / EC pore(dS/m) / EC pore Coco(dS/m)`

> **送信間隔の目安**: 1 POST ごとにフィルタ再作成が入るため 1〜2 秒かかります。
> GAS の無料枠（スクリプト実行時間 90 分/日）に収めるため、`--interval` は
> **5 分以上** を推奨します。

---

## B. Registry 用 GAS（admin_api と read_proxy は別プロジェクト）

両ファイルはそれぞれ `doPost` を定義するため、**同じ GAS プロジェクトに置かないでください**。
同じコードに異なるデプロイ名を付けても API は分離されません。

### B-1. ファイルを配置

1. `script.google.com` で管理 API 用と閲覧 API 用のスタンドアロンプロジェクトを別々に作る。
2. 管理 API 用には `gas/admin_api.gs` だけを配置する。
3. 閲覧 API 用には `gas/read_proxy.gs` だけを配置する。
4. それぞれに、次の Script Properties を登録する。

既存のスプレッドシートにバインドされた単独 API は、`REGISTRY_SPREADSHEET_ID` を省略して継続利用できます。

#### 既存プロジェクトに両方の API が入っている場合

既存プロジェクトを閲覧 Proxy 用として使い、管理 API 用のプロジェクトを1つ追加する方法で分離できます。
同じ Registry を使うため、分離のために新しいスプレッドシートを作る必要はありません。

まず既存コードと公開版番号を控え、新しい管理 API 用プロジェクトにローカルの更新済み `gas/admin_api.gs` だけを配置します。
次節の3項目を設定して WebApp を配備し、`/exec` URL を控えます。この段階では既存の公開版・設定・接続先を変更しません。

その後、設定編集を止めて切り替えます。既存プロジェクトの API を更新済み `gas/read_proxy.gs` だけに整理し、
必要な Script Properties を確認して公開版を更新します。トリガーや別用途の処理が入っている場合は、削除・保存前に影響を確認してください。
GitHub Variables の管理 URL を新しい管理 API の URL にし、閲覧 URL も対応する Proxy の URL と照合して、Pages を更新します。
旧管理画面と新管理 API では保存方法が異なるため、GAS と画面の切り替え中は管理操作を再開しないでください。

### B-2. スクリプトプロパティ

| キー | 値 | 用途 |
| --- | --- | --- |
| `REGISTRY_SPREADSHEET_ID` | Registry スプレッドシートの ID | スタンドアロンの両 API で必須。実際の ID は公開リポジトリに保存しない |
| `ADMIN_ALLOWED_EMAILS` | `you@example.com,prof@example.com` | 管理 API だけに登録。対象者は `users` でも `role=admin`・`enabled=TRUE` が必要 |
| `GOOGLE_OAUTH_CLIENT_ID` | `01_google_setup.md` 手順 4-2 のフロントと同じ Client ID | 両 API で必須。未設定・異なる audience・期限切れ・未確認メールは拒否 |

### B-3. admin_api を WebApp デプロイ

0-4 の手順でデプロイ → URL を **GitHub Variables の `VITE_GAS_ADMIN_URL`** に登録（[`03_pages_deploy.md`](03_pages_deploy.md) 手順 1）。

### B-4. read_proxy を WebApp デプロイ（推奨）

一般閲覧者への設定・位置情報の過剰公開を防ぐため、閲覧 Proxy を設定してください。
Mechatrax のデータ取得には Proxy が必須です。

1. **閲覧 API 専用プロジェクト**で「デプロイ → 新しいデプロイ」
2. 「ウェブアプリ」を選び、実行を「自分」、アクセスを「全員」にする
3. デプロイ → URL を **GitHub Variables の `VITE_GAS_PROXY_URL`** に登録

> `read_proxy.gs` を実行するアカウント（あなた、または GAS オーナー）に、
> 対象データ用スプレッドシートが **Drive 上で「閲覧者」共有されている** 必要があります。
> 案件主に「`<GAS オーナーのメール>` だけに閲覧者共有してください」と依頼すれば OK。

更新時は「デプロイを管理 → 編集 → 新しいバージョン」で反映してください。
URL を変更した場合は GitHub Variables の変更と Pages の再ビルドも必要です。
古い脆弱な API デプロイはアーカイブしてください。保存しただけでは既存 `/exec` に反映されません。

Proxy は表示用列だけを返し、通常タブと `events` のみを許可します。
FTP では `sensor_raw`・`sensor_9am` も許可します。追加・年度別タブは `sources` に
任意列 `allowedSheetNames` を追加して、JSON 配列（例: `["sensor_2025"]`）で明示してください。
他ソースの主タブとして登録されたタブには、そのソースの ACL も適用されます。

**既存の Drive 共有はコード更新だけでは取り消せません。** Registry と実データの直接共有・
リンク共有・グループ共有を見直し、一般閲覧者が Google Sheets 側から生データを取得できない状態にしてください。
管理者と各 GAS 実行アカウントに必要な共有は維持します。

---

## C. アラート送信用 GAS（alert_mailer）

FTP データ用スプレッドシート（`sensor_raw` / `sensor_9am` と **同じスプレッドシート**）の
`alerts` シートを監視し、新しいアラート行を検知したらメールを送信する GAS です。
**別のスプレッドシートを作る必要はありません**。

**追加の認証情報（SMTP 等）は不要**で、スプレッドシートのオーナーアカウントからメールが送信されます。

### C-1. alerts・alert_rules・monitored_sensors シートの準備

FTP データ用スプレッドシート（`sensor_raw` / `sensor_9am` と同じもの）に以下 3 つのシートを追加します。

#### `alert_rules` シート（アラート条件の定義）

A1〜F1 にヘッダ、2 行目以降に条件を入力:

| enabled | field | operator | value | alert_type | message |
|---------|-------|----------|-------|------------|---------|
| TRUE | bulk_ec | == | 32.768 | sensor_fault | 接触不良・故障の疑い |
| TRUE | vwc | == | 3276.8 | sensor_fault | 接触不良・故障の疑い |
| TRUE | battery2 | < | 2.5 | low_battery | 電池残量低下 |

**後から条件を追加・変更する場合**はこのシートを編集するだけで OK（コード変更不要）:
- 行を追加: 新しい検知条件を追加
- `enabled` を `FALSE` に: その条件を一時的に無効化
- `value` を変更: 閾値を調整（例: battery2 の閾値を 2.3 に下げる等）
- `field` に使えるカラム名: `bulk_ec`, `vwc`, `battery1`, `battery2`, `soil_temp` 等（published データの列名）
- `operator` に使える値: `==`, `!=`, `<`, `<=`, `>`, `>=`

> このシートが無い場合や空の場合は、上記と同等のデフォルト条件が自動適用されます。

#### `monitored_sensors` シート（データ受信停止の監視対象）

A1〜E1 にヘッダ、2 行目以降に監視対象を入力:

| enabled | addr | number | max_silence_hours | message |
|---------|------|--------|-------------------|---------|
| TRUE | （sensor_raw の addr） | 1 | 3 | データ受信停止・電池切れの疑い |

- `addr` / `number`: `sensor_raw` の B 列 / C 列と同じ値
- `max_silence_hours`: 日次FTPファイルの収録期間終端（09:00 JST）までに、同じトランスミッタから受信がなくてもよい時間。途中停止を3時間で検知する場合は `3`
- `enabled`: 撤去・保守中のセンサーは `FALSE` にして誤警報を防止
- 同じ停止状態では一度だけ通知され、データ受信が復旧した後の再停止時には再通知される

> 判定基準はActionsの実行時刻や他のトランスミッタの受信時刻ではありません。たとえば `fac` の最終受信が05:30なら、日次FTPの収録期間終端09:00まで同じ `fac` から3.5時間受信がないため、その日のFTP取り込み時に通知します。最終受信が08:48なら12分なので通知しません。

このシートが無い場合や有効な行がない場合、データ受信停止の監視は行いません。

#### `alerts` シート（検知結果の書き込み先）

A1〜H1 にヘッダを入力:

```
timestamp | detected_at | alert_type | addr | sensor_number | details | status
```

データ行は Python が自動追加するので空のままでよい。

### C-2. ファイルを配置

0-1 〜 0-2 の手順で **FTP データ用スプレッドシート** に紐付けて、`gas/alert_mailer.gs` を貼る。

### C-3. スクリプトプロパティ

0-3 の手順で以下を設定:

| キー | 値 | 必須 |
| --- | --- | --- |
| `ALERT_TO` | アラートメールの送信先（カンマ区切りで複数指定可）。例: `admin@example.com,prof@example.com` | 必須 |

### C-4. 時間ベースのトリガーを設定

WebApp デプロイは **不要**。代わりに **時間トリガー** を設定します:

1. GAS エディタ左サイドバーの **時計アイコン「トリガー」** をクリック
2. 画面右下の「**トリガーを追加**」ボタンを押す
3. 以下を設定:
   - **実行する関数を選択**: `processNewAlerts`
   - **実行するデプロイを選択**: `Head`
   - **イベントのソースを選択**: `時間主導型`
   - **時間ベースのトリガーのタイプを選択**: `分ベースのタイマー`
   - **時間の間隔を選択**: `5分おき`（または希望の頻度）
4. 「保存」を押す
5. 初回は権限承認ダイアログが出る → 0-4 手順 5 と同様に承認する

### C-5. 動作確認

テスト方法:

1. `alerts` シートに手動で 1 行追加:
   - A2: `2026-06-15 09:00:00+09:00`
   - B2: `2026-06-15 09:01:00+09:00`
   - C2: `sensor_fault`
   - D2: `1a`
   - E2: `1`
   - F2: `bulk_ec=32.768 (テスト)`
   - G2: `new`
2. GAS エディタで関数ドロップダウンから `processNewAlerts` を選び ▶ 実行
3. `ALERT_TO` に設定したメールアドレスに警報メールが届くことを確認
4. `alerts` シートの G2 が `sent` に変わっていることを確認
5. テスト行を削除

> **注意**: GAS の `MailApp.sendEmail()` は個人アカウントで 1 日 100 通、Workspace で 1,500 通が上限。
> 通常のセンサ監視では問題にならないが、大量のセンサが同時に故障した場合は注意。

---

## クォータ・制限事項

- GAS UrlFetchApp: 20,000 calls/day（個人アカウント）
- スクリプト実行時間: 1 回 6 分
- 受信処理 / AMeDAS 解決は数秒で完了するので通常は問題なし
- AMeDAS テーブルは CacheService に 6 時間キャッシュしているので毎回フェッチしない

---

## トラブルシューティング

### 「承認が必要です」とエラーになる

→ 0-4 手順 5 の権限承認をやっていない。GAS エディタで任意の関数を一度 ▶ 実行して承認ダイアログを通す。

### `Unauthorized` で 401 が返る（受信用）

→ POST 本文の `token` がスクリプトプロパティの `INGEST_TOKEN` と一致していない。

### admin_api の書き込みが `403` になる

→ ログイン中のメールが `ADMIN_ALLOWED_EMAILS` に入っていない、または `users.role` が `admin` でない。

### proxy 経由で `403`

→ GAS オーナーのアカウントに、対象スプレッドシートが Drive 共有されていない。

### URL を控え忘れた

→ 「デプロイ → デプロイを管理」で既存デプロイを開けば URL を確認できる。
