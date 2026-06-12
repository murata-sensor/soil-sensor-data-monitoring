# SPEC — Soil Sensor Data Monitoring

> 本ドキュメントは本リポジトリの技術仕様。地名・個人情報・顧客情報・実 ID は一切記載しない。
> Revision: v2（マルチデータソース対応）

## 1. 目的

複数方式の土壌センサ／環境ロガーから得たデータを Google Spreadsheet に蓄積し、
GitHub Pages 上の SPA で可視化する。閲覧は Google アカウントで認証し、
**アカウントごとに参照できるスプレッドシートを個別制御**する。

対応する3系統のシステムを単一フロントエンドで扱えるようにする：

| ID | 系統 | 書込経路 | スプレッドシートのオーナー |
| --- | --- | --- | --- |
| `remote-ftp` | リモート案件（FTP 経由センサ） | GitHub Actions の Python が FTP→正規化→Sheets API で追記 | 本プロジェクト側サービスアカウント |
| `m5stack` | M5Stack ロガー | デバイスから GAS WebApp に HTTP POST | **案件ごとに別の Google アカウント**（既存運用のスプレッドシート） |
| `mechatrax` | Mechatrax Raspberry Pi ロガー | RasPi から GAS WebApp に HTTP POST、GAS が GPS→アメダス天気を付加 | **案件ごとに別の Google アカウント**（既存運用のスプレッドシート） |

`m5stack` と `mechatrax` については **既存スプレッドシート（過去データ含む）をそのまま参照可能**
にすることが要件。本リポジトリで新規に作るのはレジストリ（コントロールプレーン）と SPA／取り込みスクリプトのみ。

## 2. 非機能要件 / セキュリティ原則

- リポジトリは **Public**。よって以下は **絶対に GitHub 上に置かない**:
  - 測定データ（CSV / JSON / XLSX 等）
  - FTP サーバアドレス・認証情報
  - 圃場座標・地名・顧客名・人名・GPS 値
  - サービスアカウント秘密鍵
  - 各種 Spreadsheet ID / Drive フォルダ ID / GAS WebApp URL（個別の運用 ID）
  - 端末 SerialNumber / cellId / IMEI 等
- 上記はすべて **GitHub Actions Secrets** または **レジストリ Spreadsheet** に保存。
- 圃場の固有名詞は **`siteId`（例: `site-a`）** にマッピング。マッピングはレジストリ Spreadsheet にのみ存在。
- pre-commit / CI で `scripts/check_no_pii.py` による禁止語チェック（ローカル `.pii_blocklist.local`）。

## 3. アーキテクチャ概要

```
                  ┌── FTP (remote) ──► GitHub Actions Python ──► Sheets API ──┐
                  │                                                            │
  データソース ──┼── M5Stack ────────► GAS WebApp ───────────► Sheets API ──┤── 各案件の Spreadsheet
                  │                                                            │   （オーナーは案件主／本プロジェクト）
                  └── Mechatrax RasPi ► GAS WebApp + AMeDAS ─► Sheets API ──┘

                       ┌──────────────────────────────────────────────┐
                       │ Registry Spreadsheet（本プロジェクト所有）   │
                       │   sources / users / acl / theme / events /   │
                       │   layouts                                    │
                       └──────────────────────────────────────────────┘
                                          ▲
                                          │ Sheets API (read/write)
            ┌─────────────────────────────┴────────────────────────────┐
            │ GitHub Pages SPA  (React + Vite + TS)                    │
            │   1. Google ログイン                                     │
            │   2. レジストリで自分にアクセス権があるソース一覧を取得 │
            │   3. ユーザが選択したスプレッドシートを直接 Sheets API   │
            │      で読む（スキーマアダプタで正規化してチャート描画） │
            └──────────────────────────────────────────────────────────┘
```

## 4. データモデル

### 4.1 正規化モデル（フロント・分析・CSV 出力で使う共通スキーマ）

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `ts` | ISO8601 (JST) | 計測時刻 |
| `sourceId` | string | レジストリ上の論理 ID（例: `src-001`） |
| `siteId` | string | 圃場/プロジェクト識別子 |
| `deviceId` | string | シリアル番号や addr |
| `sensorNumber` | string? | デバイス内のセンサ番号（例: `1`, `2`, `3` = 深度別） |
| `temperature_c` | number? | 土壌温度 |
| `vwc_pct` | number? | 体積含水率 |
| `vwc_coco_pct` | number? | ココピート補正 VWC |
| `vwc_rock_pct` | number? | ロックウール補正 VWC |
| `ec_bulk_dsm` | number? | バルク EC |
| `ec_pore_dsm` | number? | 土壌溶液 EC |
| `ec_pore_coco_dsm` | number? | ココ補正 pore EC |
| `battery_v` | number? | バッテリー電圧 |
| `battery_pct` | number? | 残量% (mechatrax) |
| `error_flag` | number? | M5Stack のエラーフラグ |
| `rssi_dbm` | number? | Wi-Fi / セル RSSI |
| `air_temp_c` | number? | 外気温（mechatrax は AC 列、他は weather シート） |
| `precip_1h_mm` | number? | 1h 降水量 |
| `sunshine_1h_h` | number? | 1h 日照時間 |

