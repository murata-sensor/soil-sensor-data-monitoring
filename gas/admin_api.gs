/**
 * Admin API (Registry spreadsheet) — used by the SPA admin panel to read
 * and replace registry sheets after verifying the caller's Google ID token.
 *
 * POST JSON:
 *   { idToken: "...", action: "putRows",
 *     sheet: "sources",
 *     rows: [["sourceId","displayName","schemaType",...], ["src-001","A圃場","m5stack",...]] }
 *
 * Actions:
 *   "putRows"   — clear sheet then write all given rows (header + data)
 *   "getSheet"  — read all rows of sheet
 *
 * The caller's email (from ID token) must be in ADMIN_ALLOWED_EMAILS Script Property.
 */

const ADMIN_SHEETS = ['sources', 'users', 'acl', 'theme', 'events'];

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const email = _adminVerifyIdToken(body.idToken);
    const allowed = (PropertiesService.getScriptProperties()
      .getProperty('ADMIN_ALLOWED_EMAILS') || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!allowed.includes(email.toLowerCase())) {
      return _adminJson({ ok: false, error: 'forbidden' });
    }
    const sheet = String(body.sheet || '');
    if (!ADMIN_SHEETS.includes(sheet)) {
      return _adminJson({ ok: false, error: 'sheet not allowed' });
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(sheet) || ss.insertSheet(sheet);

    if (body.action === 'getSheet') {
      return _adminJson({ ok: true, values: sh.getDataRange().getValues() });
    }
    if (body.action === 'putRows') {
      const rows = body.rows || [];
      sh.clearContents();
      if (rows.length) {
        const width = Math.max.apply(null, rows.map((r) => r.length));
        const padded = rows.map((r) => {
          const out = r.slice();
          while (out.length < width) out.push('');
          return out;
        });
        sh.getRange(1, 1, padded.length, width).setValues(padded);
      }
      return _adminJson({ ok: true, written: rows.length });
    }
    return _adminJson({ ok: false, error: 'unknown action' });
  } catch (err) {
    return _adminJson({ ok: false, error: String(err) });
  }
}

function _adminVerifyIdToken(token) {
  if (!token) throw new Error('idToken required');
  const url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token);
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('invalid idToken');
  const info = JSON.parse(resp.getContentText());
  const aud = PropertiesService.getScriptProperties()
    .getProperty('GOOGLE_OAUTH_CLIENT_ID');
  if (aud && info.aud !== aud) throw new Error('wrong audience');
  if (!info.email_verified) throw new Error('email not verified');
  return info.email;
}

function _adminJson(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
