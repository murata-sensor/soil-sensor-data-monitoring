/**
 * M5Stack -> GAS WebApp receiver (SPEC §4.2 m5stack).
 *
 * POST JSON:
 *   {
 *     token: "<INGEST_TOKEN>",          // required, matches Script Property
 *     serialNumber: "24026902",         // required
 *     ts: "2026-01-08T10:08:27+09:00",  // optional, defaults to now
 *     deviceTs: "2026-01-08T10:08",     // optional ("Date from M5Stack")
 *     battery_v: 4.83,
 *     temperature_c: 21.31,
 *     vwc_pct: 0.0,
 *     vwc_coco_pct: 0.1,
 *     vwc_rock_pct: 0.1,
 *     ec_bulk_dsm: 0.008,
 *     ec_pore_dsm: 0,
 *     ec_pore_coco_dsm: 65.5,
 *     error_flag: 0,
 *     rssi_dbm: -79
 *   }
 *
 * Appended to the sheet name set by `M5_TARGET_SHEET` Script Property
 * (default: `soil_sensor`), creating header row A-M on first write.
 */

const M5_HEADER = [
  'Date', 'SerialNumber', 'Date from M5Stack', 'Battery(V)',
  'Temperature(degC)', 'VWC(%)', 'VWC Coconut Peat(%)', 'VWC Rock Wool(%)',
  'EC bulk(dS/m)', 'EC pore(dS/m)', 'EC pore Coco(dS/m)',
  'Error flag', 'WiFi RSI(dBm)',
];

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const props = PropertiesService.getScriptProperties();
    const expected = props.getProperty('INGEST_TOKEN');
    if (!expected || body.token !== expected) {
      return _m5Json({ ok: false, error: 'unauthorized' });
    }
    if (!body.serialNumber) {
      return _m5Json({ ok: false, error: 'missing field: serialNumber' });
    }
    const tsRaw = body.ts ? new Date(body.ts) : new Date();
    if (isNaN(tsRaw.getTime())) return _m5Json({ ok: false, error: 'invalid ts' });
    const date = Utilities.formatDate(tsRaw, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    const deviceTs = body.deviceTs
      ? String(body.deviceTs)
      : Utilities.formatDate(tsRaw, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');

    const row = [
      date,
      String(body.serialNumber),
      deviceTs,
      _num(body.battery_v),
      _num(body.temperature_c),
      _num(body.vwc_pct),
      _num(body.vwc_coco_pct),
      _num(body.vwc_rock_pct),
      _num(body.ec_bulk_dsm),
      _num(body.ec_pore_dsm),
      _num(body.ec_pore_coco_dsm),
      _num(body.error_flag),
      _num(body.rssi_dbm),
    ];

    const sheetName = props.getProperty('M5_TARGET_SHEET') || 'soil_sensor';
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
    if (sh.getLastRow() === 0) sh.appendRow(M5_HEADER);
    sh.appendRow(row);
    return _m5Json({ ok: true });
  } catch (err) {
    return _m5Json({ ok: false, error: String(err) });
  }
}

function _num(v) {
  if (v === undefined || v === null || v === '') return '';
  const n = Number(v);
  return isNaN(n) ? '' : n;
}

function _m5Json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
