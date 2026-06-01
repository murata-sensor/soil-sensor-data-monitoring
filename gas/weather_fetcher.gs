/**
 * Daily weather fetcher (Open-Meteo).
 *
 * Reads sites from `config` (columns: siteId, latitude, longitude, ...)
 * and appends one row per site per day to the `weather` sheet.
 *
 * Schedule: time-based trigger every day at 03:00 Asia/Tokyo
 * (Open-Meteo is free, no API key, UrlFetch quota is plenty.)
 */

const WEATHER_SHEET = 'weather';
const CONFIG_SHEET = 'config';

function dailyWeatherTrigger() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sites = _readConfig(ss);
  if (!sites.length) {
    console.warn('config sheet has no sites');
    return;
  }
  const sh = ss.getSheetByName(WEATHER_SHEET) || ss.insertSheet(WEATHER_SHEET);
  if (sh.getLastRow() === 0) {
    sh.appendRow([
      'date', 'siteId', 't_max', 't_min', 't_mean',
      'precip_sum', 'shortwave_sum', 'rh_mean',
    ]);
  }
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  // yesterday — Open-Meteo "past_days=1" gives a stable observation.
  const start = _shiftDate_(today, -1);
  const end = start;

  for (const s of sites) {
    if (!s.latitude || !s.longitude) continue;
    try {
      const url =
        'https://api.open-meteo.com/v1/forecast'
        + '?latitude=' + encodeURIComponent(s.latitude)
        + '&longitude=' + encodeURIComponent(s.longitude)
        + '&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,'
        + 'precipitation_sum,shortwave_radiation_sum,relative_humidity_2m_mean'
        + '&timezone=Asia%2FTokyo'
        + '&start_date=' + start + '&end_date=' + end;
      const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (resp.getResponseCode() !== 200) {
        console.warn('weather fetch failed', s.siteId, resp.getResponseCode());
        continue;
      }
      const json = JSON.parse(resp.getContentText());
      const d = json.daily || {};
      const rows = (d.time || []).map((date, i) => [
        date, s.siteId,
        _num(d.temperature_2m_max, i), _num(d.temperature_2m_min, i),
        _num(d.temperature_2m_mean, i), _num(d.precipitation_sum, i),
        _num(d.shortwave_radiation_sum, i), _num(d.relative_humidity_2m_mean, i),
      ]);
      rows.forEach((r) => sh.appendRow(r));
    } catch (err) {
      console.error('weather fetch error for', s.siteId, err);
    }
  }
}

function _readConfig(ss) {
  const sh = ss.getSheetByName(CONFIG_SHEET);
  if (!sh) return [];
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const header = values[0];
  return values.slice(1).map((row) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  }).filter((o) => o.siteId);
}

function _num(arr, i) {
  if (!arr || arr[i] === undefined || arr[i] === null) return '';
  return Number(arr[i]);
}

function _shiftDate_(yyyyMmDd, deltaDays) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return Utilities.formatDate(dt, 'UTC', 'yyyy-MM-dd');
}
