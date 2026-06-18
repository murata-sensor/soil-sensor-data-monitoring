# 05. 管理者ガイド

Registry スプレッドシートの 5 つのシート（`sources` / `users` / `acl` / `theme` / `layouts`）で
アクセス制御と表示を管理します。イベント注釈は各データソースのスプレッドシートに `events` シートとして配置します。
ダッシュボードにログインして `/admin` を開けば画面から編集できますが、Registry スプレッドシートを直接編集しても OK です。

---

## 0. アクセス制御の整理（よく勘違いされるところ）

3 つの表が **3 つの異なる役割** を持っています:

| シート | 役割 |
| --- | --- |
| `users` | 「**このメールアドレスはログインできる/できない**」と「**ロール (admin / viewer)**」だけを決める |
| `sources` | 「**どんなデータ源がシステムに存在するか**」をカタログする |
| `acl` | 「**どの user がどの source を見られるか**」を 1 件ずつ許可する |

**間違いやすい点**: `users.enabled=TRUE` にしても、それは「ログインだけは通る」という意味で、
viewer ロールのユーザーは **`acl` に行を入れない限り 1 つもデータが見えません**（画面のソース選択ドロップダウンが空になる）。

`admin` ロールのユーザーだけは acl をスキップして全 `enabled` ソースを見られます。

---

## 1. シートの書き方リファレンス

### 1-1. `users` シート

| 列 | 例 | 意味 |
| --- | --- | --- |
| `email` | `you@example.com` | Google アカウントのメール（小文字推奨） |
| `role` | `admin` または `viewer` | `admin` は全データ + `/admin` 画面アクセス。`viewer` は acl 許可分のみ |
| `enabled` | `TRUE` / `FALSE` | `FALSE` でログイン自体を拒否 |

### 1-2. `sources` シート

| 列 | 例 | 意味 |
| --- | --- | --- |
| `sourceId` | `src-m5-01` | 内部 ID。英数字+ハイフン、後から変えにくい |
| `displayName` | `M5 A棟` | ドロップダウンに出る表示名 |
| `schemaType` | `m5stack` / `mechatrax` / `remote-ftp` | データ形式 |
| `spreadsheetId` | `1abc...xyz` | 実データのスプレッドシート ID |
| `sheetName` | `soil_sensor` | 実データのタブ名 |
| `headerRow` | `1` | ヘッダ行（通常 1） |
| `tz` | `Asia/Tokyo` | タイムゾーン |
| `accessMode` | `direct` / `proxy` | 後述 |
| `enabled` | `TRUE` | `FALSE` で一覧から消える |
| `notes` | （任意） | メモ |

**`accessMode` の選び方**:

- `direct` （推奨）: 閲覧者ごとの Google アカウントから直接 Sheets API を呼ぶ。
  そのスプレッドシートを **各閲覧者の Google アカウントに「閲覧者」共有** する必要がある（Drive 共有）。
- `proxy`: GAS WebApp 経由で読む。Drive 共有は **GAS のオーナー（あなた）1 アカウント** だけで済む。
  代わりに [`04_gas_setup.md`](04_gas_setup.md) の `read_proxy` をデプロイし、`VITE_GAS_PROXY_URL` を設定する必要がある。

### 1-3. `acl` シート

| 列 | 例 | 意味 |
| --- | --- | --- |
| `email` | `prof@example.com` | viewer のメール（admin はここに書かなくてよい） |
| `sourceId` | `src-m5-01` または `*` | 許可する sourceId、または `*` で全許可 |
| `permission` | `read` | 現状 `read` のみ |

---

## 2. ワークフロー例（具体的にこう操作する）

### 例A: 新しい viewer ユーザー（教授）に M5Stack 1 個だけ見せたい

前提: 既に `sources` に `src-m5-01` が登録されている。教授のメールは `prof@example.com`。

1. Registry スプレッドシートを開く
2. `users` タブで末尾に 1 行追加:
   - `email = prof@example.com` / `role = viewer` / `enabled = TRUE`
