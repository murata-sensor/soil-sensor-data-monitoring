# Soil Sensor Data Monitoring

土壌センサ／環境ロガーの 4 系統（**リモートFTP / M5Stack / Mechatrax RasPi / PC シリアル**）から
得られたデータを Google Spreadsheet に蓄積し、GitHub Pages 上の SPA で可視化するシステム。
**Google アカウントごとに、参照できるスプレッドシートを個別に制御**する。

既存運用中のスプレッドシート（M5Stack/Mechatrax 系の過去データを含む）も、
レジストリに登録してアダプタで正規化することでそのまま可視化対象にできる。

主な特徴:
- **マルチデータソース**: 案件ごとに異なる Spreadsheet をレジストリで一元管理
- **PC 直結ロガー対応**: [soil-sensor-samples-python](https://github.com/murata-sensor/soil-sensor-samples-python) の
  `continuous_log.py --upload-url ...` から直接取り込み（`pc-serial` スキーマ）
- **カスタムレイアウト**: デバイス列配置・ゲージ・テキスト・画像パネルを JSON で自由にレイアウト
- **編集/表示モード**: 編集モードでレイアウト調整、表示モードで印刷・プレゼン向けクリーン表示
- **マルチセンサ対応**: `sensorNumber` による深度別表示・色分け
- **アラート通知**: センサ異常値（接触不良・故障）・電池残量低下をメールで自動通知
- **レスポンシブ**: モバイルでは 2 カラム自動スタック
- **気象データ統合**: Open-Meteo (FTP) / AMeDAS (Mechatrax) から自動取得
- **期間フィルタ**: 24h / 3d / 7d / 30d / all / カスタム日付範囲
- **CSV ダウンロード**: 正規化モデルでエクスポート

> **重要**: 本リポジトリは **Public** です。測定データ・FTP/認証情報・座標・固有名詞・
> 各種スプレッドシート ID・SerialNumber は **絶対にコミットしないでください**。
> 詳細は [SPEC.md](./SPEC.md) §2 を参照。

## 構成

```
.
├── SPEC.md                 # 全体仕様（設計・データモデル・セキュリティ）
├── pytest.ini              # pytest 設定
├── docs/                   # セットアップ手順書
│   ├── 01_google_setup.md
│   ├── 02_github_actions.md
│   ├── 03_pages_deploy.md
│   ├── 04_gas_setup.md
│   ├── 05_admin_guide.md
│   ├── 06_weather_integration.md
│   ├── layout.json         # カスタムレイアウト実例
│   └── layout_example.json # レイアウト JSON テンプレート
├── scripts/                # FTP→Sheets/Drive 取り込み（Python, GitHub Actions で実行）
│   └── adapters/           # 正規化アダプタ（Python）
├── gas/                    # Google Apps Script（M5Stack/Mechatrax/PC受信・気象取得・管理API・アラート送信）
├── web/                    # React + Vite + TypeScript フロントエンド
│   └── src/adapters/       # 正規化アダプタ（TypeScript）
└── .github/workflows/      # CI / 取り込み / Pages デプロイ
```

## クイックスタート

1. [docs/01_google_setup.md](./docs/01_google_setup.md): Google Cloud プロジェクトとサービスアカウント作成、Spreadsheet 初期化。
2. [docs/04_gas_setup.md](./docs/04_gas_setup.md): GAS（M5Stack/Mechatrax/PC受信・気象取得・管理API）デプロイ。
3. [docs/02_github_actions.md](./docs/02_github_actions.md): Secrets 登録と FTP 取り込み Workflow を有効化。
4. [docs/03_pages_deploy.md](./docs/03_pages_deploy.md): GitHub Pages を有効化してフロントをデプロイ。
5. [docs/05_admin_guide.md](./docs/05_admin_guide.md): 管理者画面の使い方・レイアウトカスタマイズ。
6. [docs/06_weather_integration.md](./docs/06_weather_integration.md): 気象データ統合（Open-Meteo / AMeDAS）。

## ローカル開発

フロントエンドは Node.js 24 以上を使用する。セキュリティ更新の本番適用は
[GAS の適用手順](./gas/README.md#セキュリティ更新の適用)を参照。

```powershell
# フロント
cd web
npm install
npm run dev

# テスト（フロント）
npm test

# 取り込みスクリプト（Python 3.12）
py -3.12 -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r scripts/requirements.txt
pip install -r scripts/requirements-dev.txt
pytest
```

CI は PR・main 更新・週次に `npm audit`、`pip-audit` と回帰テストを実行する。
GAS のローカル回帰テストはリポジトリルートで `node --test gas/tests/security.test.cjs` を実行する。

## 公開ファイルの秘密情報チェック

`python -m scripts.check_no_pii` は、公開対象のファイルに秘密鍵や代表的な認証キーが
混ざっていないか検査する。名前の一覧が未設定でも、この基本チェックは実行する。
秘密の値自体は検査ログに出さず、ファイル名・行番号・情報の種類だけを表示する。
Git が無視するローカル設定や認証ファイルは対象外。
ただし、Git の管理対象に追加された `.pem`・`.key` は、無視設定にかかわらず検査する。

これとは別に、「この組織では公開してはいけない会社名・住所・メールアドレス・識別番号」を
追加で探すための一覧として `.pii_blocklist.local` を使える。これまで説明していた
「検査語」は、この一覧に書く文字列のこと。1行に1件を書き、一覧そのものは公開しない。
実際の名前や認証情報をチャットやリポジトリへ貼り付ける必要はない。

会社名・測定値・座標などが秘密かどうかを、検査プログラムだけで判断することはできない。
チェック成功は「設定した条件で見つからなかった」という意味で、漏えいがない保証ではない。
運用時に必要な更新・確認は [gas/README.md](./gas/README.md#セキュリティ更新の適用)を参照。

## 主要な依存ライブラリ

| フロント | 用途 |
| --- | --- |
| React 18 + Vite + TypeScript | SPA フレームワーク |
| TailwindCSS | ユーティリティ CSS |
| Chart.js + react-chartjs-2 | グラフ描画 |
| chartjs-plugin-annotation | イベント縦線注釈 |
| react-grid-layout | カスタムレイアウトのグリッド配置 |
| Zustand | 軽量状態管理 |
| date-fns | 日付処理 |

## ライセンス

本リポジトリは [MIT License](./LICENSE) の下で公開しています。
