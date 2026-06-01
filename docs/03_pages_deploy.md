# 03. GitHub Pages デプロイ

このページは「ダッシュボード本体（`web/` 配下の React アプリ）を GitHub の無料 Web ホスティング
（**GitHub Pages**）で公開する」手順です。
最終的に `https://<あなたの GitHub ユーザ名>.github.io/soil-sensor-data-monitoring/` のような URL で
ダッシュボードが開けるようになります。

---

## 1. Variables を登録する

ビルド時にダッシュボードに埋め込まれる **公開して問題ない値**。Secrets と違って Actions 実行ログにも表示される。

### 画面を開く

1. リポジトリのブラウザページを開く
2. 上部タブの「**Settings**」をクリック
3. 左メニューの「Security」セクションから「**Secrets and variables**」→「**Actions**」をクリック
4. 画面上部の **「Variables」タブ** に切り替える（Secrets タブと並んでいる）

### 5 件登録する

緑色の「**New repository variable**」を押して、1 件ずつ追加:

| Name（このまま入力） | 値の例・取得方法 |
|----------------------|------------------|
| `VITE_GOOGLE_CLIENT_ID` | [`01_google_setup.md`](01_google_setup.md) 手順 4-2 で控えた OAuth クライアント ID（`xxxxx.apps.googleusercontent.com` の形式） |
| `VITE_REGISTRY_SPREADSHEET_ID` | [`01_google_setup.md`](01_google_setup.md) 手順 1-4 で控えた Registry スプレッドシートの ID |
| `VITE_BASE_PATH` | `/<リポジトリ名>/` （例: `/soil-sensor-data-monitoring/`）。**前後にスラッシュ必須** |
| `VITE_GAS_PROXY_URL` | （任意）`accessMode=proxy` のソースを 1 つでも使う場合のみ。[`04_gas_setup.md`](04_gas_setup.md) で read_proxy をデプロイしたときに得た WebApp URL（`https://script.google.com/macros/s/.../exec`） |
| `VITE_GAS_ADMIN_URL` | （任意）ダッシュボードの `/admin` 画面から Registry を書き換えたい場合のみ。同じく [`04_gas_setup.md`](04_gas_setup.md) でデプロイした admin_api の WebApp URL |

> `VITE_BASE_PATH` を **忘れると、デプロイ後に画面が真っ白になる**（CSS/JS のパスが解決できなくなるため）。
> リポジトリ名と完全一致させること。

---

## 2. Pages を有効化する（最初の 1 回だけ）

1. 同じく Settings 画面の左メニューを少し上にスクロール
2. 「Code and automation」セクションの「**Pages**」をクリック
3. 画面中央の「Build and deployment」セクションで:
   - **Source**: ドロップダウンから「**GitHub Actions**」を選ぶ（**`Deploy from a branch` ではない**）
4. これで設定完了。「保存」ボタンは無く、選択した瞬間に反映される

---

## 3. デプロイを実行する

### 方法 A: 自動（push したら勝手にデプロイ）

`web/` 配下の任意のファイルを編集して `main` ブランチに push すると、
`deploy-pages.yml` ワークフローが自動で走る。

### 方法 B: 手動（設定変更後すぐに反映したいとき）

1. リポジトリ上部タブの「**Actions**」をクリック
2. 左サイドバーで「**Deploy Pages**」（または `deploy-pages`）を選ぶ
3. 画面右上の「**Run workflow**」プルダウンを押す
4. ブランチを `main` のまま「Run workflow」ボタンを押す
5. 1〜2 分待って緑チェックになれば完了

---

## 4. 公開 URL を確認する

デプロイ成功後、以下の URL でアクセスできる:

```
https://<owner>.github.io/<repo>/
```

例: `https://kanade.github.io/soil-sensor-data-monitoring/`

URL の正確な値は **Settings → Pages 画面の上部** にも表示されている。

> 初回デプロイ後、URL が有効になるまで 1〜2 分かかることがある。

---

## 5. OAuth クライアントに公開 URL を登録する（最初の 1 回だけ）

このまま開くと「アクセスがブロックされました」と Google にはじかれる。
[`01_google_setup.md`](01_google_setup.md) 手順 4-1 で作った OAuth クライアントの
**「承認済みの JavaScript 生成元」** に、**手順 4 で表示された公開 URL のオリジン部分**（パスを除いたもの）を追加する。

1. <https://console.cloud.google.com/apis/credentials> を開く
2. 「OAuth 2.0 クライアント ID」セクションのクライアント名をクリック
3. 「承認済みの JavaScript 生成元」の「**+ URI を追加**」を押す
4. `https://<owner>.github.io` （**末尾スラッシュなし、パスなし**）を入力
5. 下部の「**保存**」ボタンを押す
6. 反映まで数分かかることがある

---

## 6. 動作確認

1. 公開 URL を開く
2. Google ログイン画面が出る → 自分の Google アカウントを選ぶ
3. ログイン成功後、Registry の `sources` で許可されたデータソースのドロップダウンが表示されればOK
4. データソースを選ぶとグラフが描画される

---

## トラブルシューティング

### 画面が真っ白（コンソールに 404 が出る）

→ `VITE_BASE_PATH` が未設定、または値がリポジトリ名と一致していない。
   `/soil-sensor-data-monitoring/` のように **前後ともスラッシュ** で囲んだ値か確認。

### 「アクセスがブロックされました」

→ 手順 5 の JavaScript 生成元の登録漏れ。または OAuth 同意画面のテストユーザーに自分のメールが入っていない（[`01_google_setup.md`](01_google_setup.md) 手順 3-3）。

### ログインはできるが「アクセス権がありません」と表示される

→ Registry の `users` シートに自分のメールが入っていない、または `enabled=FALSE` になっている。
   [`05_admin_guide.md`](05_admin_guide.md) 参照。

### ログインできてもデータソースのドロップダウンが空

→ `viewer` ロールなのに `acl` シートに自分の行が無い。
   [`05_admin_guide.md`](05_admin_guide.md) の「viewer の追加」例を参照。

### 設定を変えたのに反映されない

→ ビルド時に値が埋め込まれるため、**Variables を変えたら手動で Re-run workflow** が必要。

### 「リソースの読み込みエラー」（Sheets API 403）

→ そのスプレッドシートが `accessMode=direct` で、かつ自分の Google アカウントに **Drive 上で「閲覧者」共有** されていない。
   ユーザー（案件主）に共有を依頼するか、`accessMode=proxy` への切替を検討する。

---

次のステップ → [`04_gas_setup.md`](04_gas_setup.md)（GAS 受信スクリプトのデプロイ）
