/**
 * Read-proxy WebApp (SPEC §6, accessMode=proxy).
 *
 * Deploy on the REGISTRY spreadsheet's GAS project. The frontend POSTs
 *   { idToken, sourceId }
 * and the proxy:
 *   1. Verifies the caller's Google ID token (and ADMIN_ALLOWED_EMAILS-style ACL,
 *      but checked against the registry `acl` sheet).
 *   2. Looks up the source row from the registry `sources` sheet.
 *   3. Reads the target spreadsheet with the GAS owner's permissions.
 *   4. Returns the raw `values` array (header + data) for the frontend
 *      adapter to normalize.
 */

const PROXY_SOURCES_SHEET = 'sources';
const PROXY_ACL_SHEET = 'acl';
const PROXY_USERS_SHEET = 'users';

function _proxyNormalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function _proxyNormalizeSourceId(value) {
  return String(value || '').trim().toLowerCase();
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const email = _proxyVerifyIdToken(body.idToken);
    const sourceId = String(body.sourceId || '').trim();
    if (!sourceId) return _proxyJson({ ok: false, error: 'missing sourceId' });

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!_proxyAuthorize(ss, email, sourceId)) {
      return _proxyJson({ ok: false, error: 'forbidden' });
    }
    const src = _proxyFindSource(ss, sourceId);
    if (!src) return _proxyJson({ ok: false, error: 'unknown sourceId' });

    const remote = SpreadsheetApp.openById(src.spreadsheetId);
    const sh = remote.getSheetByName(src.sheetName);
    if (!sh) return _proxyJson({ ok: false, error: 'sheetName not found' });
    // headerRow downwards
    const headerRow = Number(src.headerRow) || 1;
    const last = sh.getLastRow();
    if (last < headerRow) return _proxyJson({ ok: true, values: [] });
    const values = sh.getRange(headerRow, 1, last - headerRow + 1, sh.getLastColumn())
      .getValues()
      .map((row) => row.map((c) => (c === null || c === undefined) ? '' : String(c)));
    return _proxyJson({ ok: true, values: values });
  } catch (err) {
    return _proxyJson({ ok: false, error: String(err) });
  }
}

function _proxyVerifyIdToken(token) {
  if (!token) throw new Error('idToken required');
  const url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token);
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('invalid idToken');
  const info = JSON.parse(resp.getContentText());
  const aud = PropertiesService.getScriptProperties().getProperty('GOOGLE_OAUTH_CLIENT_ID');
  if (aud && info.aud !== aud) throw new Error('wrong audience');
  if (!info.email_verified) throw new Error('email not verified');
  return _proxyNormalizeEmail(info.email);
}

function _proxyAuthorize(ss, email, sourceId) {
  const normalizedEmail = _proxyNormalizeEmail(email);
  const normalizedSourceId = _proxyNormalizeSourceId(sourceId);
  // user enabled?
  const users = _proxySheetAsObjects(ss, PROXY_USERS_SHEET);
  const user = users.find((u) => _proxyNormalizeEmail(u.email) === normalizedEmail);
  if (!user) return false;
  if (String(user.enabled).toUpperCase() === 'FALSE') return false;
  if (String(user.role || '').toLowerCase() === 'admin') return true;
  const acl = _proxySheetAsObjects(ss, PROXY_ACL_SHEET);
  return acl.some((a) =>
    _proxyNormalizeEmail(a.email) === normalizedEmail
    && (_proxyNormalizeSourceId(a.sourceId) === '*' || _proxyNormalizeSourceId(a.sourceId) === normalizedSourceId)
  );
}

function _proxyFindSource(ss, sourceId) {
  const normalizedSourceId = _proxyNormalizeSourceId(sourceId);
  const src = _proxySheetAsObjects(ss, PROXY_SOURCES_SHEET)
    .find((r) => _proxyNormalizeSourceId(r.sourceId) === normalizedSourceId);
  if (!src) return null;
  if (String(src.enabled).toUpperCase() === 'FALSE') return null;
  return src;
}

function _proxySheetAsObjects(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) return [];
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const header = values[0];
  return values.slice(1).map((row) => {
    const o = {};
    header.forEach((h, i) => { o[h] = row[i]; });
    return o;
  });
}

function _proxyJson(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
