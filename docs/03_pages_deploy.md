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

### 用途に応じて登録する

「**New repository variable**」を押して、1 件ずつ追加。
Firebase を使う場合は、この表に加えて [次節の Firebase 用変数](#firebase-authentication任意)を登録する:

| Name（このまま入力） | 値の例・取得方法 |
|----------------------|------------------|
| `VITE_GOOGLE_CLIENT_ID` | 従来認証で使用。[`01_google_setup.md`](01_google_setup.md) 手順 4-2 の OAuth クライアント ID。Firebase では不使用 |
| `VITE_REGISTRY_SPREADSHEET_ID` | 従来認証で Proxy を使わず直接読む場合に必要。Proxy では GAS 側に Registry ID を設定する |
| `VITE_BASE_PATH` | 任意。未設定なら `/<リポジトリ名>/` を使用。指定する場合は**前後にスラッシュ必須**。独自ドメインのルートに公開する場合は `/` |
| `VITE_GAS_PROXY_URL` | **Firebase・Mechatrax では必須**。従来認証でも推奨。[`04_gas_setup.md`](04_gas_setup.md) の閲覧用 read_proxy の WebApp URL（`https://script.google.com/macros/s/.../exec`） |
| `VITE_GAS_ADMIN_URL` | （任意）ダッシュボードの `/admin` 画面から Registry を書き換えたい場合のみ。同じく [`04_gas_setup.md`](04_gas_setup.md) でデプロイした admin_api の WebApp URL |

> `VITE_BASE_PATH` を指定する場合は、実際の公開先のパスと一致させること。
> 標準の `https://<owner>.github.io/<repo>/` なら、未設定でもワークフローが `/<repo>/` を補完する。

### Firebase Authentication（任意）

非商用の実証実験で Google ログインを維持しやすくするための追加設定。
未設定では従来の Google Identity Services 認証を維持する。
コードの既定値と実環境の設定は別。Firebase では Pages と両 GAS の認証方式を明示して揃える。
**情報管理の承認後にのみ本番へ適用する。**
Firebase SDK の依存関係に合わせ、ローカル開発は Node.js 24.12 以上を使う。
Firebase パッケージに同梱される未使用の Firestore 用 gRPC 依存にも既知の問題があるため、
`package.json` の override で修正版を指定する。画面は Firestore を読み込まない。
開発用の typescript-eslint が使う minimatch にも DoS の監査指摘があるため、
同様に対象の依存関係だけを修正版へ上書きする。typescript-eslint 自体の強制ダウングレードは行わない。

#### 事前設定

1. [Firebase コンソール](https://console.firebase.google.com/)を管理用 Google アカウントで開く。
   既存の Firebase プロジェクトを選ぶか、プロジェクトを作成するボタンから名前を入力して作成する。
   通常の Authentication・Google ログインだけなら
   Spark プランで開始でき、Identity Platform、Firestore、Cloud Functions、課金先登録は不要。
   Analytics・Gemini の有効化も必須ではない。既存の Google Cloud プロジェクトを使う場合は、その課金設定・OAuth 設定を先に確認する。
2. プロジェクトのトップ画面で **`</>` の Web アイコン**を押す。
   見つからなければ **プロジェクトの概要の横の歯車 → プロジェクトの設定 → 全般 → マイアプリ → アプリを追加 → Web**。
   ニックネーム（例: `Soil Sensor Monitor`）を入力して「アプリを登録」を押す。Firebase Hosting の設定は不要で、GitHub Pages は移動しない。
   表示された `const firebaseConfig = { ... }` の `apiKey`・`projectId`・`authDomain` を控える。
   コピーするのは引用符内の値だけ。SDK はリポジトリへ導入済みなので、画面の `npm install firebase` を改めて行う必要はない。
   後からは **プロジェクトの設定 → 全般 → マイアプリ → 対象 Web アプリ → SDK の設定と構成**で確認できる。
   Web 設定値は公開値であり、サービスアカウントの秘密鍵ではない。
3. 左メニュー **構築（Build）→ Authentication** を開き、「始める」が表示されれば押す。
   **Sign-in method（ログイン方法）→ Google → 有効にする**で、利用者に表示してよい公開名とサポートメールを指定して保存する。
   他のログイン方法は有効化しなくてよい。
4. Authentication → Settings → Authorized domains に `<owner>.github.io` を登録する。
   ローカル試験に使う場合は `localhost` も明示的に登録する。
   ドメインはホスト名だけ（例: `example.github.io`）。`https://` やリポジトリ名・末尾の `/` は付けず、既存のドメインも削除しない。
   Google 側の OAuth クライアントに追加設定が必要な場合は、Firebase の案内に従い、
   `https://<authDomain>/__/auth/handler` を承認済みリダイレクト URI に設定する。
5. 閲覧 Proxy を必ず用意する。Firebase モードは Sheets の直接読み取りを使わず、
   `VITE_GAS_PROXY_URL` 未設定では設定エラーを表示する。

以下を GitHub Actions の Repository Variables に追加する（ローカルは `web/.env`）。
設定画面は **リポジトリの Settings → Secrets and variables → Actions → Variables → New repository variable**。
既存の値を変更するときは、その項目の編集ボタンを使う。Variables の変更だけでは公開済み画面には反映されず、再ビルド・公開が必要。

| Name | 値 |
| --- | --- |
| `VITE_AUTH_PROVIDER` | `firebase`（本番切替までは未設定または `google`） |
| `VITE_FIREBASE_API_KEY` | Web アプリの `apiKey` |
| `VITE_FIREBASE_PROJECT_ID` | Web アプリの `projectId` |
| `VITE_FIREBASE_AUTH_DOMAIN` | Web アプリの `authDomain`（通常 `<projectId>.firebaseapp.com`、URL ではなくホスト名） |
| `VITE_GAS_PROXY_URL` | 閲覧用 GAS の既存 WebApp URL（`/exec`）。管理用 URL と取り違えない |

値に引用符や末尾のカンマを含めない。管理画面も使う場合は `VITE_GAS_ADMIN_URL` も必要。

`VITE_GOOGLE_CLIENT_ID` は従来モード用。Firebase モードは Firebase プロジェクト側の Google プロバイダー設定を使用する。
API キーを使っていても、閲覧許可の判定は Registry の `users`・`acl`、管理操作はさらに `ADMIN_ALLOWED_EMAILS` で行う。
Firebase への初回ログインで認証ユーザーが作られても、Registry に未登録なら測定データは見えない。
Firebase には認証用の利用者情報が保存されるが、この変更で測定データを移したり Analytics へ送信したりはしない。

#### ログイン状態の保存

- 「**この端末にログイン状態を保存する**」は初期値 **未チェック**。
  未チェックは Firebase の `browserSessionPersistence` を使い、このタブ内の再読み込みでは維持し、タブを閉じるまで保持する。
- チェック時は `browserLocalPersistence` を使い、ブラウザー再起動後も原則ログアウトまで保持する。30日の独自期限は設けない。
- 保存先の設定が成功してからログイン用ポップアップを開く。保存できない場合、別の保存方式でログイン成功にしない。
- 既存セッションの復元時は保存先を切り替えず、チェック操作なしで保存期間を延ばさない。
  保存先は **次回の明示ログイン時**に選び直す。
- SDK が ID トークンを自動更新するため、通常の期限更新で One Tap や追加の Sheets 同意を要求しない。
  初回同意、アカウント無効化、セッション失効、保存データ削除、別の端末などでは再ログインが必要。
- 共有端末では未チェックで利用し、利用後は明示的にログアウトする。
  ブラウザーのセッション復元などの影響もあるため、タブを閉じる操作だけを完全なデータ消去の保証としない。
  ダッシュボードの表示設定は従来どおり端末に残る。このチェックは表示設定の保存を制御しない。
- 永続ログインの別タブでのログアウト・利用者変更は Firebase SDK で同期し、表示中の画面も更新する。
  タブ単位のログインは他タブと同じ挙動とは限らない。

#### 切替・確認・切り戻し

1. Registry をバックアップし、現在の Pages コミット・GAS の公開版・設定を控える。
2. 上記 Firebase 用変数を登録するが、既存環境の `VITE_AUTH_PROVIDER` はまだ `google` にしておく。
   Firebase 対応コードが GitHub に反映されていることを確認し、従来認証のまま Pages を公開する。
3. [GAS の手順](04_gas_setup.md#b-2-スクリプトプロパティ)に従い、管理・閲覧の両プロジェクトで
   API 本体と `firebase_auth.gs`、Firebase 用プロパティを準備する。`AUTH_PROVIDER=google` のまま
   **デプロイを管理 → 鉛筆アイコン → 新バージョン → デプロイ**で更新し、従来のログイン・データ表示を確認する。
   既存 URL を維持するため「新しいデプロイ」は選ばない。
4. 他の利用者が作業していないタイミングで利用を一時停止し、**両 GAS の `AUTH_PROVIDER` を `firebase` に変更して保存**する。
   コードは公開済みなので、このプロパティ変更のための再デプロイは不要。
5. GitHub の **`VITE_AUTH_PROVIDER` も `firebase` に変更**し、
   **Actions → deploy-pages → Run workflow → main → Run workflow** で新しく実行する。
   検査・ビルド・公開の全ジョブの成功を確認する。
   新旧トークンを同時に許可する切替ではないため、GAS の変更から Pages の公開完了までは旧画面の API 通信が失敗する。
6. 新方式の画面起動時に旧 `soil_user`・`soil_login_at`・Sheets 用トークンを端末から削除し、
   Firebase で一度ログインし直す。Google 側の過去の Sheets 許可は自動で取り消さない。
7. 個人端末のチェックあり／共有端末のチェックなしで、再読み込み・タブ終了・ブラウザー再起動・
   1時間超の利用・ログアウト後の再表示を確認する。別タブ同期、一般閲覧者の ACL、無効化、
   管理者の読み書き、ポップアップ拒否・通信失敗も別途確認する。

切り戻す場合は利用を止め、両 GAS の `AUTH_PROVIDER` を `google` に戻して `GOOGLE_OAUTH_CLIENT_ID` を確認し、
Pages の `VITE_AUTH_PROVIDER` も `google` に戻して再公開する。
Firebase のログイン保存情報は旧画面では使わないが、将来 Firebase に再切替した際に復元され得る。
必要な端末では切替前に Firebase モードでログアウトするか、サイトの保存データを削除する。
別端末のセッションまで失効させる場合は Firebase 側で対象ユーザーのセッションを失効させる。

コードのテストだけでは実アカウント・ブラウザーごとの挙動や公開先の設定まで検証できないため、
本番切替は上記の実機確認と情報管理の承認をもって完了とする。

#### 運用確認記録（2026-11-17時点）

実証実験環境では 2026-11-16 に Firebase + 閲覧 Proxy へ切替済み。
以下は利用者からの確認報告であり、すべての端末・ブラウザー・失効条件を網羅する試験結果ではない。

| 日付 | 確認できたこと |
| --- | --- |
| 2026-11-16 | Firebase での実アカウントのログイン、データ表示、ページ再読み込み後のログイン維持 |
| 2026-11-16 | ログアウト後の再ログイン |
| 2026-11-17 | 翌日の PC 起動・Chrome 再起動後も、ログイン操作なしで画面を表示 |

追加確認として、共有端末相当の未チェック利用でのタブ終了、別タブでの利用者変更、Chrome 以外のブラウザー、
無効化・失効時の拒否、明示的に1時間以上経過させた後の新しいデータ取得を残す。
翌日の画面表示だけで、期限更新やすべての API 操作を個別に検証済みとは扱わない。

---

## 2. Pages を有効化する（最初の 1 回だけ）

1. 同じく Settings 画面の左メニューを少し上にスクロール
2. 「Code and automation」セクションの「**Pages**」をクリック
3. 画面中央の「Build and deployment」セクションで:
   - **Source**: ドロップダウンから「**GitHub Actions**」を選ぶ（**`Deploy from a branch` ではない**）
4. これで設定完了。「保存」ボタンは無く、選択した瞬間に反映される

---

## 3. デプロイを実行する

### 公開前のチェック

公開処理の中から共通の CI を呼び、同じコミットの Python・画面・Google 側スクリプトのテスト、
依存ライブラリの脆弱性検査、公開ファイルの秘密情報チェックがすべて成功してからビルド・公開する。
検査が失敗した場合は新しい版を公開せず、現在公開中の版を残す。
通常の CI とは別に公開処理の中でも検査するため、main 更新時には検査が重複して実行される場合がある。
公開用の権限は最後の公開ジョブだけに与え、検査・ビルドには与えない。

CI と Pages が使う外部 Actions は、公式タグの参照先を照合した完全なコミット番号に固定する。
同じタグ名の中身が後から差し替わっても、実行するコードが勝手に変わらないようにするための対策であり、今回の固定では使用中の版を更新していない。
検査・ビルドでソースを取得するときの GitHub トークンは、後続処理が不要に読み取らないよう Git 設定に保存しない。

更新を放置しないよう、Dependabot が週1回、Actions の更新候補をプルリクエストとして提案する設定を追加している。
この設定は既定ブランチへの反映後に有効となり、自動マージは追加しない。変更内容と CI の結果を確認してから取り込む。
更新提案の対象はリポジトリ全体の Actions なので、FTP 用ワークフローの提案も含まれ得るが、提案だけで通信方式や本番設定が変更されるわけではない。
今回、FTP 用ワークフローや取り込み処理そのものは変更していない。

この処理が更新するのは Web 画面だけ。Google 側の GAS の新バージョン配備や Drive 共有変更は別作業。
詳しくは [GAS の適用手順](../gas/README.md#セキュリティ更新の適用)を参照。

### 方法 A: 自動（push したら勝手にデプロイ）

`web/` 配下の任意のファイルを編集して `main` ブランチに push すると、
`deploy-pages.yml` ワークフローが自動で走る。

### 方法 B: 手動（設定変更後すぐに反映したいとき）

1. リポジトリ上部タブの「**Actions**」をクリック
2. 左サイドバーで「**Deploy Pages**」（または `deploy-pages`）を選ぶ
3. 画面右上の「**Run workflow**」プルダウンを押す
4. ブランチを `main` のまま「Run workflow」ボタンを押す
5. 検査・ビルド・公開の全ジョブが緑チェックになれば完了。失敗した場合は失敗した検査を確認する

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

**この節は従来の Google Identity Services 認証向け**。
Firebase では [事前設定](#事前設定)の Authorized domains と、Firebase 側が案内する OAuth 設定を確認する。

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
2. Firebase では保存チェックの初期値が未チェックであることを確認し、「Googleでログイン」→ 自分のアカウントを選ぶ。
   既に有効な保存セッションがあればログイン画面を省略してよい
3. ログイン成功後、Registry の `sources` で許可されたデータソースのドロップダウンが表示されればOK
4. データソースを選ぶとグラフが描画される

### 本番 Pages で更新版を確認する場合

公開前に、直前に成功した Pages の公開履歴とコミット番号、各 GAS プロジェクトの公開版番号を控え、Registry をバックアップする。
管理 API と閲覧 Proxy は別プロジェクトであることを確認し、今回のコード・必要な Script Properties・接続先 URL を照合する。
版番号だけでは、どのコードが反映されているかは判断できない。

新しい管理画面は更新後の管理 API を必要とする。API の切替から Pages 更新までの間は設定編集を止め、
対応する GAS と画面を揃えて反映する。main への push 後、検査・ビルド・公開の全ジョブの成功を確認する。
Pages の公開は GAS 自体を更新しない。GAS の切替は [GAS の適用手順](../gas/README.md#セキュリティ更新の適用)で別途行う。

最初はログイン、許可されたソース・過去年タブの表示、CSV、ログアウトを確認する。
管理画面は設定の読み込みまでとし、保存、利用者の無効化、ACL の変更、測定データの送信試験は分けて実施する。
ローカル起動した画面でも、本番 URL に接続して保存すれば本番の設定を書き換える。

問題が出た場合は確認操作を止め、変更した範囲に応じて Pages と GAS を対応する以前の版へ戻す。
Pages は対象変更を取り消すコミットを main に反映して再公開する。GAS は控えた公開版に戻す。
コードを戻しても、すでに書き換えたシートの内容は戻らない。復元が必要な場合は、バックアップ後の正当な変更も確認してから行う。

---

## トラブルシューティング

### 画面が真っ白（コンソールに 404 が出る）

→ `VITE_BASE_PATH` の指定値が実際の公開先と一致していない可能性がある。
   標準のリポジトリ用 URL なら未設定で自動補完される。
   指定する場合は `/soil-sensor-data-monitoring/` のように **前後ともスラッシュ** で囲み、独自ドメインのルート公開なら `/` にする。

### 「アクセスがブロックされました」

→ Firebase では Google プロバイダーの有効化と、Firebase 側が案内する OAuth クライアント・同意画面の設定を確認する。
従来認証では手順 5 の JavaScript 生成元や、[`01_google_setup.md`](01_google_setup.md) 手順 3-3 のテストユーザーを確認する。

### Firebase のログイン画面でエラーになる

| 表示・症状 | 確認する設定 |
| --- | --- |
| Firebase の設定が不足している | Firebase の3変数と `VITE_GAS_PROXY_URL`。登録後は Pages を再ビルド |
| 公開ドメインが許可されていない | Firebase Authentication → Settings → Authorized domains に公開先のホスト名を追加 |
| ポップアップがブロックされた | このサイトのポップアップをブラウザーで許可 |
| ログイン情報を保存できない | ブラウザーの保存設定・空き容量。共有端末では無理に永続保存しない |
| ログインできるが API が拒否する | 両 GAS の方式・Firebase プロジェクト・API キー・ヘルパーの公開版を照合し、Registry の有効状態・ACL も確認 |

エラー調査で ID トークン・秘密鍵をチャットやログへ貼り付けない。表示文と発生操作を記録する。

### ログインはできるが「アクセス権がありません」と表示される

→ Registry の `users` シートに自分のメールが入っていない、または `enabled=FALSE` になっている。
   [`05_admin_guide.md`](05_admin_guide.md) 参照。

### ログインできてもデータソースのドロップダウンが空

→ `viewer` ロールなのに `acl` シートに自分の行が無い。
   [`05_admin_guide.md`](05_admin_guide.md) の「viewer の追加」例を参照。

### 設定を変えたのに反映されない

→ ビルド時に値が埋め込まれるため、**Variables を変えたら Actions → deploy-pages → Run workflow** で新しく実行する。
GAS の Script Properties は保存で反映されるが、GAS コード自体の変更は公開版の更新が必要。

### 「リソースの読み込みエラー」（Sheets API 403）

→ 従来認証で Proxy 未設定の直接読み取りに限り、閲覧者自身への Drive 共有を確認する。
Firebase は直接読み取りを使わない。古い画面が残っていないか確認し、
Proxy の失敗なら閲覧 GAS 実行者への共有・認証設定・Registry の許可を確認する。

---

次のステップ → [`04_gas_setup.md`](04_gas_setup.md)（GAS 受信スクリプトのデプロイ）
