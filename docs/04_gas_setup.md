# 04. Google Apps Script セットアップ

このページは Google Apps Script（**GAS**、Googleが提供するJavaScript実行環境）を
スプレッドシートに紐付けて WebApp として公開する手順です。

v2 では GAS プロジェクトを **2 種類** に分けて使います:

| 種類 | バインドするスプレッドシート | 配置するファイル | 用途 |
| ---- | ---------------------------- | ---------------- | ---- |
| **(A) 受信用** | M5Stack / Mechatrax の **各データ用スプレッドシート** に1つずつ | `m5stack_receiver.gs` または `mechatrax_receiver.gs`（+ `amedas_fetcher.gs`） | デバイスからの POST を受けて行を追記 |
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

## B. Registry 用 GAS（admin_api + 任意で read_proxy）

Registry スプレッドシート 1 つに対して、この設定を 1 回行います。

### B-1. ファイルを配置

0-1 〜 0-2 の手順で **Registry スプレッドシート** に紐付け、以下を貼る:

- `gas/admin_api.gs`（必須）
- `gas/read_proxy.gs`（`accessMode=proxy` のソースを使うときのみ）

### B-2. スクリプトプロパティ

| キー | 値 | 用途 |
| --- | --- | --- |
| `ADMIN_ALLOWED_EMAILS` | `you@example.com,prof@example.com` | admin 画面の書き込みを許可するメール一覧（カンマ区切り） |
| `GOOGLE_OAUTH_CLIENT_ID` | `01_google_setup.md` 手順 4-2 のフロントと同じ Client ID | ID トークン検証用 |

### B-3. admin_api を WebApp デプロイ

0-4 の手順でデプロイ → URL を **GitHub Variables の `VITE_GAS_ADMIN_URL`** に登録（[`03_pages_deploy.md`](03_pages_deploy.md) 手順 1）。

### B-4. （任意）read_proxy を WebApp デプロイ

`accessMode=proxy` のデータソースを 1 つでも使う場合のみ実施。

1. 同じ Registry GAS プロジェクトでもう一度「デプロイ → 新しいデプロイ」
2. 「ウェブアプリ」を選び、**説明** に `read-proxy` のように区別が付く名前を入れる
3. デプロイ → URL を **GitHub Variables の `VITE_GAS_PROXY_URL`** に登録

> `read_proxy.gs` を実行するアカウント（あなた、または GAS オーナー）に、
> 対象データ用スプレッドシートが **Drive 上で「閲覧者」共有されている** 必要があります。
> 案件主に「`<GAS オーナーのメール>` だけに閲覧者共有してください」と依頼すれば OK。

---

## C. アラート送信用 GAS（alert_mailer）

FTP データ用スプレッドシート（`sensor_raw` / `sensor_9am` と **同じスプレッドシート**）の
`alerts` シートを監視し、新しいアラート行を検知したらメールを送信する GAS です。
**別のスプレッドシートを作る必要はありません**。

**追加の認証情報（SMTP 等）は不要**で、スプレッドシートのオーナーアカウントからメールが送信されます。

### C-1. alerts シートと alert_rules シートの準備

FTP データ用スプレッドシート（`sensor_raw` / `sensor_9am` と同じもの）に以下 2 つのシートを追加します。

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

#### `alerts` シート（検知結果の書き込み先）

A1〜H1 にヘッダを入力:

```
timestamp | detected_at | alert_type | site_id | addr | sensor_number | details | status
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
   - D2: `site-a`
   - E2: `1a`
   - F2: `1`
   - G2: `bulk_ec=32.768 (テスト)`
   - H2: `new`
2. GAS エディタで関数ドロップダウンから `processNewAlerts` を選び ▶ 実行
3. `ALERT_TO` に設定したメールアドレスに警報メールが届くことを確認
4. `alerts` シートの H2 が `sent` に変わっていることを確認
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
