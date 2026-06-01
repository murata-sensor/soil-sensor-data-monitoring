/**
 * AMeDAS (気象庁) lookup helper for mechatrax_receiver.
 *
 * `amedasLookup(lat, lon, when)` returns { airTemp, precip, sunshine } from
 * the nearest active AMeDAS observation point, using the public 10-minute
 * JSON feeds at https://www.jma.go.jp/bosai/amedas/.
 *
 * Notes:
 * - The full table is cached for 6 hours (CacheService) — well within quota.
 * - Returns empty strings on any failure; the caller treats the row as
 *   "no weather available".
 */

const AMEDAS_TABLE_URL = 'https://www.jma.go.jp/bosai/amedas/const/amedastable.json';
const AMEDAS_LATEST_TIME_URL = 'https://www.jma.go.jp/bosai/amedas/data/latest_time.txt';
const AMEDAS_MAP_URL = 'https://www.jma.go.jp/bosai/amedas/data/map/';

function amedasLookup(lat, lon, _when) {
  const table = _amedasTable();
  const id = _nearestStation(table, Number(lat), Number(lon));
  if (!id) return { airTemp: '', precip: '', sunshine: '' };
  const map = _amedasLatestMap();
  const rec = map[id];
  if (!rec) return { airTemp: '', precip: '', sunshine: '' };
  return {
    airTemp: _amedasNum(rec.temp),
    precip:  _amedasNum(rec.precipitation1h),
    sunshine: _amedasNum(rec.sun1h),
  };
}

function _amedasTable() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('amedasTable');
  if (hit) return JSON.parse(hit);
  const resp = UrlFetchApp.fetch(AMEDAS_TABLE_URL, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return {};
  const json = JSON.parse(resp.getContentText());
  cache.put('amedasTable', JSON.stringify(json), 21600);
  return json;
}

function _amedasLatestMap() {
  const tResp = UrlFetchApp.fetch(AMEDAS_LATEST_TIME_URL, { muteHttpExceptions: true });
  if (tResp.getResponseCode() !== 200) return {};
  const stamp = tResp.getContentText().trim();              // e.g. 2026-05-22T12:30:00+09:00
  // The map filename uses yyyymmddHHMM00 in JST.
  const dt = new Date(stamp);
  const key = Utilities.formatDate(dt, 'Asia/Tokyo', 'yyyyMMddHHmm') + '00';
  const url = AMEDAS_MAP_URL + key + '.json';
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return {};
  return JSON.parse(resp.getContentText());
}

function _nearestStation(table, lat, lon) {
  if (!lat && !lon) return null;
  let best = null, bestDist = Infinity;
  for (const id in table) {
    const s = table[id];
    if (!s || !s.lat || !s.lon) continue;
    const slat = (s.lat[0] || 0) + (s.lat[1] || 0) / 60;
    const slon = (s.lon[0] || 0) + (s.lon[1] || 0) / 60;
    const d = (slat - lat) * (slat - lat) + (slon - lon) * (slon - lon);
    if (d < bestDist) { bestDist = d; best = id; }
  }
  return best;
}

function _amedasNum(arr) {
  // AMeDAS JSON encodes values as [value, qualityFlag]; flag !== 0 means invalid.
  if (!arr || arr.length < 2) return '';
  if (arr[1] !== 0) return '';
  const n = Number(arr[0]);
  return isNaN(n) ? '' : n;
}