3. `acl` タブで末尾に 1 行追加:
   - `email = prof@example.com` / `sourceId = src-m5-01` / `permission = read`
4. **`src-m5-01` の `accessMode` が `direct` の場合のみ** 追加で:
   - 実データのスプレッドシート（`src-m5-01` の `spreadsheetId`）を開く
   - 右上「**共有**」→ `prof@example.com` を「**閲覧者**」で追加 → 送信
5. 教授がダッシュボードにログイン → ドロップダウンに `M5 A棟` が出ることを確認

### 例B: 学生数名にすべてのデータを見せたい

1. `users` に学生のメールを `viewer` で複数行追加
2. `acl` で 1 人ずつ `sourceId = *` の行を追加（ワイルドカードで全ソース許可）
3. 各ソースが `direct` なら、それぞれのスプレッドシートを学生メール全員に「閲覧者」共有

### 例C: 一時的にデータソースを非表示にしたい

1. `sources` の該当行の `enabled` を `FALSE` に変える
2. 即座に全ユーザーの一覧から消える（admin にも消える）
3. 戻すときは `TRUE` に戻す

### 例D: viewer の権限を剥奪したい

選択肢A: `acl` から該当行を削除（特定ソースだけ）
選択肢B: `users` の `enabled` を `FALSE`（ログイン自体を止める）

### 例E: 既存運用中の M5Stack スプレッドシートを取り込む（オンボーディング）

1. ユーザーから「Spreadsheet ID」「タブ名」「列構成」を聞く
2. 列構成が SPEC §4.2 の M5Stack スキーマ（A〜M）と一致しているか確認。
   違えば [`04_gas_setup.md`](04_gas_setup.md) の `addM5StackHeader` で揃える
3. アクセス方式を決める:
   - 各ユーザー個別にスプレッドシートを共有してもよい → `accessMode=direct`
   - Drive 共有を絞りたい → `accessMode=proxy`（read_proxy デプロイ要）
4. ユーザーに依頼して共有してもらう（direct なら全閲覧者、proxy なら GAS オーナーのみ）
5. Registry の `sources` に行を追加
6. 必要な閲覧者を `acl` に追加（例A 参照）

### 例F: ソースを `direct` から `proxy` に切り替える

1. [`04_gas_setup.md`](04_gas_setup.md) で `read_proxy` がデプロイ済みであることを確認
2. `sources` 該当行の `accessMode` を `proxy` に書き換える
3. 各閲覧者の Drive 共有は外して OK（ユーザー側で「アクセス権を削除」）
4. ユーザー（案件主）に依頼して、GAS オーナーのアカウントだけに「閲覧者」共有

---

## 3. テーマ編集

`/admin` 画面下部のテーマ JSON を編集して保存。

- `chartColors` の数を増やすと自動で循環使用される
- `panels[*]` の `x, y, w, h` で 12 列グリッド上のレイアウトを変更
- `yMin / yMax` で Y 軸スケール固定、`showPoints` で点表示の ON/OFF
- メトリクスキーは正規化スキーマ名（`temperature_c`, `vwc_pct`, `ec_bulk_dsm`, `battery_v` など）

スキーマごとの拡張パネル（M5Stack の RSSI/Error、Mechatrax の外気温・降水・日照・電池残量）は
コード側 (`SCHEMA_EXTRA_PANELS`) で自動付与されるので、`theme` シートには共通パネルだけ書けば OK。

---

## 4. イベント注釈（`events` シート）

イベント注釈は **各データソースのスプレッドシート** に `events` シートとして配置します（Registry スプレッドシートではありません）。

ヘッダ: `date,label,color,deviceId,enabled`

| date | label | color | deviceId | enabled |
| --- | --- | --- | --- | --- |
| `2026-06-25` | `塩処理開始` | `#ef4444` | | `TRUE` |
| `2026-07-01T14:30+09:00` | `センサ再設置` | `#3b82f6` | `6c1` | `TRUE` |
| `2026-07-10` | `全デバイス灌水` | `#22c55e` | `*` | `TRUE` |
| `2026-08-01` | `（非表示メモ）` | | | `FALSE` |