欠損列は `undefined` のままにする。スキーマアダプタが各ソースの列名から正規化モデルへマップする。

### 4.2 スキーマ別の生データ列（アダプタ入力）

#### `m5stack`（列レイアウト準拠：A〜M）

```
A Date, B SerialNumber, C Date from M5Stack, D Battery(V), E Temperature(degC),
F VWC(%), G VWC Coconut Peat(%), H VWC Rock Wool(%),
I EC bulk(dS/m), J EC pore(dS/m), K EC pore Coco(dS/m),
L Error flag, M WiFi RSI(dBm)
```

- `ts = A`、`deviceId = B`。
- 1 デバイス = 1 スプレッドシート（または 1 シート）想定。`siteId` はレジストリで紐付け。

#### `mechatrax`（列レイアウト準拠：A〜AE）

```
A Date, B MCC, C MNC, D area code, E cell id,
F 座標(latitude,longitude), G loc_accuracy,
H locTemp, I locTemp_id, J locPrec, K locPrec_id, L locSun, M locSun_id,
N SerialNumber, O Date from logger,
P Battery capacity(mV), Q Battery残量(%),
R Battery_current(mA), S Battery_voltage(mV), T Battery_temperature(°C),
U addr, V Temperature(degC),
W VWC(%), X VWC_coco(%), Y VWC_rock(%),
Z EC bulk(dS/m), AA EC_pore(dS/m), AB EC_porecoco(dS/m),
AC 外気温, AD 1hの降水量, AE 1hの日照時間
```

- `ts = A`、`deviceId = N`、`siteId` はレジストリで紐付け。
- `AC/AD/AE` は GAS（書き込み側）で AMeDAS から取得済みなので、フロントでは再取得しない。
- 座標 `F`、`MCC/MNC/cellId` 等の通信識別子は **フロントには出さない**（マスキング）。
  解析用には粒度を落とした集約のみ表示。

#### `remote-ftp`（既存・現行スクリプト）

- 形式: 旧 35 列 CSV（`requirements/legacy_ftp_exe.py` 準拠）。
- スキーマアダプタは既存の `scripts/sensor_parser.py` を流用。
- 書き込み先は本プロジェクト所有のスプレッドシート。

## 5. レジストリ Spreadsheet（コントロールプレーン）

本プロジェクト所有のスプレッドシートを 1 つ用意し、サービスアカウントを編集者に追加。
SPA は **このレジストリのみ ID を環境変数で持つ**。実データのスプレッドシート ID はレジストリから動的取得。

### 5.0 アクセス制御モデル（重要）

`users` シートの `enabled` 列は **「このアカウントがダッシュボードにログインできるかどうか」だけ** を表す。
`enabled=TRUE` でも `acl` シートに 1 行も無ければ、`viewer` ロールのユーザーは **どのスプレッドシートも見られない**。

参照可能なスプレッドシートはすべて `acl` シートの (email, sourceId) 行で1件ずつ定義する。

| role | enabled | acl 行 | 結果 |
| --- | --- | --- | --- |
| `admin` | `TRUE` | 不要 | 全 `sources` の `enabled=TRUE` 行を閲覧可（admin は acl を経由しない） |
| `viewer` | `TRUE` | `(email, sourceId)` がある | その sourceId だけ閲覧可 |
| `viewer` | `TRUE` | `(email, '*')` がある | 全ソース閲覧可（ワイルドカード） |
| `viewer` | `TRUE` | 1 行も無い | **ログインはできるがソースが何も出ない** |
| 任意 | `FALSE` | 任意 | ログイン拒否 |

例（3 ソース・3 ユーザー）:

`sources`:

| sourceId | displayName | enabled |
| --- | --- | --- |
| `src-001` | M5 A 棟 | TRUE |
| `src-002` | Mechatrax B 棟 | TRUE |
| `src-003` | リモート C 圃場 | TRUE |

`users`:

