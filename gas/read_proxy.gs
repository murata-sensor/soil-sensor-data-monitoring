/**
 * Read-proxy WebApp (SPEC §6, accessMode=proxy).
 *
 * Deploy in a dedicated GAS project, separate from admin_api.gs.
 * For standalone projects, set REGISTRY_SPREADSHEET_ID in Script Properties.
 * The frontend POSTs
 *   { idToken, sourceId }
 * and the proxy:
 *   1. Verifies the caller's Google ID token (and ADMIN_ALLOWED_EMAILS-style ACL,
 *      but checked against the registry `acl` sheet).
 *   2. Looks up the source row from the registry `sources` sheet.
 *   3. Reads the target spreadsheet with the GAS owner's permissions.
 *   4. Returns only allowed tabs and display columns for normalization.
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

function _proxyEnabled(value) {
  return /^(true|1|yes|y)$/i.test(String(value === undefined ? '' : value).trim());
}

function _proxyRegistrySpreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty('REGISTRY_SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function _proxyAllowedSheets(src) {
  const names = [String(src.sheetName || '').trim(), 'events'];
  if (src.schemaType === 'remote-ftp') names.push('sensor_raw', 'sensor_9am');
  if (src.allowedSheetNames) {
    const extra = JSON.parse(src.allowedSheetNames);
    if (!Array.isArray(extra) || extra.some((name) => typeof name !== 'string' || !name.trim())) {
      throw new Error('invalid allowedSheetNames');
    }
    names.push.apply(names, extra.map((name) => name.trim()));
  }
  return Array.from(new Set(names.filter(Boolean)));
}

function _proxyDisplayValues(values, schemaType, isEvents) {
  if (!values.length) return [];
  const common = ['Date', 'SerialNumber', 'Battery(V)', 'Temperature(degC)', 'VWC(%)',
    'VWC Coconut Peat(%)', 'VWC Rock Wool(%)', 'EC bulk(dS/m)', 'EC pore(dS/m)', 'EC pore Coco(dS/m)'];
  const columns = {
    'm5stack': common.concat(['Error flag', 'WiFi RSI(dBm)']),
    'pc-serial': common,
    'mechatrax': ['Date', 'SerialNumber', 'Battery\u6b8b\u91cf(%)', 'Battery_percentage(%)',
      'Battery_voltage(mV)', 'Temperature(degC)', 'VWC(%)', 'VWC_coco(%)', 'VWC_rock(%)',
      'EC bulk(dS/m)', 'EC_pore(dS/m)', 'EC_porecoco(dS/m)',
      '\u5916\u6c17\u6e29', '1h\u306e\u964d\u6c34\u91cf', '1h\u306e\u65e5\u7167\u6642\u9593',
      'locTemp', 'locPrec', 'locSun'],
    'remote-ftp': ['date', 'addr', 'number', 'battery1', 'battery1[V]', 'battery2', 'battery2[V]',
      'bulk_ec', 'bulk_ec[dS/m]', 'vwc', 'vwc[%]', 'soil_temp', 'soil_temp[\u2103]',
      'air_temp', 'air_tmp', 'air_tmp[\u2103]', 'air_temp[\u2103]',
      'precip_1h', 'precip_1h[mm]', 'sunshine_1h', 'sunshine_1h[h]'],
  };
  const allowed = new Set(isEvents
    ? ['date', 'label', 'color', 'deviceId', 'enabled', 'oldDeviceId', 'newDeviceId']
    : columns[schemaType] || []);
  const indexes = [];
  values[0].forEach((header, index) => {
    const name = String(header).trim().replace(/\uFF08/g, '(').replace(/\uFF09/g, ')');
    if (allowed.has(name)) indexes.push(index);
  });
  return indexes.length ? values.map((row) => indexes.map((index) => {
    const cell = row[index];
    return cell === null || cell === undefined ? '' : String(cell);
  })) : [];
}

function doPost(e) {
  try {
    const contents = (e && e.postData && e.postData.contents) || '{}';
    if (contents.length > 16384) return _proxyJson({ ok: false, error: 'request too large' });
    const body = JSON.parse(contents);
    const email = _proxyVerifyIdToken(body.idToken);

    // Registry read action: return registry sheets for the authenticated user.
    if (body.action === 'registry') {
      return _handleRegistryRead(email);
    }

    // Default: source data read.
    const sourceId = String(body.sourceId || '').trim();
    if (!sourceId) return _proxyJson({ ok: false, error: 'missing sourceId' });

    const ss = _proxyRegistrySpreadsheet();
    const sourceRows = _proxySheetAsObjects(ss, PROXY_SOURCES_SHEET);
    if (!_proxyAuthorize(ss, email, sourceId, sourceRows)) {
      return _proxyJson({ ok: false, error: 'forbidden' });
    }
    const src = _proxyFindSource(ss, sourceId, sourceRows);
    if (!src) return _proxyJson({ ok: false, error: 'unknown sourceId' });

    const remote = SpreadsheetApp.openById(src.spreadsheetId);
    const allowedSheets = _proxyAllowedSheets(src).filter((name) => name === String(src.sheetName).trim()
      || !sourceRows.some((other) => other.spreadsheetId === src.spreadsheetId
        && String(other.sheetName).trim() === name
        && (!_proxyEnabled(other.enabled) || !_proxyAuthorize(ss, email, other.sourceId, sourceRows))));
    if (body.action === 'sheetNames') {
      return _proxyJson({ ok: true, names: allowedSheets.filter((name) =>
        name !== 'events' && !!remote.getSheetByName(name)) });
    }
    const sheetName = body.sheetName ? String(body.sheetName).trim() : String(src.sheetName).trim();
    if (!allowedSheets.includes(sheetName)) return _proxyJson({ ok: false, error: 'forbidden' });
    const sh = remote.getSheetByName(sheetName);
    if (!sh) return _proxyJson({ ok: false, error: 'sheetName not found' });
    const headerRow = sheetName === String(src.sheetName).trim() ? Math.max(1, Number(src.headerRow) || 1) : 1;
    const last = sh.getLastRow();
    if (last < headerRow) return _proxyJson({ ok: true, values: [] });
    const values = sh.getRange(headerRow, 1, last - headerRow + 1, sh.getLastColumn())
      .getValues();
    return _proxyJson({ ok: true, values: _proxyDisplayValues(values, src.schemaType, sheetName === 'events') });
  } catch (err) {
    return _proxyJson({ ok: false, error: 'request denied' });
  }
}

/**
 * Registry read: admins receive settings; viewers receive only their own scope.
 */