### 列の説明

| 列 | 必須 | 説明 |
| --- | --- | --- |
| `date` | ○ | イベント日時。日付のみ（`2026-06-25`）でも日時（`2026-07-01T14:30+09:00`）でも可 |
| `label` | ○ | グラフ上に表示されるラベルテキスト |
| `color` | | 縦線の色（CSS カラー）。省略時は `#ef4444`（赤） |
| `deviceId` | | 表示対象の制御（下表参照） |
| `enabled` | | `TRUE`（デフォルト）で表示、`FALSE` で非表示。削除せずに一時的に隠したいときに便利 |

### `deviceId` の指定方法

| 値 | 動作 |
| --- | --- |
| 空欄 | 全チャートに表示（グローバルイベント） |
| `*` | 全チャートに表示（全デバイス明示指定。空欄と同じ効果） |
| デバイスID（例: `6c1`） | そのデバイスのチャートにのみ表示 |

### 補足

- そのデータソースのグラフに縦線で表示される
- 時刻付きにすればセンサ再設置などのピンポイントのイベントも正確に表示可能
- 表示中のデータの時間レンジ外にあるイベントは自動的に非表示になる（横軸が引っ張られない）
- `events` シートが無いソースでは単にイベント注釈が表示されない（エラーにはならない）
- ダッシュボードの設定モーダルからもローカルイベントを追加可能（localStorage に保存、スプレッドシートのイベントとマージ表示）

---

## 5. カスタムレイアウト（`layouts` シート）

ソースごとに独自のダッシュボードレイアウトを定義できます。
典型例: デバイスごとに列を分けて並べる、バッテリーゲージを表示する、タイトルや設置図を入れる。

### 5-1. `layouts` シートの形式

| sourceId | config |
| --- | --- |
| `src-remote-a` | （JSON 文字列。下記参照） |

- **A列**: 対象の `sourceId`（`sources` シートと一致させる）
- **B列**: LayoutConfig の JSON 文字列（1セルに全部入れる）

### 5-2. LayoutConfig のトップレベル

```json
{
  "sourceId": "src-remote-a",
  "title": "圃場名 2026",
  "cols": 14,
  "rowHeight": 60,
  "bg": "#1a1a1a",
  "surface": "#2a2a2a",
  "textColor": "#ffffff",
  "devices": ["6c1", "faa", "1c9f"],
  "deviceLabels": [
    "6c1\nSensor 1: depth 0cm\nSensor 2: depth 5cm",
    "faa\nSensor 1: depth 0cm\nSensor 2: depth 5cm",
    "1c9f\nSensor 1: depth 1cm\nSensor 2: depth 5cm"
  ],
  "panels": [ ... ]
}
```

- `devices`: デバイスアドレスの配列。パネルの `deviceRef` で **インデックス参照** する
- `deviceLabels`: デバイスのラベル配列。text パネルの `contentRef` で参照
- `devices` / `deviceLabels` を使うと、JSON 内でアドレスを何度も書かずにインデックスで参照できる

### 5-3. パネルタイプ

| type | 用途 | 主なフィールド |
| --- | --- | --- |
| `chart` | 折れ線グラフ | `metric`, `deviceRef` or `deviceFilter`, `groupBy`, `groupColors`, `showEvents` |
| `gauge` | 半円ゲージ（バッテリー等） | `deviceRef` or `deviceFilter`, `ranges` |
| `text` | 任意テキスト | `content` or `contentRef`, `fontSize`, `align` |
| `image` | 画像（設置図等） | `src`, `fit` |

**`deviceRef` vs `deviceFilter`**:
- `deviceRef: [0, 2]` → `devices[0]`, `devices[2]` のアドレスに解決される
- `deviceFilter: ["6c1", "1c9f"]` → アドレスを直接指定
- どちらか一方を使う。`deviceRef` の方がメンテナンスしやすい