| email | role | enabled |
| --- | --- | --- |
| `alice@example.com` | admin | TRUE |
| `bob@example.com` | viewer | TRUE |
| `carol@example.com` | viewer | TRUE |

`acl`:

| email | sourceId | permission |
| --- | --- | --- |
| `bob@example.com` | `src-001` | read |
| `carol@example.com` | `src-002` | read |
| `carol@example.com` | `src-003` | read |

挙動:

- alice → `src-001`, `src-002`, `src-003` の3つが見える（admin）
- bob   → `src-001` のみ
- carol → `src-002`, `src-003` の 2 つ

> **重要**: `acl` 上で参照を許可しても、実データ Spreadsheet が `accessMode=direct` の場合は
> **そのユーザーの Google アカウントに対して Drive 上で「閲覧者」共有が別途必要**。
> Drive 共有していなければ Sheets API が 403 を返す。詳しくは §5.3 / §6 を参照。

### 5.1 `sources` シート

| 列 | 例 | 説明 |
| --- | --- | --- |
| `sourceId` | `src-001` | 内部ID（英数字） |
| `displayName` | `A 圃場 M5Stack` | UI 表示名（PIIにならないよう注意） |
| `schemaType` | `m5stack` / `mechatrax` / `remote-ftp` | アダプタ選択 |
| `spreadsheetId` | `1abc...` | 実データ Spreadsheet ID |
| `sheetName` | `soil_sensor` | タブ名 |
| `headerRow` | `1` | ヘッダ行番号 |
| `siteId` | `site-a` | 圃場ID |
| `tz` | `Asia/Tokyo` | タイムゾーン |
| `accessMode` | `direct` / `proxy` | §6 参照 |
| `enabled` | `TRUE` | 無効化フラグ |
| `notes` | | 任意メモ |

### 5.2 `users` シート

**ログイン可否と役割のみ** を定義する。どのスプレッドシートが見えるかは制御しない（それは §5.3 `acl`）。

| 列 | 例 | 説明 |
| --- | --- | --- |
| `email` | `prof@example.com` | Google アカウント |
| `role` | `admin` / `viewer` | `admin` は全 `sources` を見られる + `/admin` を開ける |
| `enabled` | `TRUE` | `FALSE` でログイン拒否 |

### 5.3 `acl` シート（user × source の参照許可表）

`viewer` ロールのユーザーには **この表に行を入れて初めて** スプレッドシートが見えるようになる。

| 列 | 例 | 説明 |
| --- | --- | --- |
| `email` | `prof@example.com` | |
| `sourceId` | `src-001` | `*` で全ソース許可（admin 用） |
| `permission` | `read` | 将来 `write` 拡張用 |

- SPA はログイン後、レジストリの `sources` と `acl` を結合して、ユーザに見せるソース選択 UI を構築する。
- レジストリ ACL に載っていても、**実データの Spreadsheet 自体がそのユーザに Drive 上で共有されていない場合は Sheets API が 403 を返す**。
  運用ルールとして以下2方式を選択可：
  - **方式 A（推奨／`accessMode=direct`）**: 実データのスプレッドシートを当該 Google アカウントに「閲覧者」として共有しておく。レジストリ ACL と Drive 共有を一致させる運用。
  - **方式 B（`accessMode=proxy`）**: 実データはサービスアカウントのみが読み、SPA は **GAS Read Proxy WebApp** 経由で読む（admin による ID トークン検証込み）。Drive 共有を分けたくない案件で使用。

`schemaType` ごと、案件ごとに方式を選択可能。

### 5.4 `theme` / `events` / `layouts` シート

- `theme`: `themeId, json`（フロントの配色・レイアウト・閾値）。
- `events`: `date, sourceId, label, color`（縦線注釈）。
- `layouts`: `sourceId, json`（ソースごとのカスタムレイアウト定義）。§5.5 参照。

### 5.5 `layouts` シート（カスタムダッシュボードレイアウト）

ソースごとに異なるダッシュボードレイアウトを定義する。未定義のソースはデフォルトレイアウトを使用。
`remote-ftp` スキーマで `layouts` 行が存在しない場合はデータから自動生成される。

| 列 | 例 | 説明 |
| --- | --- | --- |
| `sourceId` | `src-remote-a` | 対象ソースの ID |
| `config` | `{"sourceId":"src-remote-a",...}` | LayoutConfig JSON（下記参照） |

#### LayoutConfig JSON スキーマ

