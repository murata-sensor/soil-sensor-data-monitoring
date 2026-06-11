# 02. GitHub Actions（リモートFTP 取り込み）セットアップ

> このページは **リモートデータの FTP 自動取り込み** だけを設定します。
> M5Stack と Mechatrax のデータは Google Apps Script（GAS）で別ルートで書き込まれるため、
> ここの設定とは **完全に独立** です（[`04_gas_setup.md`](04_gas_setup.md)）。

GitHub Actions とは「GitHub が毎日決まった時刻に Python スクリプトを実行してくれる仕組み」のこと。
ここで設定するのは:

- **Secrets**: 公開してはいけないパスワード等。Actions の実行時にだけ環境変数として読まれる
- **Variables**: 公開しても問題ない設定値

---

## 1. Settings → Secrets and variables → Actions 画面を開く

1. GitHub のブラウザでこのリポジトリのページを開く（例: `https://github.com/<yourname>/soil-sensor-data-monitoring`）
2. リポジトリページの **上部タブ** の右端の「**Settings**」（歯車アイコン）をクリック
   - 注意: タブには `Code / Issues / Pull requests / ... / Settings` と並ぶ。タブが見えない場合はリポジトリの管理者権限がない
3. 左メニューを下にスクロール → 「**Security**」セクションの中の「**Secrets and variables**」をクリック → サブメニューの「**Actions**」をクリック
4. このページに「**Secrets**」タブと「**Variables**」タブの 2 つがある（画面上部）

---

## 2. Secrets を登録する

「Secrets」タブが選ばれている状態で、画面右上の緑色の「**New repository secret**」ボタンを押す。
1 件ずつ以下の値を登録する（同じ操作を繰り返す）:

| Name（このまま入力） | Secret 欄に入れる値の例・取得方法 |
|----------------------|-----------------------------------|
| `FTP_HOST` | 例: `203.0.113.10`（リモートセンサ FTP サーバの IP またはホスト名） |
| `FTP_USER` | 例: `ftp_user`（FTP ログイン ID） |
| `FTP_PASS` | 例: `passw0rd!`（FTP パスワード） |
| `FTP_DIR`  | 例: `/sataraid1/disk7`（FTP 内のディレクトリパス） |
| `FTP_SITE_LATITUDE` | （任意・天気連携する場合）圃場の緯度。例: `37.7749` |
| `FTP_SITE_LONGITUDE` | （任意・天気連携する場合）圃場の経度。例: `122.4194` |
| `FTP_SPREADSHEET_ID` | [`01_google_setup.md`](01_google_setup.md) 手順 1-5 で作成した **FTPデータ用** スプレッドシートの ID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | [`01_google_setup.md`](01_google_setup.md) 手順 5-2 でダウンロードした JSON ファイルを **テキストエディタで開いて全文コピー** して貼り付ける（先頭の `{` から最後の `}` まで） |
| `INGEST_FILTER_START` | 例: `2026-06-12T10:30+09:00`（この時刻より古いデータは取り込まない。初年度なら年初を指定） |
| `DRIVE_BACKUP_FOLDER_ID` | （任意・バックアップ不要ならスキップ）[`01_google_setup.md`](01_google_setup.md) 手順 6-2 のフォルダ ID |

操作の流れ:

1. 「New repository secret」を押す
2. **Name** 欄に上表の名前をそのまま（大文字・アンダースコア含めて完全一致で）入れる
3. **Secret** 欄に値を入れる
4. 下部の「Add secret」を押す
5. 一覧に戻ったら、また「New repository secret」を押して次の項目へ

> **JSON 鍵を貼るときの注意**: 改行を含む長い文字列だが、そのまま全部貼り付けて OK。
> 余計な空白を足したり改行を削除したりしない。

> **後方互換**: 旧プロジェクトから引き継いだ環境で `SPREADSHEET_ID` という古い Secret が残っている場合、
> `FTP_SPREADSHEET_ID` が未設定なら自動的にそちらが使われる。新規環境では `FTP_SPREADSHEET_ID` のみで OK。