**`contentRef`（text パネル）**:
- `contentRef: 0` → `deviceLabels[0]` のテキストを表示

### 5-4. chart パネルの `groupBy`

- `"deviceId"`（デフォルト）: デバイスごとに線を色分け
- `"sensorNumber"`: 同一デバイス内のセンサ番号（深度）ごとに色分け
  - FTP データの `number` 列に対応。例: `1`=0cm, `2`=5cm, `3`=10cm
  - `groupLabels`: `{"1": "0cm", "2": "5cm", "3": "10cm"}` でラベル変更可
  - `groupColors`: `{"1": "#3b82f6", "2": "#22c55e", "3": "#eab308"}` で色指定可
- `showEvents`: `true`（デフォルト）でイベント注釈縦線を表示

### 5-5. `remote-ftp` ソースの自動レイアウト

`layouts` シートに行が **無い** 場合、`remote-ftp` スキーマのソースは
データに含まれるデバイス一覧から **デバイス列レイアウトを自動生成** します（`generateDeviceColumnLayout()`）。
自動生成されるパネル構成:
- タイトル行
- デバイスごとの列: ヘッダ（ラベル）→ バッテリーゲージ → 温度 → EC → VWC → 気温（あれば）

明示的にカスタムしたい場合のみ `layouts` 行を追加してください。

### 5-6. レイアウト運用例

**ケース**: 7台のセンサがあり、デバイスごとにゲージ＋温度＋EC＋VWC を縦に並べたい

1. Registry スプレッドシートの `layouts` タブを開く（無ければ作成: A1=`sourceId`, B1=`config`）
2. A2 に `src-remote-a`
3. B2 に JSON を貼り付け（参考: `docs/layout.json` に実例あり）
4. ダッシュボードをリロード → カスタムレイアウトが適用される

> **レスポンシブ**: モバイルブラウザではパネルが 2 カラムに自動スタックされ、ドラッグ・リサイズは無効化されます。

---

## 6. CSV ダウンロード

ダッシュボードの 「ソース選択 → 期間指定 → **CSV ダウンロード**」 ボタンで正規化済み行を取得できる。
列は SPEC §4.4 の `NormalizedRow` キーすべて（`ts, device_id, temperature_c, vwc_pct, ...`）で、
未対応フィールドは空欄になる。論文用 1 ファイル化に便利。

---

## 7. PII / 取り扱い注意

`mechatrax` の生スプレッドシートには **位置情報・基地局情報・端末識別子** が含まれます。
ダッシュボードのアダプタはこれらを **意図的に読み飛ばす**（`HEADER_MAP` に登録していない）ため、
CSV ダウンロードや画面表示には出てきません。
ただし **生データ自体の Drive 共有範囲** は管理者が適切に絞ること。

---

## 8. 困ったときの早見表

| 症状 | 原因の可能性 | 対応 |
| --- | --- | --- |
| ログインできない | `users` に行が無い / `enabled=FALSE` | 行追加 or `TRUE` に |
| ログインできるが何も見えない（viewer） | `acl` に許可行が無い | 例A の手順 3 |
| `/admin` が開けない | `users.role` が `viewer` | `admin` に変更 |
| ドロップダウンに出ない（admin なのに） | `sources.enabled = FALSE` | `TRUE` に |
| 選択するとエラー | `direct` のソースを Drive 共有していない | 例A 手順 4、または `proxy` に切替 |
| `proxy` ソースがエラー | `VITE_GAS_PROXY_URL` 未設定 or read_proxy 未デプロイ | [`04_gas_setup.md`](04_gas_setup.md) |
| 列が空欄ばかり | スプレッドシートの実ヘッダ名がアダプタの `HEADER_MAP` と不一致 | ヘッダを揃える、または将来の `sources.columnMap`（v2.1）対応待ち |
