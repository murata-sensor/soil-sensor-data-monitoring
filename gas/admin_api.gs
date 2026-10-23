/**
 * Admin API (Registry spreadsheet) — used by the SPA admin panel to read
 * and replace registry sheets after verifying the caller's Google ID token.
 * Deploy in a dedicated GAS project, separate from read_proxy.gs.
 * For standalone projects, set REGISTRY_SPREADSHEET_ID in Script Properties.
 *
 * POST JSON:
 *   { idToken: "...", action: "putRows",
 *     sheet: "sources", expectedRevision: "<revision from getSheet>",
 *     rows: [["sourceId","displayName","schemaType",...], ["src-001","A圃場","m5stack",...]] }
 *
 * Actions:
 *   "putRows"   — validate and replace all given rows (header + data)
 *   "getSheet"  — read all rows of sheet
 *
 * The caller's email (from ID token) must be in ADMIN_ALLOWED_EMAILS Script Property.
 */

const ADMIN_SHEETS = ['sources', 'users', 'acl', 'theme', 'layouts'];

function _adminRevision(values) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(values))
    .map((value) => (value & 255).toString(16).padStart(2, '0')).join('');
}

function _adminRows(rows) {
  if (!Array.isArray(rows) || rows.length > 5000) throw new Error('invalid rows');
  if (rows.length && (!Array.isArray(rows[0]) || !rows[0].length)) throw new Error('invalid header');
  let cells = 0;
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length > 64) throw new Error('invalid row');
    cells += row.length;
    if (cells > 100000) throw new Error('too many cells');
    return row.map((cell) => {
      if (cell === null) return '';
      if (!['string', 'number', 'boolean'].includes(typeof cell)
          || (typeof cell === 'number' && !Number.isFinite(cell))) throw new Error('invalid cell');
      if (typeof cell !== 'string') return cell;
      if (cell.length > 50000) throw new Error('cell too long');
      return /^\s*[=+@-]/.test(cell) ? "'" + cell : cell;
    });
  });
}