---

## 3. Variables を登録する

画面上部で「**Variables**」タブをクリックして切り替える。
緑色「**New repository variable**」を押して以下を登録:

| Name | 値の例 | 意味 |
|------|--------|------|
| `SITE_ID` | `site-a` | FTPデータの `siteId` デフォルト。Registry の `sources` 行で個別指定がなければこの値が使われる |

> Variables は **画面に表示されても問題ない値** を入れる場所。パスワードや鍵は Secrets 側に入れる。

---

## 4. 動作確認（手動でワークフローを 1 回走らせる）

設定が正しいかを **手動実行** で確認する。

1. リポジトリページ上部タブの「**Actions**」をクリック
2. 左サイドバーのワークフロー一覧から「**Ingest FTP**」（または `ingest-ftp`）をクリック
3. 画面右上の「**Run workflow**」ボタン（青いプルダウン）を押す
4. ブランチが `main` であることを確認する
5. **Year filter** 欄に取り込みたい年（例: `2025`）を入力する（空のままだと当年＝2026 を探すため、過去データは 0 件になる）
6. 「Run workflow」を押す
7. 数秒待つとリストに **黄色い丸** の実行が表示される。クリックして詳細を開く
8. 中の「**ingest**」ジョブをクリック → 各ステップが緑チェックになれば成功
9. 失敗時は赤い ✕ がついたステップを展開すると Python のエラーログが見える

成功すると:

- FTP用スプレッドシートの `sensor_raw` / `sensor_9am` シートに新しい行が追加される
- `DRIVE_BACKUP_FOLDER_ID` を設定した場合は、Drive フォルダにも CSV が積み上がる
- 以降は毎日 **09:30 JST**（UTC 00:30）に自動実行される

---

## 5. 取り込んだデータをダッシュボードで見られるようにする

データを Spreadsheet に書き込んだだけではダッシュボードには出ない。
Registry の `sources` シートに 1 行登録する必要がある。

1. [`01_google_setup.md`](01_google_setup.md) 手順 1 で作成した Registry スプレッドシートを開く
2. `sources` タブを選ぶ
3. 末尾に 1 行追加（例）:

| sourceId | displayName | schemaType | spreadsheetId | sheetName | headerRow | siteId | tz | accessMode | enabled | notes |
|----------|-------------|------------|---------------|-----------|-----------|--------|----|------------|---------|-------|
| `src-remote-a` | `A圃場` | `remote-ftp` | （`FTP_SPREADSHEET_ID` と同じ） | `sensor_9am` | `1` | `site-a` | `Asia/Tokyo` | `direct` | `TRUE` | |

4. ダッシュボードを使う閲覧者の `acl` 行を追加（[`05_admin_guide.md`](05_admin_guide.md) を参照）

---

## トラブルシューティング

### Actions の実行ログに `403 Permission denied` と出る

→ サービスアカウントのメールにFTP用スプレッドシートを **編集者** 共有していない。
   [`01_google_setup.md`](01_google_setup.md) 手順 5-4 をやり直す。

### `530 Login incorrect`（FTP）

→ `FTP_HOST` / `FTP_USER` / `FTP_PASS` のどれかが間違っている。Secrets を更新してリトライ。

### `Invalid JSON` で異常終了

→ `GOOGLE_SERVICE_ACCOUNT_JSON` Secret に JSON 以外の文字が混ざっている。
   ダウンロードした `.json` ファイルを「メモ帳」ではなく **VS Code** や **Notepad++** で開いて、丸ごとコピー → 貼り直す。

### ファイルが見つからない / 空ファイル

→ 年度切り替え時に過去年データを取り込みたいなら、`workflow_dispatch` の入力欄に `INGEST_YEAR=2025` を渡せる
（`ingest-ftp.yml` の `inputs.year` を参照）。

### Settings タブが見えない

→ そのリポジトリの管理者権限がない。Owner に Admin 権限の付与を依頼する。

---

次のステップ → [`03_pages_deploy.md`](03_pages_deploy.md)（ダッシュボード本体を公開）
