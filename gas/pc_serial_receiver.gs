/**
 * PC serial logger -> GAS WebApp receiver (SPEC §4.2 pc-serial).
 *
 * Receives measurements from a PC running the soil-sensor-samples-python
 * examples (`continuous_log.py --upload-url ...`), which read SLT5005-SLT5009
 * sensors over RS-232C / RS-485 / SDI-12.
 *
 * POST JSON — one row:
 *   {
 *     token: "<INGEST_TOKEN>",          // required, matches Script Property
 *     serialNumber: "24107928",         // required
 *     ts: "2026-07-31T14:30:00+09:00",  // optional, defaults to now
 *     battery_v: 3.31,
 *     temperature_c: 21.5,
 *     vwc_pct: 45.2,
 *     vwc_coco_pct: 44.1,
 *     vwc_rock_pct: 43.8,
 *     ec_bulk_dsm: 0.51,
 *     ec_pore_dsm: 1.82,
 *     ec_pore_coco_dsm: 1.75
 *   }
 *
 * POST JSON — several sensors measured at the same time:
 *   { token: "...", rows: [ { ...as above... }, { ... } ] }
 *
 * Sensors are told apart by `serialNumber`, so one bus (and one sheet) can
 * carry several sensors.
 *
 * Appended to the sheet name set by `PC_SERIAL_TARGET_SHEET` Script Property
 * (default: `soil_sensor`), creating header row A-J on first write.
 */

const PC_SERIAL_HEADER = [
  'Date', 'SerialNumber', 'Battery(V)', 'Temperature(degC)',
  'VWC(%)', 'VWC Coconut Peat(%)', 'VWC Rock Wool(%)',
  'EC bulk(dS/m)', 'EC pore(dS/m)', 'EC pore Coco(dS/m)',
];

/** Keeps one request inside the GAS execution time limit. */
const PC_SERIAL_MAX_ROWS = 500;

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const props = PropertiesService.getScriptProperties();
    const expected = props.getProperty('INGEST_TOKEN');
    if (!expected || body.token !== expected) {
      return _pcSerialJson({ ok: false, error: 'unauthorized' });
    }

    const input = Array.isArray(body.rows) ? body.rows : [body];
    if (input.length === 0) return _pcSerialJson({ ok: true, written: 0 });
    if (input.length > PC_SERIAL_MAX_ROWS) {
      return _pcSerialJson({ ok: false, error: 'too many rows' });
    }

    const values = [];
    for (let i = 0; i < input.length; i++) {
      const row = input[i] || {};
      if (!row.serialNumber) {
        return _pcSerialJson({ ok: false, error: 'missing field: serialNumber' });
      }
      const ts = row.ts ? new Date(row.ts) : new Date();
      if (isNaN(ts.getTime())) return _pcSerialJson({ ok: false, error: 'invalid ts' });
      values.push([
        Utilities.formatDate(ts, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'),
        String(row.serialNumber),
        _pcSerialNum(row.battery_v),
        _pcSerialNum(row.temperature_c),
        _pcSerialNum(row.vwc_pct),
        _pcSerialNum(row.vwc_coco_pct),
        _pcSerialNum(row.vwc_rock_pct),
        _pcSerialNum(row.ec_bulk_dsm),
        _pcSerialNum(row.ec_pore_dsm),
        _pcSerialNum(row.ec_pore_coco_dsm),
      ]);
    }

    const sheetName = props.getProperty('PC_SERIAL_TARGET_SHEET') || 'soil_sensor';
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
    if (sh.getLastRow() === 0) sh.appendRow(PC_SERIAL_HEADER);
    // One setValues call keeps a multi-sensor batch to a single write.
    sh.getRange(sh.getLastRow() + 1, 1, values.length, PC_SERIAL_HEADER.length)
      .setValues(values);
    _pcSerialExtendFilter(sh);
    return _pcSerialJson({ ok: true, written: values.length });
  } catch (err) {
    return _pcSerialJson({ ok: false, error: String(err) });
  }
}

/**
 * Extends (or creates) the BasicFilter on `sh` to cover all data rows.
 * Called after every write so newly-added rows are always filtered.
 */
function _pcSerialExtendFilter(sh) {
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return;
  const fullRange = sh.getRange(1, 1, lastRow, lastCol);
  const existing = sh.getFilter();
  if (existing) {
    existing.remove();
  }
  fullRange.createFilter();
}

function _pcSerialNum(v) {
  if (v === undefined || v === null || v === '') return '';
  const n = Number(v);
  return isNaN(n) ? '' : n;
}

function _pcSerialJson(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
