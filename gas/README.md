# Google Apps Script

v2 では GAS プロジェクトを 3 種類に分けて使う：

## (A) 受信用（データ用スプレッドシートにバインド）

| ファイル | 用途 |
| --- | --- |
| `m5stack_receiver.gs` | M5Stack の POST を受けて A〜M 列に append |
| `mechatrax_receiver.gs` | Mechatrax RasPi の POST を受けて A〜AE 列に append |
| `amedas_fetcher.gs` | mechatrax_receiver から呼ばれる AMeDAS 解決ヘルパ |
| `weather_fetcher.gs` | （旧 v1 互換）Open-Meteo から日次気象を1サイト分取る場合のみ任意で使用 |

Script Properties: `INGEST_TOKEN`（必須）、`M5_TARGET_SHEET` / `MX_TARGET_SHEET`（任意）。

## (B) Registry 用（Registry スプレッドシートにバインド）

| ファイル | 用途 |
| --- | --- |
| `admin_api.gs` | 管理画面からの読み書き API（ID トークン検証 + `ADMIN_ALLOWED_EMAILS` チェック） |
| `read_proxy.gs` | `accessMode=proxy` のデータソース読み出し API |

Script Properties: `ADMIN_ALLOWED_EMAILS`、`GOOGLE_OAUTH_CLIENT_ID`。

## (C) アラート送信用（FTP データ用スプレッドシートにバインド）

| ファイル | 用途 |
| --- | --- |
| `alert_mailer.gs` | `alerts` シートを監視し、status=new の行をメールで通知して sent に更新 |

Script Properties: `ALERT_TO`（送信先メールアドレス、カンマ区切り）。
WebApp デプロイは不要。時間ベースのトリガー（5分間隔等）で `processNewAlerts` を呼ぶ。

## デプロイ

各ファイル群を該当スプレッドシートの GAS プロジェクトに貼り付け、
**「ウェブアプリ」としてデプロイ**（実行: 自分、アクセス: 全員）。

詳細は [`docs/04_gas_setup.md`](../docs/04_gas_setup.md)。
