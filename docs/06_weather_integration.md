# 気象データ統合ガイド (Weather Data Integration Guide)

## 概要

本プロジェクトでは 2 つの気象データ取得経路があります:

| 経路 | 対象 schemaType | データソース | 実装 |
| --- | --- | --- | --- |
| **Open-Meteo** | `remote-ftp` | [Open-Meteo Archive API](https://archive-api.open-meteo.com/) (無料・APIキー不要) | `scripts/ingest_ftp.py` (Python, GitHub Actions) |
| **AMeDAS** | `mechatrax` | 気象庁 10 分値 JSON (公開) | `gas/amedas_fetcher.gs` (GAS, POST受信時に自動) |

取得される気象フィールド:

- **気温** (`air_temp_c`): 外気温（°C）
- **降雨量** (`precip_1h_mm`): 1 時間降水量（mm）
- **日照時間** (`sunshine_1h_h`): 1 時間日照時間（h）

## A. Open-Meteo 経路（remote-ftp 系統）

### 設定方法

GitHub Actions Secrets に以下を登録:

| 変数名 | 説明 | 必須 | 例 |
|--------|------|------|-----|
| `FTP_SITE_LATITUDE` | 圃場の緯度 | ✗（未設定で気象取得スキップ） | `38.4` |
| `FTP_SITE_LONGITUDE` | 圃場の経度 | ✗ | `140.9` |

**重要**: 座標は PII（個人識別情報）に該当します。GitHub Actions Secrets で管理し、リポジトリにコミットしないでください。

### 動作

1. FTP からセンサー CSV ファイルをダウンロード
2. Open-Meteo API から当該日付の気象データを取得（hourly: temperature_2m, precipitation, sunshine_duration）
3. センサーのタイムスタンプに最も近い時間帯の気象値をマージ
4. Google Sheets に保存（`air_temp`, `precip_1h`, `sunshine_1h` 列）

座標が未提供の場合は気象データ取得をスキップし、気象列は空のまま保存（エラーにはならない）。

## B. AMeDAS 経路（mechatrax 系統）

### 動作

Mechatrax デバイスが POST 時に送信する `latitude` / `longitude` を使い、
`gas/amedas_fetcher.gs` が最寄りの AMeDAS 観測点を検索して気象データを自動付与します。

- 書き込み先: スプレッドシートの AC〜AE 列（外気温 / 1h降水量 / 1h日照時間）
- キャッシュ: AMeDAS 観測点テーブルを 6 時間キャッシュ（GAS CacheService）
- フォールバック: 取得失敗時は該当列を空欄にし、書き込み自体は継続

### 設定

特別な設定は不要。`gas/mechatrax_receiver.gs` と `gas/amedas_fetcher.gs` を同じ GAS プロジェクトに配置するだけで動作します。
詳細は [`04_gas_setup.md`](04_gas_setup.md) セクション A' を参照。

## データスキーマ

### 正規化モデル（共通）

```python
@dataclass
class NormalizedRow:
    ...
    air_temp_c: float | None = None
    precip_1h_mm: float | None = None
    sunshine_1h_h: float | None = None
```

### Google Sheets 列（remote-ftp: `sensor_raw` / `sensor_9am`）

```
date | addr | number | battery1 | battery2 | bulk_ec | vwc | soil_temp | air_temp | precip_1h | sunshine_1h
```

### Google Sheets 列（mechatrax: AC〜AE）

```
AC: 外気温 | AD: 1hの降水量 | AE: 1hの日照時間
```

## トラブルシューティング

### 天気データが NULL のままです（Open-Meteo）

1. **座標が正しいか確認**
   - `FTP_SITE_LATITUDE` と `FTP_SITE_LONGITUDE` が Secrets に設定されているか
   - 座標は有効な緯度・経度値か（日本: 緯度 24〜46、経度 122〜154）

2. **API 接続を確認**
   - Open-Meteo API は無料で公開されていますが、アーカイブデータは約 2 ヶ月前までしかない場合あり
   - ファイアウォール / プロキシ の設定を確認

3. **ログを確認**
   - GitHub Actions ログで「weather」を検索
   - エラーメッセージがあれば詳細を確認

### AMeDAS データが空欄です（Mechatrax）

1. POST ボディに `latitude` / `longitude` が含まれているか確認
2. GAS の実行ログ（Apps Script エディタ → 実行数）でエラーを確認
3. AMeDAS の観測点データは 6 時間キャッシュされる。新しい観測点追加直後はキャッシュ切れを待つ

## 例

### GitHub Actions Workflow 設定例

```yaml
name: FTP Ingest with Weather

on:
  schedule:
    - cron: '0 12 * * *'  # Daily at 12:00 UTC (21:00 JST)

jobs:
  ingest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      
      - name: Install dependencies
        run: pip install -r scripts/requirements.txt
      
      - name: Run FTP ingest with weather
        env:
          FTP_HOST: ${{ secrets.FTP_HOST }}
          FTP_USER: ${{ secrets.FTP_USER }}
          FTP_PASS: ${{ secrets.FTP_PASS }}
          FTP_DIR: ${{ secrets.FTP_DIR }}
          FTP_SPREADSHEET_ID: ${{ secrets.FTP_SPREADSHEET_ID }}
          GOOGLE_SERVICE_ACCOUNT_JSON: ${{ secrets.GOOGLE_SERVICE_ACCOUNT_JSON }}
          INGEST_FILTER_START: ${{ secrets.INGEST_FILTER_START }}
          FTP_SITE_LATITUDE: ${{ secrets.FTP_SITE_LATITUDE }}
          FTP_SITE_LONGITUDE: ${{ secrets.FTP_SITE_LONGITUDE }}
        run: python -m scripts.ingest_ftp
```

## 参考: AMeDAS データソース（Mechatrax 用）

`gas/amedas_fetcher.gs` が使用する JMA 公開エンドポイント:

- 最新時刻: `https://www.jma.go.jp/bosai/amedas/data/latest_time.txt`
- 観測点マップ: `https://www.jma.go.jp/bosai/amedas/data/map/yyyymmddHHmm00.json`

取得項目: `temp`（気温）, `precipitation1h`（1時間降水量）, `sun1h`（1時間日照時間）

最寄り観測点の検索はユークリッド距離（緯度・経度の差分）で行い、品質フラグが正常な値のみ使用。
