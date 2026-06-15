/**
 * Alert Mailer — Google Apps Script
 *
 * Watches the "alerts" sheet for rows with status="new", sends a summary
 * email, then marks rows as "sent".
 *
 * Setup:
 *   1. Open the spreadsheet → Extensions → Apps Script
 *   2. Paste this file
 *   3. Set Script Properties:
 *        ALERT_TO = comma-separated recipient emails
 *   4. Add a time-driven trigger:
 *        Function: processNewAlerts
 *        Frequency: every 5 minutes (or as desired)
 *
 * The email is sent from the Google account that owns the Apps Script project.
 * No additional credentials are needed.
 */

const ALERTS_SHEET_NAME = 'alerts';
const STATUS_COL_HEADER = 'status';
const STATUS_NEW = 'new';
const STATUS_SENT = 'sent';

/**
 * Main entry point — called by a time-driven trigger.
 * Finds all rows with status="new", sends a single summary email,
 * then marks them as "sent".
 */
function processNewAlerts() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ALERTS_SHEET_NAME);
  if (!sheet) {
    Logger.log('No "alerts" sheet found; nothing to do.');
    return;
  }

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return; // header only or empty

  const header = data[0].map(function (h) { return String(h).trim().toLowerCase(); });
  const statusIdx = header.indexOf(STATUS_COL_HEADER);
  if (statusIdx < 0) {
    Logger.log('No "status" column found in alerts sheet header.');
    return;
  }

  // Collect rows with status="new"
  const newRows = [];
  const newRowIndices = []; // 1-based sheet row numbers
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][statusIdx]).trim().toLowerCase() === STATUS_NEW) {
      newRows.push(data[i]);
      newRowIndices.push(i + 1); // +1 because data is 0-based but sheet is 1-based
    }
  }

  if (newRows.length === 0) return;

  // Build and send email
  var recipients = _getRecipients();
  if (!recipients) {
    Logger.log('ALERT_TO not configured in Script Properties.');
    return;
  }

  var subject = _buildSubject(newRows, header);
  var body = _buildBody(newRows, header);

  MailApp.sendEmail({
    to: recipients,
    subject: subject,
    body: body
  });
  Logger.log('Sent alert email to ' + recipients + ' (' + newRows.length + ' alerts)');

  // Mark rows as sent
  for (var j = 0; j < newRowIndices.length; j++) {
    sheet.getRange(newRowIndices[j], statusIdx + 1).setValue(STATUS_SENT);
  }
}

/**
 * Get recipients from Script Properties.
 */
function _getRecipients() {
  var to = PropertiesService.getScriptProperties().getProperty('ALERT_TO');
  return to ? to.trim() : null;
}

/**
 * Build email subject from alert rows.
 */
function _buildSubject(rows, header) {
  var typeIdx = header.indexOf('alert_type');
  var counts = {};

  for (var i = 0; i < rows.length; i++) {
    var t = typeIdx >= 0 ? String(rows[i][typeIdx]).trim() : 'unknown';
    counts[t] = (counts[t] || 0) + 1;
  }

  var labels = _getAlertTypeLabels();
  var parts = [];
  var keys = Object.keys(counts);
  for (var j = 0; j < keys.length; j++) {
    var label = labels[keys[j]] || keys[j];
    parts.push(label + ' x' + counts[keys[j]]);
  }
  if (parts.length === 0) parts.push('アラート x' + rows.length);

  return '[土壌センサ警報] ' + parts.join(', ');
}

/**
 * Build email body from alert rows.
 */
function _buildBody(rows, header) {
  var tsIdx = header.indexOf('timestamp');
  var detectedIdx = header.indexOf('detected_at');
  var typeIdx = header.indexOf('alert_type');
  var siteIdx = header.indexOf('site_id');
  var addrIdx = header.indexOf('addr');
  var numIdx = header.indexOf('sensor_number');
  var detailIdx = header.indexOf('details');

  var lines = [];
  lines.push('土壌センサ監視システムからの警報です。');
  lines.push('');

  // Group by alert_type
  var groups = {};
  var groupOrder = [];
  for (var i = 0; i < rows.length; i++) {
    var t = typeIdx >= 0 ? String(rows[i][typeIdx]).trim() : 'unknown';
    if (!groups[t]) {
      groups[t] = [];
      groupOrder.push(t);
    }
    groups[t].push(rows[i]);
  }

  var labels = _getAlertTypeLabels();

  for (var g = 0; g < groupOrder.length; g++) {
    var groupType = groupOrder[g];
    var groupRows = groups[groupType];
    var label = labels[groupType] ? ('■ ' + labels[groupType]) : ('■ ' + groupType);

    lines.push('==================================================');
    lines.push(label);
    lines.push('==================================================');
    for (var k = 0; k < groupRows.length; k++) {
      var r = groupRows[k];
      lines.push('  日時: ' + _cell(r, tsIdx) +
                 '  サイト: ' + _cell(r, siteIdx) +
                 '  アドレス: ' + _cell(r, addrIdx) +
                 '  センサ番号: ' + _cell(r, numIdx));
      lines.push('  詳細: ' + _cell(r, detailIdx));
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('検知日時: ' + (detectedIdx >= 0 ? String(rows[0][detectedIdx]) : ''));
  lines.push('このメールは自動送信されています。');
  return lines.join('\n');
}

function _cell(row, idx) {
  return idx >= 0 ? String(row[idx]) : '';
}

/**
 * Read alert_rules sheet to build alert_type → message mapping.
 * Falls back to built-in defaults if the sheet is missing or empty.
 */
function _getAlertTypeLabels() {
  var defaults = {
    'sensor_fault': 'センサ異常',
    'low_battery': '電池残量低下'
  };

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('alert_rules');
    if (!sheet) return defaults;

    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return defaults;

    var header = data[0].map(function (h) { return String(h).trim().toLowerCase(); });
    var typeIdx = header.indexOf('alert_type');
    var msgIdx = header.indexOf('message');
    var enabledIdx = header.indexOf('enabled');

    if (typeIdx < 0 || msgIdx < 0) return defaults;

    var labels = {};
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (enabledIdx >= 0 && String(row[enabledIdx]).trim().toUpperCase() !== 'TRUE') continue;
      var alertType = String(row[typeIdx]).trim();
      var message = String(row[msgIdx]).trim();
      if (alertType && message && !labels[alertType]) {
        labels[alertType] = message;
      }
    }

    return Object.keys(labels).length > 0 ? labels : defaults;
  } catch (e) {
    Logger.log('Failed to read alert_rules: ' + e);
    return defaults;
  }
}
