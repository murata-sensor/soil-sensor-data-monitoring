# Soil Sensor Data Monitoring

土壌センサ／環境ロガーの 3 系統（**リモートFTP / M5Stack / Mechatrax RasPi**）から
得られたデータを Google Spreadsheet に蓄積し、GitHub Pages 上の SPA で可視化するシステム。
**Google アカウントごとに、参照できるスプレッドシートを個別に制御**する。

既存運用中のスプレッドシート（M5Stack/Mechatrax 系の過去データを含む）も、
レジストリに登録してアダプタで正規化することでそのまま可視化対象にできる。

主な特徴:
- **マルチデータソース**: 案件ごとに異なる Spreadsheet をレジストリで一元管理
- **カスタムレイアウト**: デバイス列配置・ゲージ・テキスト・画像パネルを JSON で自由にレイアウト
- **マルチセンサ対応**: `sensorNumber` による深度別表示・色分け
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
├── gas/                    # Google Apps Script（M5Stack/Mechatrax受信・気象取得・管理API）
├── web/                    # React + Vite + TypeScript フロントエンド
│   └── src/adapters/       # 正規化アダプタ（TypeScript）
└── .github/workflows/      # CI / 取り込み / Pages デプロイ
```

## クイックスタート

1. [docs/01_google_setup.md](./docs/01_google_setup.md): Google Cloud プロジェクトとサービスアカウント作成、Spreadsheet 初期化。
2. [docs/04_gas_setup.md](./docs/04_gas_setup.md): GAS（M5Stack/Mechatrax受信・気象取得・管理API）デプロイ。
3. [docs/02_github_actions.md](./docs/02_github_actions.md): Secrets 登録と FTP 取り込み Workflow を有効化。
4. [docs/03_pages_deploy.md](./docs/03_pages_deploy.md): GitHub Pages を有効化してフロントをデプロイ。
5. [docs/05_admin_guide.md](./docs/05_admin_guide.md): 管理者画面の使い方・レイアウトカスタマイズ。
6. [docs/06_weather_integration.md](./docs/06_weather_integration.md): 気象データ統合（Open-Meteo / AMeDAS）。

## ローカル開発

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
