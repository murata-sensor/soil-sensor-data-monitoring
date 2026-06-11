# 気象データ統合ガイド (Weather Data Integration Guide)

## 概要

FTPインジェストプロセスで現地圃場の気象情報（気温、降雨量など）を自動的に取得して、センサーデータと一緒に保存できます。

## 機能

- **気温** (air_temp_c): 日中最高気温（°C）
- **降雨量** (precip_1h_mm): 1日の降水量（mm）
- **日照時間** (sunshine_1h_h): 日中日照時間（時間）
  
> 注: 現在、Open-Meteo API から気温と降水量を取得します。日照時間は API から取得できないため、フロントエンド側で補うことができます。

## 設定方法

### GitHub Actions Secrets に設定する

FTP インジェストのワークフローに以下の環境変数を追加してください：

```yaml
env:
  FTP_SITE_LATITUDE: "37.7749"      # 圃場の緯度
  FTP_SITE_LONGITUDE: "122.4194"    # 圃場の経度
```

**重要**: 座標は PII（個人識別情報）であり、本リポジトリに直接置くことは禁止されています。
GitHub Actions Secrets（または環境変数として設定）を使用してください。

### 環境変数

| 変数名 | 説明 | 必須 | 例 |
|--------|------|------|-----|
| `FTP_SITE_LATITUDE` | 圃場の緯度 | ✗ | `37.7749` |
| `FTP_SITE_LONGITUDE` | 圃場の経度 | ✗ | `122.4194` |

## 動作

### 有効時（座標が提供されている）

1. **データ取得**
   - FTP からセンサー CSV ファイルをダウンロード
   - Open-Meteo API から当該日付の気象データを取得
   - センサーデータと気象データをマージ

2. **マージルール**
   - センサーのタイムスタンプから日付（YYYY-MM-DD）を抽出
   - その日付に対応する気象データを結合
   - 気象データは 1 行 / 1 日 なので、1 日のすべてのセンサー行に同じ気象値が入ります

3. **Google Sheets に保存**
   - `sensor_raw` シートに新しい列を追加：
     - `air_temp`: 気温（°C）
     - `precip_1h`: 降雨量（mm）
     - `sunshine_1h`: 日照時間（h）

### 無効時（座標が未提供）

- 座標が提供されていない場合、気象データ取得はスキップ
- 気象列は空（NULL）で保存
- エラーは発生しません（graceful degradation）

## データソース

**Open-Meteo API** (free, no API key required)
- https://archive-api.open-meteo.com/
- 多数の気象パラメータが利用可能
- 日本全国対応

## データスキーマ

### Google Sheets `sensor_raw` / `sensor_9am` シート

新しい列が追加されました：

```
date | siteId | addr | number | battery1 | battery2 | bulk_ec | vwc | soil_temp | air_temp | precip_1h | sunshine_1h
```

| 列名 | 型 | 説明 |
|------|-----|------|
| `air_temp` | float? | 気温（°C）|
| `precip_1h` | float? | 降雨量（mm）|
| `sunshine_1h` | float? | 日照時間（h）|

### フロントエンド NormalizedRow

正規化モデル（`scripts/adapters/normalized.py`）も更新されました：

```python
@dataclass
class NormalizedRow:
    ...
    air_temp_c: float | None = None
    precip_1h_mm: float | None = None
    sunshine_1h_h: float | None = None
```

## トラブルシューティング

### 天気データが NULL のままです

1. **座標が正しいか確認**
   - `FTP_SITE_LATITUDE` と `FTP_SITE_LONGITUDE` が正しく設定されているか
   - 座標は有効な緯度・経度値か（例: 37.7749, 122.4194）

2. **API 接続を確認**
   - Open-Meteo API は無料で公開されています
   - ファイアウォール / プロキシ の設定を確認

3. **ログを確認**
   - GitHub Actions ログで「Fetching weather data」を検索
   - 「Failed to fetch weather data」エラーメッセージがあれば詳細を確認

### 日照時間が常に NULL です

Open-Meteo Archive API では日照時間データが利用できません。
フロントエンド側で日照計算を行うか、別途 API（例: NASA POWER）を使用してください。

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
          INGEST_FILTER_START: '2026-06-01T00:00+09:00'
          SITE_ID: 'site-a'
          FTP_SITE_LATITUDE: ${{ secrets.FTP_SITE_LATITUDE }}
          FTP_SITE_LONGITUDE: ${{ secrets.FTP_SITE_LONGITUDE }}
        run: python -m scripts.ingest_ftp
```

## 技術詳細

### 気象データのマージ方法

```python
# センサー時刻から日付を抽出
df['_date'] = pd.to_datetime(df['date']).dt.strftime('%Y-%m-%d')

# 気象データ（日付インデックス）とマージ
df = df.merge(weather_df, left_on='_date', right_index=True, how='left')
```

### Open-Meteo API 呼び出し

```python
url = (
    "https://archive-api.open-meteo.com/v1/archive"
    f"?latitude={lat}&longitude={lon}"
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum"
    "&timezone=Asia%2FTokyo"
    f"&start_date={start_date}&end_date={end_date}"
)
```

## 将来の拡張

- [ ] Forecast API との統合（将来の気象予報）
- [ ] 複数の気象 API サポート（AWS、Google Cloud など）
- [ ] 時間単位の気象データ取得（日単位から）
- [ ] GUI での座標設定（レジストリシート経由）
