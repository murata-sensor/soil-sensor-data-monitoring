/**
 * Mechatrax Raspberry-Pi -> GAS WebApp receiver (SPEC §4.2 mechatrax).
 *
 * Writes a 31-column row matching the existing layout (A-AE). The last
 * three columns (AC/AD/AE) are filled by `amedas_fetcher.gs` using GPS
 * coordinates from column F.
 *
 * POST JSON (all keys optional except `token`, `serialNumber`):
 *   {
 *     token: "...",
 *     ts: "2026-07-18T17:00:43+09:00", deviceTs: "2026-07-18T17:00:26+09:00",
 *     mcc: "440", mnc: "10", areaCode: "25213", cellId: "128176148",
 *     latitude: 34.654, longitude: 134.112, locAccuracy: 4114,
 *     locTemp: 66421, locTempId: "...", locPrec: 66421, locPrecId: "...",
 *     locSun: 66421, locSunId: "...",
 *     serialNumber: "25037029",
 *     batteryCapacityMv: 916, batteryRemainingPct: 36,
 *     batteryCurrentMa: -456, batteryVoltageMv: 6400, batteryTempC: 31,
 *     addr: 0, temperature_c: 34.375,
 *     vwc_pct: 62.6, vwc_coco_pct: 100, vwc_rock_pct: 91,
 *     ec_bulk_dsm: 0.243, ec_pore_dsm: 0.745, ec_pore_coco_dsm: null
 *   }
 */

const MX_HEADER = [
  'Date', 'MCC', 'MNC', 'area code', 'cell id',
  '座標(latitude,longitude)', 'loc_accuracy',
  'locTemp', 'locTemp_id', 'locPrec', 'locPrec_id', 'locSun', 'locSun_id',
  'SerialNumber', 'Date from logger',
  'Battery capacity(mV)', 'Battery残量(%)',
  'Battery_current(mA)', 'Battery_voltage(mV)', 'Battery_temperature(°C)',
  'addr', 'Temperature(degC)',
  'VWC(%)', 'VWC_coco(%)', 'VWC_rock(%)',
  'EC bulk(dS/m)', 'EC_pore(dS/m)', 'EC_porecoco(dS/m)',
  '外気温', '1hの降水量', '1hの日照時間',
];

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const props = PropertiesService.getScriptProperties();
    const expected = props.getProperty('INGEST_TOKEN');
    if (!expected || body.token !== expected) {
      return _mxJson({ ok: false, error: 'unauthorized' });
    }
    if (!body.serialNumber) return _mxJson({ ok: false, error: 'missing field: serialNumber' });

    const tsRaw = body.ts ? new Date(body.ts) : new Date();
    if (isNaN(tsRaw.getTime())) return _mxJson({ ok: false, error: 'invalid ts' });
    const date = Utilities.formatDate(tsRaw, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    const deviceTs = body.deviceTs
      ? String(body.deviceTs)
      : Utilities.formatDate(tsRaw, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');

    const coord = (body.latitude !== undefined && body.longitude !== undefined)
      ? body.latitude + ',' + body.longitude
      : '';

    // AMeDAS lookup (best-effort; never block ingestion).
    let airTemp = '', precip = '', sunshine = '';
    try {
      if (body.latitude !== undefined && body.longitude !== undefined) {
        const w = amedasLookup(body.latitude, body.longitude, tsRaw);
        airTemp = w.airTemp; precip = w.precip; sunshine = w.sunshine;
      }
    } catch (err) {
      console.warn('AMeDAS lookup failed', err);
    }

    const row = [
      date,
      _str(body.mcc), _str(body.mnc), _str(body.areaCode), _str(body.cellId),
      coord, _num(body.locAccuracy),
      _num(body.locTemp), _str(body.locTempId),
      _num(body.locPrec), _str(body.locPrecId),
      _num(body.locSun),  _str(body.locSunId),
      String(body.serialNumber), deviceTs,
      _num(body.batteryCapacityMv), _num(body.batteryRemainingPct),
      _num(body.batteryCurrentMa), _num(body.batteryVoltageMv), _num(body.batteryTempC),
      _num(body.addr), _num(body.temperature_c),
      _num(body.vwc_pct), _num(body.vwc_coco_pct), _num(body.vwc_rock_pct),
      _num(body.ec_bulk_dsm), _num(body.ec_pore_dsm), _num(body.ec_pore_coco_dsm),
      airTemp, precip, sunshine,
    ];

    const sheetName = props.getProperty('MX_TARGET_SHEET') || 'soil_sensor';
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
    if (sh.getLastRow() === 0) sh.appendRow(MX_HEADER);
    sh.appendRow(row);
    return _mxJson({ ok: true });
  } catch (err) {
    return _mxJson({ ok: false, error: String(err) });
  }
}

function _num(v) {
  if (v === undefined || v === null || v === '') return '';
  const n = Number(v);
  return isNaN(n) ? '' : n;
}
function _str(v) { return (v === undefined || v === null) ? '' : String(v); }

function _mxJson(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