```json
{
  "sourceId": "src-remote-a",
  "title": "表示タイトル",
  "cols": 12,
  "rowHeight": 60,
  "bg": "#1a1a1a",
  "surface": "#2a2a2a",
  "textColor": "#ffffff",
  "panels": [ ... ]
}
```

#### パネルタイプ

| type | 用途 | 必須フィールド |
| --- | --- | --- |
| `chart` | 折れ線グラフ | `metric`, `position`, `id`, `title` |
| `gauge` | バッテリー等のゲージ | `deviceFilter`, `position`, `id`, `title` |
| `text` | 任意テキスト表示 | `content`, `position`, `id` |
| `image` | 画像（センサ配置図等） | `src`, `position`, `id` |

#### chart パネルのフィルタ・グルーピング

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `deviceFilter` | `string[]?` | 表示対象デバイス ID。省略=全デバイス |
| `sensorFilter` | `string[]?` | 表示対象センサ番号。省略=全センサ |
| `groupBy` | `"deviceId" \| "sensorNumber"` | 線の色分け基準（デフォルト: `deviceId`） |
| `groupLabels` | `Record<string, string>?` | グループ値→表示名マッピング |
| `groupColors` | `Record<string, string>?` | グループ値→線色マッピング |
| `showEvents` | `boolean?` | イベント注釈を表示するか（デフォルト: true） |
| `yMin` / `yMax` | `number?` | Y 軸固定範囲 |

#### gauge パネル

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `deviceFilter` | `string[]` | 対象デバイス（最新値を表示） |
| `metric` | `Metric?` | 表示メトリック（デフォルト: `battery_v`） |
| `ranges` | `[number, number, number, number]?` | `[min, yellowStart, greenStart, max]` ゾーン |

#### position（全パネル共通）

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `x` | number | グリッド列（0-based） |
| `y` | number | グリッド行 |
| `w` | number | 幅（グリッド列数） |
| `h` | number | 高さ（グリッド行数） |

## 6. 認証 / アクセス制御

- フロントは Google Identity Services (GIS) で OAuth 2.0 トークン取得。
  - スコープ: `https://www.googleapis.com/auth/spreadsheets.readonly`
  - 方式 B を使う場合は ID トークン（`openid email`）も取得し、GAS Proxy に Bearer 送付。
- 起動時シーケンス：
  1. ログイン → email 取得
  2. レジストリ Spreadsheet を Sheets API で読む（読めなければ未登録ユーザ扱い）
  3. `users` で `enabled=TRUE` を確認、role 取得
  4. `acl` × `sources` 結合で許可ソース一覧を組み立て
  5. ユーザがソースを選択 → `schemaType` に応じたアダプタでロード
- `role=admin` のみが `/admin`（後述）にアクセス可。

## 7. フロントエンド

- React 18 + Vite + TypeScript + TailwindCSS + Chart.js（`react-chartjs-2`）。
- 主要ルート：
  - `/login` — Google サインインゲート。
  - `/` — Dashboard。上部にデータソース選択ドロップダウン（自分がアクセス可能なものだけ）。
  - `/admin` — Sources / Users / ACL / Theme / Events / Layouts 編集（GAS Admin API 経由で書込）。
- ダッシュボード内のチャート構成は `schemaType` ごとに既定レイアウトを持ち、`theme` でユーザカスタム可。
  - 共通: VWC ライン / Bulk EC ライン / 気温・降水複合 / バッテリー監視カード。
  - `m5stack` 追加: Error flag / WiFi RSSI 系列。
  - `mechatrax` 追加: 外気温・1h 降水・1h 日照（AMeDAS 由来）／バッテリー残量%。
  - `remote-ftp` 追加: 朝9時抽出タブ + 塩処理開始日縦線。
- CSV ダウンロード：現在表示中のソースから正規化モデルとして書き出す。

## 8. スキーマアダプタ実装方針

- TypeScript 側 `web/src/adapters/{m5stack,mechatrax,remoteFtp}.ts` を新設。
  - 入力: Sheets API `values.get` の `string[][]`（ヘッダ＋データ行）
  - 出力: `NormalizedRow[]`（§4.1）
- 各アダプタは「**ヘッダ名 → 正規化キー**」の対応表で実装し、列順変動に頑健にする。
- 型変換ルール：
  - 数値カラムは `Number(cell)`、空文字／NaN は `undefined`。
  - 日付カラムはタイムゾーン `tz`（`sources.tz`）でパース。
- Python 側にも同じ正規化を行うアダプタを `scripts/adapters/` に置く（CI テスト共通化）。
- 案件によりヘッダ表記が揺れる場合に備え、レジストリ `sources` 行に `columnMap`（JSON 文字列）列を追加して
  個別オーバライドできるようにする（v2.1 で実装）。

