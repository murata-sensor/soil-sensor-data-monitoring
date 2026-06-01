# Soil Sensor Data Monitoring

土壌センサ／環境ロガーの 3 系統（**FTP（リモート案件） / M5Stack / Mechatrax RasPi**）から
得られたデータを Google Spreadsheet に蓄積し、GitHub Pages 上の SPA で可視化するシステム。
**Google アカウントごとに、参照できるスプレッドシートを個別に制御**する。

既存運用中のスプレッドシート（M5Stack/Mechatrax 系の過去データを含む）も、
レジストリに登録してアダプタで正規化することでそのまま可視化対象にできる。

> **重要**: 本リポジトリは **Public** です。測定データ・FTP/認証情報・座標・固有名詞・
> 各種スプレッドシート ID・SerialNumber は **絶対にコミットしないでください**。
> 詳細は [SPEC.md](./SPEC.md) §2 を参照。

## 構成

```
.
├── SPEC.md                 # 全体仕様（設計・データモデル・セキュリティ）
├── docs/                   # セットアップ手順書
│   ├── 01_google_setup.md
│   ├── 02_github_actions.md
│   ├── 03_pages_deploy.md
│   ├── 04_gas_setup.md
│   └── 05_admin_guide.md
├── scripts/                # FTP→Sheets/Drive 取り込み（Python, GitHub Actions で実行）
├── gas/                    # Google Apps Script（M5Stack受信・気象取得・管理API）
├── web/                    # React + Vite + TypeScript フロントエンド
└── .github/workflows/      # CI / 取り込み / Pages デプロイ
```

## クイックスタート

1. [docs/01_google_setup.md](./docs/01_google_setup.md): Google Cloud プロジェクトとサービスアカウント作成、Spreadsheet 初期化。
2. [docs/04_gas_setup.md](./docs/04_gas_setup.md): GAS（M5Stack受信・気象取得・管理API）デプロイ。
3. [docs/02_github_actions.md](./docs/02_github_actions.md): Secrets 登録と FTP 取り込み Workflow を有効化。
4. [docs/03_pages_deploy.md](./docs/03_pages_deploy.md): GitHub Pages を有効化してフロントをデプロイ。
5. [docs/05_admin_guide.md](./docs/05_admin_guide.md): 管理者画面の使い方。

## ローカル開発

```powershell
# フロント
cd web
npm install
npm run dev

# 取り込みスクリプト
cd ../scripts
python -m venv .venv
. .venv/Scripts/Activate.ps1
pip install -r requirements.txt
pytest
```

## ライセンス

未指定（Internal use only — 検討中）。