function _handleRegistryRead(email) {
  const ss = _proxyRegistrySpreadsheet();

  // Verify user is registered and enabled
  const me = _proxyFindUser(ss, email);
  if (!me || !_proxyEnabled(me.enabled)) {
    return _proxyJson({ ok: false, error: 'user_not_registered' });
  }

  const role = String(me.role || '').trim().toLowerCase();
  if (role !== 'admin' && role !== 'viewer') return _proxyJson({ ok: false, error: 'forbidden' });
  if (role === 'viewer') {
    const sourceRows = _proxySheetAsObjects(ss, PROXY_SOURCES_SHEET);
    const sources = sourceRows
      .filter((src) => _proxyEnabled(src.enabled) && _proxyAuthorize(ss, email, src.sourceId, sourceRows));
    const sourceIds = new Set(sources.map((src) => _proxyNormalizeSourceId(src.sourceId)));
    const acl = _proxySheetAsObjects(ss, PROXY_ACL_SHEET).filter((entry) =>
      _proxyNormalizeEmail(entry.email) === email
      && (_proxyNormalizeSourceId(entry.sourceId) === '*' || sourceIds.has(_proxyNormalizeSourceId(entry.sourceId))));
    const layouts = _proxySheetAsObjects(ss, 'layouts')
      .map((layout) => ({ ...layout, json: layout.json || layout.config }))
      .filter((layout) => {
        try {
          const sourceId = _proxyNormalizeSourceId(layout.sourceId);
          return sourceIds.has(sourceId) && _proxyNormalizeSourceId(JSON.parse(layout.json).sourceId) === sourceId;
        } catch (err) {
          return false;
        }
      });
    return _proxyJson({
      ok: true,
      sources: _proxyProjectRows(sources, ['sourceId', 'displayName', 'schemaType', 'spreadsheetId',
        'sheetName', 'headerRow', 'siteId', 'tz', 'accessMode', 'enabled']),
      users: _proxyProjectRows([me], ['email', 'role', 'enabled']),
      acl: _proxyProjectRows(acl, ['email', 'sourceId', 'permission']),
      theme: _proxySheetValues(ss, 'theme'),
      layouts: _proxyProjectRows(layouts, ['sourceId', 'json', 'year']),
    });
  }
  const result = {
    ok: true,
    sources: _proxySheetValues(ss, 'sources'),
    users: _proxySheetValues(ss, 'users'),
    acl: _proxySheetValues(ss, 'acl'),
    theme: _proxySheetValues(ss, 'theme'),
    layouts: _proxySheetValues(ss, 'layouts'),
  };
  return _proxyJson(result);
}