## 9. 取り込み（書き込み）系

| 系統 | 書き手 | 場所 |
| --- | --- | --- |
| `remote-ftp` | Python on GitHub Actions | `scripts/ingest_ftp.py`（既存） |
| `m5stack` | GAS WebApp | `gas/m5stack_receiver.gs` |
| `mechatrax` | GAS WebApp + AMeDAS フェッチャ | `gas/mechatrax_receiver.gs`（新規）, `gas/amedas_fetcher.gs`（新規） |

- GAS 側はいずれも `Script Properties` の `INGEST_TOKEN` でデバイス認証。
- 書込スプレッドシートの ID は GAS の `Script Properties` に保持（リポジトリには出さない）。
- M5Stack / Mechatrax の **既存運用スプレッドシートに後付けで追記する**ことも可能（GAS を当該スプレッドシートに紐付けて公開）。

## 10. GitHub Actions

| Workflow | トリガ | 内容 |
| --- | --- | --- |
| `ingest-ftp.yml` | `schedule: cron 0 19 * * *`（UTC = 04:00 JST）& `workflow_dispatch` | `remote-ftp` 系統のみ実行 |
| `deploy-pages.yml` | `push: main` の `web/**` | `web/` をビルドして Pages にデプロイ |
| `ci.yml` | PR | Python pytest + frontend `npm test` + lint + PII 語句チェック |

## 11. Secrets / Variables

### GitHub Secrets

| Key | 用途 |
| --- | --- |
| `FTP_HOST` / `FTP_USER` / `FTP_PASS` / `FTP_DIR` | `remote-ftp` 系統の FTP 接続 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | レジストリ書込 / `remote-ftp` データ書込 |
| `REGISTRY_SPREADSHEET_ID` | レジストリ Spreadsheet ID |
| `FTP_SPREADSHEET_ID` | `remote-ftp` 実データ Spreadsheet ID |
| `DRIVE_BACKUP_FOLDER_ID` | （任意）バックアップ先フォルダ |
| `INGEST_FILTER_START` | データ取り込み開始日 |

### Vite ビルド時 Variables（公開許容）

| Variable | 用途 |
| --- | --- |
| `VITE_GOOGLE_CLIENT_ID` | GIS クライアント ID |
| `VITE_REGISTRY_SPREADSHEET_ID` | レジストリ ID（公開許容。ACL はレジストリ内で行う） |
| `VITE_GAS_ADMIN_URL` | 管理書込 GAS WebApp URL（任意） |
| `VITE_GAS_PROXY_URL` | 方式 B 用 Read Proxy WebApp URL（任意） |

> 実データの Spreadsheet ID はビルド時には埋め込まない。レジストリから動的に取得する。

## 12. 個人情報チェック

- `scripts/check_no_pii.py` がリポジトリ全文を走査し、`.pii_blocklist.local`（コミット対象外）に列挙した
  地名・人名・顧客名・SerialNumber プレフィックス・既知の座標断片を検出。
- 新規データソースを追加する際は、座標・SerialNumber・案件名などをブロックリストに追加すること。
- CI で実行し、ヒットしたら fail。

## 13. 既存運用スプレッドシートの取り込み手順（運用ノート）

1. 案件主に依頼して、対象スプレッドシートを **サービスアカウントまたは閲覧ユーザの Google アカウント** に共有してもらう。
2. レジストリ `sources` に行を追加（`schemaType` を選び、`spreadsheetId` / `sheetName` / `headerRow` / `accessMode` を入力）。
3. レジストリ `acl` に閲覧者を追加。
4. SPA を再読み込みして `sources` ドロップダウンに表示されることを確認。
5. ヘッダ名が想定と異なる場合は `sources.columnMap` で上書きする（v2.1）。

## 14. 旧仕様からの差分（v1 → v2）

- 旧 `sensor_raw` / `sensor_9am` の単一スキーマ前提を廃止。代わりに **データソースごとに別スプレッドシート**を許容。
- `config` シート（サイト定義）と `users` シートを **レジストリ Spreadsheet** に統合し、`sources` / `acl` を追加。
- フロントは単一 Spreadsheet 直読みから「**レジストリ → 動的に対象 Spreadsheet を選択**」モデルへ。
- M5Stack / Mechatrax の既存運用スプレッドシートをそのまま参照する読み取り経路を追加（方式 A / B）。
- 気象データは案件により Open-Meteo（旧仕様）または AMeDAS（mechatrax 系統で GAS が付与済み）を使い分け。
