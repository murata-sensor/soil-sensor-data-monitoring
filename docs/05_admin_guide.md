# 05. 管理者ガイド

Registry スプレッドシートの 5 つのシート（`sources` / `users` / `acl` / `theme` / `events`）で
アクセス制御と表示を管理します。
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
| `siteId` | `site-a` | 圃場識別子 |
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

| date | sourceId | label | color |
| --- | --- | --- | --- |
| `2026-06-25` | `src-remote-a` | `塩処理開始` | `#ef4444` |

選択中のソースに該当する行だけがグラフに縦線で表示される。

---

## 5. CSV ダウンロード

ダッシュボードの 「ソース選択 → 期間指定 → **CSV ダウンロード**」 ボタンで正規化済み行を取得できる。
列は SPEC §4.4 の `NormalizedRow` キーすべて（`ts, device_id, temperature_c, vwc_pct, ...`）で、
未対応フィールドは空欄になる。論文用 1 ファイル化に便利。

---

## 6. PII / 取り扱い注意

`mechatrax` の生スプレッドシートには **位置情報・基地局情報・端末識別子** が含まれます。
ダッシュボードのアダプタはこれらを **意図的に読み飛ばす**（`HEADER_MAP` に登録していない）ため、
CSV ダウンロードや画面表示には出てきません。
ただし **生データ自体の Drive 共有範囲** は管理者が適切に絞ること。

---

## 7. 困ったときの早見表

| 症状 | 原因の可能性 | 対応 |
| --- | --- | --- |
| ログインできない | `users` に行が無い / `enabled=FALSE` | 行追加 or `TRUE` に |
| ログインできるが何も見えない（viewer） | `acl` に許可行が無い | 例A の手順 3 |
| `/admin` が開けない | `users.role` が `viewer` | `admin` に変更 |
| ドロップダウンに出ない（admin なのに） | `sources.enabled = FALSE` | `TRUE` に |
| 選択するとエラー | `direct` のソースを Drive 共有していない | 例A 手順 4、または `proxy` に切替 |
| `proxy` ソースがエラー | `VITE_GAS_PROXY_URL` 未設定 or read_proxy 未デプロイ | [`04_gas_setup.md`](04_gas_setup.md) |
| 列が空欄ばかり | スプレッドシートの実ヘッダ名がアダプタの `HEADER_MAP` と不一致 | ヘッダを揃える、または将来の `sources.columnMap`（v2.1）対応待ち |