function _proxyProjectRows(rows, fields) {
  return [fields].concat(rows.map((row) => fields.map((field) =>
    row[field] === null || row[field] === undefined ? '' : String(row[field]))));
}

/** Returns sheet data as string[][] (header + rows), same format as Sheets API values. */
function _proxySheetValues(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) return [];
  const last = sh.getLastRow();
  if (last < 1) return [];
  return sh.getRange(1, 1, last, sh.getLastColumn())
    .getValues()
    .map((row) => row.map((c) => (c === null || c === undefined) ? '' : String(c)));
}

function _proxyVerifyIdToken(token) {
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
  return _proxyNormalizeEmail(info.email);
}

function _proxyAuthorize(ss, email, sourceId, sourceRows) {
  const normalizedEmail = _proxyNormalizeEmail(email);
  const normalizedSourceId = _proxyNormalizeSourceId(sourceId);
  // user enabled?
  const user = _proxyFindUser(ss, normalizedEmail);
  if (!user) return false;
  if (!_proxyEnabled(user.enabled)) return false;
  const role = String(user.role || '').trim().toLowerCase();
  if (role !== 'admin' && role !== 'viewer') return false;
  if (!_proxyFindSource(ss, normalizedSourceId, sourceRows)) return false;
  if (role === 'admin') return true;
  const acl = _proxySheetAsObjects(ss, PROXY_ACL_SHEET);
  return acl.some((a) =>
    _proxyNormalizeEmail(a.email) === normalizedEmail
    && (_proxyNormalizeSourceId(a.sourceId) === '*' || _proxyNormalizeSourceId(a.sourceId) === normalizedSourceId)
  );
}

function _proxyFindUser(ss, email) {
  const sh = ss.getSheetByName(PROXY_USERS_SHEET);
  if (!sh) return null;
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return null;
  const header = values[0];
  if (['email', 'role', 'enabled'].some((field) =>
    header.filter((value) => value === field).length !== 1)) return null;
  const users = values.slice(1).filter((row) =>
    _proxyNormalizeEmail(row[header.indexOf('email')]) === _proxyNormalizeEmail(email));
  if (users.length !== 1) return null;
  return {
    email: users[0][header.indexOf('email')],
    role: users[0][header.indexOf('role')],
    enabled: users[0][header.indexOf('enabled')],
  };
}

function _proxyFindSource(ss, sourceId, sourceRows) {
  const normalizedSourceId = _proxyNormalizeSourceId(sourceId);
  const matches = (sourceRows || _proxySheetAsObjects(ss, PROXY_SOURCES_SHEET))
    .filter((r) => _proxyNormalizeSourceId(r.sourceId) === normalizedSourceId);
  if (matches.length !== 1) return null;
  const src = matches[0];
  if (!_proxyEnabled(src.enabled)) return null;
  return src;
}

function _proxySheetAsObjects(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) return [];
  const values = sh.getDataRange().getValues();
  const header = values[0] || [];
  const required = name === PROXY_SOURCES_SHEET
    ? ['sourceId', 'spreadsheetId', 'sheetName', 'enabled', 'schemaType']
    : name === PROXY_ACL_SHEET ? ['email', 'sourceId'] : [];
  const optional = name === PROXY_SOURCES_SHEET ? ['headerRow', 'allowedSheetNames'] : [];
  if (required.some((field) => header.filter((value) => value === field).length !== 1)
      || optional.some((field) => header.filter((value) => value === field).length > 1)) {
    throw new Error('ambiguous registry columns');
  }
  if (values.length < 2) return [];
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