function _adminAllowedEmails() {
  return (PropertiesService.getScriptProperties().getProperty('ADMIN_ALLOWED_EMAILS') || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function _adminIsEnabledAdmin(ss, email) {
  const users = ss.getSheetByName('users');
  if (!users) return false;
  return _adminRowsHaveEnabledAdmin(users.getDataRange().getValues(), email);
}

function _adminRowsHaveEnabledAdmin(values, email) {
  if (!values.length) return false;
  const header = values[0];
  if (['email', 'role', 'enabled'].some((field) =>
    header.filter((value) => value === field).length !== 1)) return false;
  const users = values.slice(1).filter((row) =>
    String(row[header.indexOf('email')] || '').trim().toLowerCase() === email);
  return users.length === 1
    && String(users[0][header.indexOf('role')] || '').trim().toLowerCase() === 'admin'
    && /^(true|1|yes|y)$/i.test(String(users[0][header.indexOf('enabled')] || '').trim());
}

function _adminUserEmailsAreUnique(rows) {
  const emailColumn = rows[0].indexOf('email');
  const emails = rows.slice(1).map((row) => String(row[emailColumn] || '').trim().toLowerCase()).filter(Boolean);
  return new Set(emails).size === emails.length;
}

function _adminRegistryRowsAreValid(sheet, rows) {
  const header = rows[0] || [];
  const required = sheet === 'sources'
    ? ['sourceId', 'spreadsheetId', 'sheetName', 'enabled', 'schemaType'] : ['email', 'sourceId'];
  const optional = sheet === 'sources' ? ['headerRow', 'allowedSheetNames'] : [];
  if (required.some((field) => header.filter((value) => value === field).length !== 1)
      || optional.some((field) => header.filter((value) => value === field).length > 1)) return false;
  if (sheet !== 'sources') return true;
  const sourceIdColumn = header.indexOf('sourceId');
  const ids = rows.slice(1).map((row) => String(row[sourceIdColumn] || '').trim().toLowerCase()).filter(Boolean);
  return new Set(ids).size === ids.length;
}

function doPost(e) {
  try {
    const contents = (e && e.postData && e.postData.contents) || '{}';
    if (contents.length > 1000000) return _adminJson({ ok: false, error: 'request too large' });
    const body = JSON.parse(contents);
    const email = _adminVerifyIdToken(body.idToken);
    const allowed = _adminAllowedEmails();
    if (!allowed.includes(email.toLowerCase())) {
      return _adminJson({ ok: false, error: 'forbidden' });
    }
    const sheet = String(body.sheet || '');
    if (!ADMIN_SHEETS.includes(sheet)) {
      return _adminJson({ ok: false, error: 'sheet not allowed' });
    }
    const registryId = PropertiesService.getScriptProperties().getProperty('REGISTRY_SPREADSHEET_ID');
    const ss = registryId ? SpreadsheetApp.openById(registryId) : SpreadsheetApp.getActiveSpreadsheet();
    if (!_adminIsEnabledAdmin(ss, email)) return _adminJson({ ok: false, error: 'forbidden' });

    if (body.action === 'getSheet') {
      const sh = ss.getSheetByName(sheet);
      const values = sh ? sh.getDataRange().getValues() : [];
      return _adminJson({ ok: true, values: values, revision: _adminRevision(values) });
    }
    if (body.action === 'putRows') {
      const rows = _adminRows(body.rows);
      if (sheet === 'users' && !allowed.some((admin) => _adminRowsHaveEnabledAdmin(rows, admin))) {
        return _adminJson({ ok: false, error: 'admin_required' });
      }
      if (sheet === 'users' && !_adminUserEmailsAreUnique(rows)) {
        return _adminJson({ ok: false, error: 'invalid_users' });
      }
      if (['sources', 'acl'].includes(sheet) && !_adminRegistryRowsAreValid(sheet, rows)) {
        return _adminJson({ ok: false, error: 'invalid_' + sheet });
      }
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(10000)) return _adminJson({ ok: false, error: 'busy; retry later' });
      try {
        const currentAllowed = _adminAllowedEmails();
        if (!currentAllowed.includes(email.toLowerCase()) || !_adminIsEnabledAdmin(ss, email)) {
          return _adminJson({ ok: false, error: 'forbidden' });
        }
        if (sheet === 'users' && !currentAllowed.some((admin) => _adminRowsHaveEnabledAdmin(rows, admin))) {
          return _adminJson({ ok: false, error: 'admin_required' });
        }
        let sh = ss.getSheetByName(sheet);
        const existing = sh ? sh.getDataRange().getValues() : [];
        if (body.expectedRevision !== _adminRevision(existing)) {
          return _adminJson({ ok: false, error: 'conflict' });
        }
        if (!sh) sh = ss.insertSheet(sheet);
        const height = Math.max(sh.getLastRow(), rows.length);
        const width = Math.max(sh.getLastColumn(), ...rows.map((row) => row.length));
        if (height * width > 100000) throw new Error('too many cells');
        if (height && width) {
          const padded = Array.from({ length: height }, (_, index) =>
            Array.from({ length: width }, (_, column) => rows[index]?.[column] ?? ''));
          sh.getRange(1, 1, height, width).setValues(padded);
        }
        SpreadsheetApp.flush();
        return _adminJson({ ok: true, written: rows.length, revision: _adminRevision(sh.getDataRange().getValues()) });
      } finally {
        lock.releaseLock();
      }
    }
    return _adminJson({ ok: false, error: 'unknown action' });
  } catch (err) {
    return _adminJson({ ok: false, error: 'request denied' });
  }
}

function _adminVerifyIdToken(token) {
  if (typeof token !== 'string' || token.length > 8192 || token.trim() !== token
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('invalid idToken');
  const aud = (PropertiesService.getScriptProperties().getProperty('GOOGLE_OAUTH_CLIENT_ID') || '').trim();
  if (!aud) throw new Error('OAuth client not configured');
  const url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token);
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('invalid idToken');
  const info = JSON.parse(resp.getContentText());
  if (info.aud !== aud) throw new Error('wrong audience');
  if (info.email_verified !== true && info.email_verified !== 'true') throw new Error('email not verified');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(info.iss)
      || !Number.isFinite(Number(info.exp)) || Number(info.exp) <= Date.now() / 1000
      || typeof info.email !== 'string' || !info.email.trim()) throw new Error('invalid identity');
  return info.email.trim().toLowerCase();
}

function _adminJson(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
