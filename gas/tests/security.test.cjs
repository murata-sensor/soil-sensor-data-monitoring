const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const SYNTHETIC_ID_TOKEN = 'synthetic.header.signature';

function makeSheet(values) {
  return {
    getDataRange: () => ({ getValues: () => values }),
    getLastRow: () => values.length,
    getLastColumn: () => Math.max(0, ...values.map((row) => row.length)),
    getRange: (row, column, height, width) => ({
      getValues: () => values.slice(row - 1, row - 1 + height)
        .map((entry) => entry.slice(column - 1, column - 1 + width)),
    }),
  };
}

function loadScript(filename, services) {
  const context = vm.createContext(services);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), context);
  return context;
}

function proxyFixture() {
  const registry = {
    users: [['email', 'role', 'enabled'], ['viewer@example.test', 'viewer', 'TRUE'],
      ['other@example.test', 'admin', 'TRUE']],
    acl: [['email', 'sourceId'], ['viewer@example.test', 'allowed']],
    sources: [['sourceId', 'spreadsheetId', 'sheetName', 'headerRow', 'enabled', 'schemaType', 'notes'],
      ['allowed', 'synthetic-book', 'measurements', 2, 'TRUE', 'mechatrax', 'internal note'],
      ['denied', 'synthetic-book', 'private', 1, 'TRUE', 'pc-serial', 'private note']],
    theme: [['key', 'value'], ['theme', '{}']],
    layouts: [['sourceId', 'json', 'year'], ['allowed', '{"sourceId":"allowed"}', ''],
      ['denied', '{"sourceId":"denied"}', '']],
  };
  const data = {
    measurements: [['preamble'], ['Date', 'SerialNumber', 'MCC', 'cell id', 'latitude,longitude', 'Temperature(degC)', 'unknown_private'],
      ['2026-01-01', 'synthetic-device', 'synthetic-mcc', 'synthetic-cell', 'synthetic-coordinates', 20, 'private']],
    private: [['secret'], ['synthetic-private']],
    events: [['date', 'label'], ['2026-01-01', 'synthetic event']],
  };
  const properties = { GOOGLE_OAUTH_CLIENT_ID: 'our-client' };
  const claims = { email: 'viewer@example.test', email_verified: true, aud: 'our-client',
    iss: 'https://accounts.google.com', exp: Math.floor(Date.now() / 1000) + 3600 };
  const services = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (key) => properties[key] ?? null }) },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(claims) }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: (name) => registry[name] ? makeSheet(registry[name]) : null }),
      openById: (id) => {
        assert.equal(id, 'synthetic-book');
        return { getSheetByName: (name) => data[name] ? makeSheet(data[name]) : null };
      },
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text) => ({ setMimeType: () => JSON.parse(text) }) },
  };
  const context = loadScript('read_proxy.gs', services);
  const call = (body) => context.doPost({ postData: { contents: JSON.stringify({ idToken: SYNTHETIC_ID_TOKEN, ...body }) } });
  return { registry, data, properties, claims, services, call, context };
}

test('source permission does not grant arbitrary tabs in its spreadsheet', () => {
  const { call } = proxyFixture();
  assert.equal(call({ sourceId: 'denied' }).ok, false);
  assert.equal(call({ sourceId: 'allowed', sheetName: 'private' }).ok, false);
});

test('explicit main tab keeps configured header row and permitted measurements', () => {
  const { call } = proxyFixture();
  const result = call({ sourceId: 'allowed', sheetName: 'measurements' });
  assert.equal(result.ok, true);
  assert.equal(result.values[0][0], 'Date');
  assert(result.values[0].includes('Temperature(degC)'));
});

test('proxy never returns private or unknown measurement columns', () => {
  const { call } = proxyFixture();
  const result = call({ sourceId: 'allowed' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, [
    ['Date', 'SerialNumber', 'Temperature(degC)'], ['2026-01-01', 'synthetic-device', '20'],
  ]);
});

test('registry exposes only the viewer and authorized sources and layouts', () => {
  const { call } = proxyFixture();
  const result = call({ action: 'registry' });
  assert.equal(result.ok, true);
  assert.equal(result.users.length, 2);
  assert.equal(result.sources.length, 2);
  assert.equal(result.acl.length, 2);
  assert.equal(result.layouts.length, 2);
  assert(!JSON.stringify(result).includes('other@example.test'));
  assert(!JSON.stringify(result).includes('denied'));
  assert(!JSON.stringify(result).includes('internal note'));
});

test('viewer layouts accept json and documented config headers without widening source access', () => {
  for (const header of ['json', 'config']) {
    const { call, registry } = proxyFixture();
    registry.layouts[0][1] = header;
    registry.layouts[1][2] = '2026';
    registry.layouts.push(['allowed', '{"sourceId":"denied"}', '']);
    registry.layouts.push(['denied', '{"sourceId":"allowed"}', '']);
    registry.layouts.push(['allowed', '{"broken":}', '']);
    const result = call({ action: 'registry' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.layouts, [
      ['sourceId', 'json', 'year'], ['allowed', '{"sourceId":"allowed"}', '2026'],
    ], header);
  }
});

test('disabled users cannot read data or registry', () => {
  const { call, registry } = proxyFixture();
  for (const disabled of ['FALSE', '0', '', 'no', 'FALSE ']) {
    registry.users[1][2] = disabled;
    assert.equal(call({ sourceId: 'allowed' }).ok, false, String(disabled));
    assert.equal(call({ action: 'registry' }).ok, false, String(disabled));
  }
});

test('proxy fails closed on missing audience configuration or unverified email', () => {
  const { call, properties, claims } = proxyFixture();
  delete properties.GOOGLE_OAUTH_CLIENT_ID;
  assert.equal(call({ sourceId: 'allowed' }).ok, false);
  properties.GOOGLE_OAUTH_CLIENT_ID = 'our-client';
  claims.email_verified = 'false';
  assert.equal(call({ sourceId: 'allowed' }).ok, false);
});

test('events remain available but missing tokens are rejected', () => {
  const { call } = proxyFixture();
  assert.equal(call({ sourceId: 'allowed', sheetName: 'events' }).ok, true);
  assert.equal(call({ sourceId: 'allowed', idToken: '' }).ok, false);
});

test('FTP history tabs require explicit configuration and still respect other-source ACLs', () => {
  const { call, registry, data } = proxyFixture();
  registry.sources[1][5] = 'remote-ftp';
  data.sensor_raw = [['date', 'addr'], ['2026-01-01', 'synthetic-device']];
  data.sensor_2025 = data.sensor_raw;
  assert.equal(call({ sourceId: 'allowed', sheetName: 'sensor_raw' }).ok, true);
  assert.equal(call({ sourceId: 'allowed', sheetName: 'sensor_2025' }).ok, false);
  registry.sources[0].push('allowedSheetNames');
  registry.sources[1].push('["sensor_2025","private"]');
  assert.equal(call({ sourceId: 'allowed', sheetName: 'sensor_2025' }).ok, true);
  assert.equal(call({ sourceId: 'allowed', sheetName: 'private' }).ok, false);
  const result = call({ sourceId: 'allowed', action: 'sheetNames' });
  assert.deepEqual(result.names, ['measurements', 'sensor_raw', 'sensor_2025']);
});

test('proxy rejects duplicate source identities regardless of row order or enabled state', () => {
  for (const enabled of ['TRUE', 'FALSE']) {
    for (const duplicateFirst of [false, true]) {
      const { call, registry, claims } = proxyFixture();
      const duplicate = [' ALLOWED ', 'synthetic-book', 'private', 1, enabled, 'pc-serial', ''];
      registry.sources.splice(duplicateFirst ? 1 : 2, 0, duplicate);
      registry.acl.push(['viewer@example.test', 'denied']);
      assert.equal(call({ sourceId: 'allowed' }).ok, false);
      assert.equal(call({ sourceId: 'denied' }).ok, true);
      const result = call({ action: 'registry' });
      assert.equal(result.ok, true);
      assert.deepEqual(result.sources.slice(1).map((row) => row[0]), ['denied']);
      assert.deepEqual(result.layouts.slice(1).map((row) => row[0]), ['denied']);
      claims.email = 'other@example.test';
      assert.equal(call({ sourceId: 'allowed' }).ok, false);
    }
  }
});

test('proxy rejects missing or duplicate source and ACL security headers', () => {
  const required = { sources: ['sourceId', 'spreadsheetId', 'sheetName', 'enabled', 'schemaType'],
    acl: ['email', 'sourceId'] };
  for (const [sheet, fields] of Object.entries(required)) {
    for (const field of fields) {
      for (const duplicate of [false, true]) {
        const { call, registry } = proxyFixture();
        const index = registry[sheet][0].indexOf(field);
        registry[sheet].forEach((row) => duplicate ? row.push(row[index]) : row.splice(index, 1));
        assert.equal(call({ sourceId: 'allowed' }).ok, false, sheet + ':' + field);
        assert.equal(call({ action: 'registry' }).ok, false, sheet + ':' + field);
      }
    }
  }
  for (const field of ['headerRow', 'allowedSheetNames']) {
    const { call, registry } = proxyFixture();
    if (field === 'allowedSheetNames') {
      registry.sources[0].push(field);
      registry.sources.slice(1).forEach((row) => row.push('[]'));
    }
    const index = registry.sources[0].indexOf(field);
    registry.sources.forEach((row) => row.push(row[index]));
    assert.equal(call({ sourceId: 'allowed' }).ok, false, field);
  }
});

test('proxy keeps reordered unique source headers, blank padding and wildcard ACLs working', () => {
  const { call, registry } = proxyFixture();
  registry.sources = registry.sources.map((row) => [...row].reverse());
  registry.sources.push(Array(registry.sources[0].length).fill(''));
  registry.acl = [['sourceId', 'email'], ['*', 'viewer@example.test'], ['', '']];
  assert.equal(call({ sourceId: 'allowed' }).ok, true);
  assert.equal(call({ sourceId: 'denied' }).ok, true);
  assert.deepEqual(call({ action: 'registry' }).sources.slice(1).map((row) => row[0]), ['allowed', 'denied']);
});

function adminFixture() {
  const fixture = proxyFixture();
  fixture.registry.users[1][1] = 'admin';
  fixture.properties.ADMIN_ALLOWED_EMAILS = 'viewer@example.test';
  let written;
  let cleared = false;
  let released = false;
  const target = {
    ...makeSheet([['key', 'value'], ['old', 'value'], ['stale', 'value']]),
    getDataRange: () => ({ getValues: () => written || [['key', 'value'], ['old', 'value'], ['stale', 'value']] }),
    clearContents: () => { cleared = true; },
    getRange: () => ({ setValues: (rows) => { written = rows; } }),
  };
  const services = {
    ...fixture.services,
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (algorithm, text) => Array.from(crypto.createHash(algorithm).update(text).digest()),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => { released = true; } }) },
    SpreadsheetApp: { flush: () => {}, getActiveSpreadsheet: () => ({ getSheetByName: (name) =>
      name === 'users' ? {
        ...makeSheet(fixture.registry.users),
        getDataRange: () => ({ getValues: () => fixture.registry.users }),
        getRange: () => ({ setValues: (rows) => { fixture.registry.users = rows; written = rows; } }),
      } : target }) },
  };
  const context = loadScript('admin_api.gs', services);
  const initialRevision = context._adminRevision(target.getDataRange().getValues());
  const call = (body) => context.doPost({ postData: { contents: JSON.stringify({
    idToken: SYNTHETIC_ID_TOKEN, action: 'putRows', sheet: 'theme', expectedRevision: initialRevision, ...body,
  }) } });
  return { ...fixture, services, target, context, call, state: () => ({ written, cleared, released }) };
}

test('malformed admin rows never clear or write existing settings', () => {
  for (const rows of [undefined, null, {}, [null], [['key'], [{}]], [[]]]) {
    const { call, state } = adminFixture();
    assert.equal(call({ rows }).ok, false);
    assert.equal(state().cleared, false);
    assert.equal(state().written, undefined);
  }
});

test('admin replacement uses one literal write including stale-cell cleanup', () => {
  const { call, state } = adminFixture();
  assert.equal(call({ rows: [['key', 'value'], ['name', '=1+1']] }).ok, true);
  assert.equal(state().cleared, false);
  assert.deepEqual(JSON.parse(JSON.stringify(state().written)), [['key', 'value'], ['name', "'=1+1"], ['', '']]);
  assert.equal(state().released, true);
});

test('admin rejects stale or missing revisions without overwriting newer settings', () => {
  const { call, state } = adminFixture();
  const snapshot = call({ action: 'getSheet' });
  assert.equal(typeof snapshot.revision, 'string');
  const saved = call({ rows: [['key'], ['new value']], expectedRevision: snapshot.revision });
  assert.equal(saved.ok, true);
  assert.notEqual(saved.revision, snapshot.revision);
  const firstWrite = state().written;
  for (const revision of [snapshot.revision, undefined]) {
    const result = call({ rows: [['key'], ['stale value']], expectedRevision: revision });
    assert.equal(result.error, 'conflict');
    assert.equal(state().written, firstWrite);
    assert.equal(state().released, true);
  }
  assert.equal(call({ rows: [['key'], ['next value']], expectedRevision: saved.revision }).ok, true);
});

test('users updates cannot remove the last enabled allowlisted admin', () => {
  const header = ['email', 'role', 'enabled'];
  for (const rows of [[], [header], [header, ['viewer@example.test', 'viewer', 'TRUE']],
    [header, ['viewer@example.test', 'admin', 'FALSE']],
    [header, ['other@example.test', 'admin', 'TRUE']], [['email'], ['viewer@example.test']]]) {
    const { call, state } = adminFixture();
    const revision = call({ action: 'getSheet', sheet: 'users' }).revision;
    assert.equal(call({ sheet: 'users', rows, expectedRevision: revision }).error, 'admin_required');
    assert.equal(state().written, undefined);
    assert.equal(state().cleared, false);
  }
});

test('users updates can transfer administration to another enabled allowlisted admin', () => {
  const { call, properties, state } = adminFixture();
  properties.ADMIN_ALLOWED_EMAILS = 'viewer@example.test,other@example.test';
  const revision = call({ action: 'getSheet', sheet: 'users' }).revision;
  const rows = [['email', 'role', 'enabled'], ['viewer@example.test', 'viewer', 'TRUE'],
    ['other@example.test', 'admin', 'TRUE']];
  assert.equal(call({ sheet: 'users', rows, expectedRevision: revision }).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(state().written)), rows);
  assert.equal(call({ action: 'getSheet', sheet: 'users' }).ok, false);
});

test('disabled or non-admin registry users cannot use the admin allowlist', () => {
  const { call, registry, state } = adminFixture();
  registry.users[1][2] = '0';
  assert.equal(call({ action: 'getSheet' }).ok, false);
  registry.users[1][2] = 'TRUE';
  registry.users[1][1] = 'viewer';
  assert.equal(call({ rows: [] }).ok, false);
  assert.equal(state().written, undefined);
});

for (const filename of ['read_proxy.gs', 'admin_api.gs']) {
  test(filename + ' rejects duplicate user identities regardless of enabled or role order', () => {
    const email = 'viewer@example.test';
    for (const pair of [
      [[email, 'admin', 'TRUE'], [email, 'admin', 'FALSE']],
      [[email, 'admin', 'FALSE'], [email, 'admin', 'TRUE']],
      [[email, 'viewer', 'TRUE'], [email, 'admin', 'TRUE']],
      [[email, 'admin', 'TRUE'], [email, 'viewer', 'TRUE']],
      [[email, 'admin', 'TRUE'], [' Viewer@Example.Test ', 'admin', 'TRUE']],
    ]) {
      const fixture = filename === 'admin_api.gs' ? adminFixture() : proxyFixture();
      const action = filename === 'admin_api.gs' ? 'getSheet' : 'registry';
      assert.equal(fixture.call({ action }).ok, true);
      fixture.registry.users.splice(1, 1, ...pair);
      assert.equal(fixture.call({ action }).ok, false, JSON.stringify(pair));
      if (filename === 'read_proxy.gs') {
        assert.equal(fixture.call({ sourceId: 'allowed' }).ok, false, JSON.stringify(pair));
      }
    }
  });

  test(filename + ' rejects duplicate identity headers', () => {
    for (const header of ['email', 'role', 'enabled']) {
      const fixture = filename === 'admin_api.gs' ? adminFixture() : proxyFixture();
      const index = fixture.registry.users[0].indexOf(header);
      fixture.registry.users.forEach((row) => row.push(row[index]));
      const action = filename === 'admin_api.gs' ? 'getSheet' : 'registry';
      assert.equal(fixture.call({ action }).ok, false, header);
      if (filename === 'read_proxy.gs') {
        assert.equal(fixture.call({ sourceId: 'allowed' }).ok, false, header);
      }
    }
  });
}

test('users updates reject duplicate email identities while retaining the existing admin', () => {
  const { call, state } = adminFixture();
  const revision = call({ action: 'getSheet', sheet: 'users' }).revision;
  const rows = [['email', 'role', 'enabled'], ['viewer@example.test', 'admin', 'TRUE'],
    ['other@example.test', 'viewer', 'TRUE'], [' Other@Example.Test ', 'viewer', 'FALSE']];
  assert.equal(call({ sheet: 'users', rows, expectedRevision: revision }).ok, false);
  assert.equal(state().written, undefined);
});

test('users updates reject duplicate identity headers without writing', () => {
  for (const header of ['email', 'role', 'enabled']) {
    const { call, state } = adminFixture();
    const revision = call({ action: 'getSheet', sheet: 'users' }).revision;
    const rows = [['email', 'role', 'enabled'], ['viewer@example.test', 'admin', 'TRUE']];
    const index = rows[0].indexOf(header);
    rows.forEach((row) => row.push(row[index]));
    assert.equal(call({ sheet: 'users', rows, expectedRevision: revision }).ok, false, header);
    assert.equal(state().written, undefined);
  }
});

test('users updates preserve unique identities with reordered columns and blank padding rows', () => {
  const { call } = adminFixture();
  const revision = call({ action: 'getSheet', sheet: 'users' }).revision;
  const rows = [['enabled', 'email', 'role'], ['TRUE', 'viewer@example.test', 'admin'],
    ['FALSE', 'other@example.test', 'viewer'], ['', '', ''], ['', '', '']];
  assert.equal(call({ sheet: 'users', rows, expectedRevision: revision }).ok, true);
  assert.equal(call({ action: 'getSheet', sheet: 'users' }).ok, true);
});

test('sources updates reject duplicate normalized identities without writing', () => {
  for (const enabled of ['TRUE', 'FALSE']) {
    const { call, state } = adminFixture();
    const rows = [['sourceId', 'spreadsheetId', 'sheetName', 'enabled', 'schemaType'],
      ['allowed', 'synthetic-book', 'measurements', 'TRUE', 'mechatrax'],
      [' ALLOWED ', 'synthetic-book', 'private', enabled, 'pc-serial']];
    const revision = call({ action: 'getSheet', sheet: 'sources' }).revision;
    assert.equal(call({ sheet: 'sources', rows, expectedRevision: revision }).error, 'invalid_sources');
    assert.equal(state().written, undefined);
  }
});

test('sources and ACL updates reject missing or duplicate security headers without writing', () => {
  const examples = {
    sources: [['sourceId', 'spreadsheetId', 'sheetName', 'enabled', 'schemaType', 'headerRow', 'allowedSheetNames'],
      ['allowed', 'synthetic-book', 'measurements', 'TRUE', 'mechatrax', 2, '[]']],
    acl: [['email', 'sourceId'], ['viewer@example.test', '*']],
  };
  const required = { sources: ['sourceId', 'spreadsheetId', 'sheetName', 'enabled', 'schemaType'],
    acl: ['email', 'sourceId'] };
  for (const [sheet, template] of Object.entries(examples)) {
    for (const field of template[0]) {
      for (const duplicate of [false, true]) {
        if (!duplicate && !required[sheet].includes(field)) continue;
        const { call, state } = adminFixture();
        const rows = template.map((row) => [...row]);
        const index = rows[0].indexOf(field);
        rows.forEach((row) => duplicate ? row.push(row[index]) : row.splice(index, 1));
        const revision = call({ action: 'getSheet', sheet }).revision;
        assert.equal(call({ sheet, rows, expectedRevision: revision }).error, 'invalid_' + sheet, sheet + ':' + field);
        assert.equal(state().written, undefined, sheet + ':' + field);
      }
    }
  }
});

test('sources and ACL updates retain reordered headers, blank rows and wildcard grants', () => {
  for (const [sheet, rows] of Object.entries({
    sources: [['enabled', 'schemaType', 'sheetName', 'spreadsheetId', 'sourceId'],
      ['TRUE', 'mechatrax', 'measurements', 'synthetic-book', 'allowed'], ['', '', '', '', ''], ['', '', '', '', '']],
    acl: [['sourceId', 'email', 'permission'], ['*', 'viewer@example.test', 'read'], ['', '', ''], ['', '', '']],
  })) {
    const { call } = adminFixture();
    const revision = call({ action: 'getSheet', sheet }).revision;
    assert.equal(call({ sheet, rows, expectedRevision: revision }).ok, true, sheet);
  }
});

test('a distinct unique admin can repair duplicate users without removing the last admin', () => {
  const { call, claims, properties, registry } = adminFixture();
  claims.email = 'other@example.test';
  properties.ADMIN_ALLOWED_EMAILS = 'viewer@example.test,other@example.test';
  registry.users.splice(1, 0, ['viewer@example.test', 'viewer', 'FALSE']);
  const snapshot = call({ action: 'getSheet', sheet: 'users' });
  assert.equal(snapshot.ok, true);
  const rows = [['email', 'role', 'enabled'], ['viewer@example.test', 'viewer', 'FALSE'],
    ['other@example.test', 'admin', 'TRUE']];
  assert.equal(call({ sheet: 'users', rows, expectedRevision: snapshot.revision }).ok, true);
  assert.equal(call({ action: 'getSheet', sheet: 'users' }).ok, true);
  claims.email = 'viewer@example.test';
  assert.equal(call({ action: 'getSheet', sheet: 'users' }).ok, false);
});

test('admin lock contention does not write and a failed write releases the lock without clearing', () => {
  const busy = adminFixture();
  busy.services.LockService.getScriptLock = () => ({ tryLock: () => false });
  assert.equal(busy.call({ rows: [['key']] }).ok, false);
  assert.equal(busy.state().written, undefined);
  const failed = adminFixture();
  failed.target.getRange = () => ({ setValues: () => { throw new Error('synthetic write failure'); } });
  assert.equal(failed.call({ rows: [['key']] }).ok, false);
  assert.equal(failed.state().cleared, false);
  assert.equal(failed.state().released, true);
});

test('admin saves reject callers removed from the allowlist while waiting for the lock', () => {
  const { call, properties, services, state } = adminFixture();
  properties.ADMIN_ALLOWED_EMAILS = 'viewer@example.test,other@example.test';
  const getLock = services.LockService.getScriptLock;
  services.LockService.getScriptLock = () => {
    const lock = getLock();
    return { ...lock, tryLock: (...args) => {
      const acquired = lock.tryLock(...args);
      properties.ADMIN_ALLOWED_EMAILS = 'other@example.test';
      return acquired;
    } };
  };
  assert.equal(call({ rows: [['key', 'value'], ['synthetic', 'saved']] }).error, 'forbidden');
  assert.equal(state().written, undefined);
  assert.equal(state().cleared, false);
  assert.equal(state().released, true);
});

test('users saves require an admin in the latest allowlist after waiting for the lock', () => {
  const { call, properties, services, state } = adminFixture();
  properties.ADMIN_ALLOWED_EMAILS = 'viewer@example.test,other@example.test';
  const revision = call({ action: 'getSheet', sheet: 'users' }).revision;
  const getLock = services.LockService.getScriptLock;
  services.LockService.getScriptLock = () => {
    const lock = getLock();
    return { ...lock, tryLock: (...args) => {
      const acquired = lock.tryLock(...args);
      properties.ADMIN_ALLOWED_EMAILS = 'viewer@example.test';
      return acquired;
    } };
  };
  const rows = [['email', 'role', 'enabled'], ['viewer@example.test', 'viewer', 'TRUE'],
    ['other@example.test', 'admin', 'TRUE']];
  assert.equal(call({ sheet: 'users', rows, expectedRevision: revision }).error, 'admin_required');
  assert.equal(state().written, undefined);
  assert.equal(state().cleared, false);
  assert.equal(state().released, true);
});

test('standalone read and admin projects can explicitly open their registry', () => {
  for (const filename of ['read_proxy.gs', 'admin_api.gs']) {
    const fixture = filename === 'admin_api.gs' ? adminFixture() : proxyFixture();
    const registryBook = fixture.services.SpreadsheetApp.getActiveSpreadsheet();
    fixture.properties.REGISTRY_SPREADSHEET_ID = 'synthetic-registry';
    fixture.services.SpreadsheetApp.getActiveSpreadsheet = () => { throw new Error('not bound'); };
    fixture.services.SpreadsheetApp.openById = (id) => {
      assert.equal(id, 'synthetic-registry');
      return registryBook;
    };
    assert.equal(fixture.call({ action: filename === 'admin_api.gs' ? 'getSheet' : 'registry' }).ok, true);
  }
});

for (const filename of ['read_proxy.gs', 'admin_api.gs']) {
  test(filename + ' strictly verifies identity claims', () => {
    const fixture = filename === 'admin_api.gs' ? adminFixture() : proxyFixture();
    const verify = filename === 'admin_api.gs' ? fixture.context._adminVerifyIdToken : fixture.context._proxyVerifyIdToken;
    for (const verified of [true, 'true']) {
      fixture.claims.email_verified = verified;
      assert.equal(verify(SYNTHETIC_ID_TOKEN), 'viewer@example.test');
    }
    for (const bad of [{ aud: 'foreign-client' }, { iss: 'https://example.invalid' },
      { exp: 0 }, { exp: 'invalid' }, { email_verified: 'false' }, { email: '' }]) {
      const original = { ...fixture.claims };
      Object.assign(fixture.claims, bad);
      assert.throws(() => verify(SYNTHETIC_ID_TOKEN));
      Object.assign(fixture.claims, original);
    }
    delete fixture.properties.GOOGLE_OAUTH_CLIENT_ID;
    assert.throws(() => verify(SYNTHETIC_ID_TOKEN));
  });

  test(filename + ' rejects malformed ID tokens before contacting Google', () => {
    const fixture = filename === 'admin_api.gs' ? adminFixture() : proxyFixture();
    const originalFetch = fixture.services.UrlFetchApp.fetch;
    let fetches = 0;
    let responseCode = 200;
    fixture.services.UrlFetchApp.fetch = (...args) => {
      fetches++;
      return { ...originalFetch(...args), getResponseCode: () => responseCode };
    };
    const action = filename === 'admin_api.gs' ? 'getSheet' : 'registry';
    for (const token of [null, 42, true, {}, [], '', ' ', 'header.payload', 'header..signature',
      '.payload.signature', 'header.payload.', 'header.payload.signature.extra',
      'header.pay%20load.signature', 'header.pay\uFF41load.signature',
      'header.payload.signature\n', 'a'.repeat(8189) + '.b.c']) {
      assert.deepEqual(fixture.call({ action, idToken: token }), { ok: false, error: 'request denied' });
      assert.equal(fetches, 0);
    }
    const boundaryToken = 'a'.repeat(8188) + '.b.c';
    assert.equal(boundaryToken.length, 8192);
    assert.equal(fixture.call({ action, idToken: boundaryToken }).ok, true);
    assert.equal(fetches, 1);
    responseCode = 400;
    assert.deepEqual(fixture.call({ action, idToken: SYNTHETIC_ID_TOKEN }),
      { ok: false, error: 'request denied' });
    assert.equal(fetches, 2);
  });

  test(filename + ' bounds request size before authentication and accepts the exact limit', () => {
    const fixture = filename === 'admin_api.gs' ? adminFixture() : proxyFixture();
    const originalFetch = fixture.services.UrlFetchApp.fetch;
    let fetches = 0;
    fixture.services.UrlFetchApp.fetch = (...args) => { fetches++; return originalFetch(...args); };
    const limit = filename === 'admin_api.gs' ? 1000000 : 16384;
    const body = { idToken: SYNTHETIC_ID_TOKEN,
      action: filename === 'admin_api.gs' ? 'getSheet' : 'registry', sheet: 'theme', padding: '' };
    body.padding = 'x'.repeat(limit - JSON.stringify(body).length);
    const boundary = JSON.stringify(body);
    assert.equal(boundary.length, limit);
    body.padding += 'x';
    assert.deepEqual(fixture.context.doPost({ postData: { contents: JSON.stringify(body) } }),
      { ok: false, error: 'request too large' });
    assert.equal(fetches, 0);
    assert.equal(fixture.context.doPost({ postData: { contents: boundary } }).ok, true);
    assert.equal(fetches, 1);
  });
}

function receiverFixture({ filename = 'pc_serial_receiver.gs', failure, busy = false, onWrite, weatherLookup } = {}) {
  const fixture = proxyFixture();
  fixture.properties.INGEST_TOKEN = 'synthetic-ingest';
  const rows = [];
  const events = [];
  let locked = false;
  let sheetExists = false;
  let filterExists = false;
  let beforeWrite = onWrite;
  const critical = (operation, action) => {
    assert.equal(locked, true, operation + ' requires the lock');
    events.push(operation);
    if (operation === failure) throw new Error('synthetic storage failure');
    return action?.();
  };
  const sheet = {
    getLastRow: () => critical('lastRow', () => rows.length),
    getLastColumn: () => critical('lastColumn', () => rows[0]?.length || 0),
    appendRow: (row) => critical(rows.length === 0 ? 'header' : 'write', () => {
      if (rows.length > 0) {
        const callback = beforeWrite;
        beforeWrite = undefined;
        callback?.();
      }
      rows.push(Array.from(row));
    }),
    getFilter: () => critical('getFilter', () => filterExists
      ? { remove: () => critical('removeFilter', () => { filterExists = false; }) } : null),
    getRange: (row) => critical('range', () => ({
      setValues: (values) => critical('write', () => {
        const callback = beforeWrite;
        beforeWrite = undefined;
        callback?.();
        values.forEach((value, index) => { rows[row - 1 + index] = Array.from(value); });
      }),
      createFilter: () => critical('filter', () => { filterExists = true; }),
    })),
  };
  const context = loadScript(filename, {
    ...fixture.services,
    ...(weatherLookup ? { amedasLookup: weatherLookup } : {}),
    LockService: { getScriptLock: () => ({
      tryLock: (timeout) => {
        assert.equal(timeout, 10000);
        events.push('lock');
        if (busy || locked) return false;
        locked = true;
        return true;
      },
      releaseLock: () => critical('release', () => { locked = false; }),
    }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => critical('spreadsheet', () => ({
        getSheetByName: () => critical('findSheet', () => sheetExists ? sheet : null),
        insertSheet: () => critical('createSheet', () => { sheetExists = true; return sheet; }),
      })),
      flush: () => critical('flush'),
    },
    Utilities: { formatDate: () => '2026-01-01 00:00:00' },
  });
  const call = (body = {}) => context.doPost({ postData: { contents: JSON.stringify({
    token: 'synthetic-ingest', serialNumber: 'synthetic-first', ...body,
  }) } });
  return { call, rows, events, isLocked: () => locked };
}

test('PC serial concurrent requests cannot overwrite a batch and can retry after release', () => {
  let competingResult;
  const fixture = receiverFixture({ onWrite: () => {
    competingResult = fixture.call({ serialNumber: 'synthetic-second' });
  } });
  assert.deepEqual(fixture.call({ rows: [{ serialNumber: 'synthetic-first' },
    { serialNumber: 'synthetic-third' }] }), { ok: true, written: 2 });
  assert.deepEqual(competingResult, { ok: false, error: 'busy' });
  assert.deepEqual(fixture.call({ serialNumber: 'synthetic-second' }), { ok: true, written: 1 });
  assert.deepEqual(fixture.rows.slice(1).map((row) => row[1]),
    ['synthetic-first', 'synthetic-third', 'synthetic-second']);
  assert.equal(fixture.events.filter((event) => event === 'createSheet').length, 1);
  assert.equal(fixture.events.filter((event) => event === 'header').length, 1);
  assert.equal(fixture.events.filter((event) => event === 'release').length, 2);
  assert.deepEqual(fixture.events.slice(-2), ['flush', 'release']);
  assert.equal(fixture.isLocked(), false);
});

test('PC serial lock contention never reads or changes the spreadsheet', () => {
  const fixture = receiverFixture({ busy: true });
  assert.deepEqual(fixture.call(), { ok: false, error: 'busy' });
  assert.deepEqual(fixture.events, ['lock']);
  assert.deepEqual(fixture.rows, []);
});

test('PC serial flushes and releases its lock even when storage or filtering fails', () => {
  for (const failure of ['spreadsheet', 'findSheet', 'createSheet', 'header', 'range', 'write', 'filter', 'flush']) {
    const fixture = receiverFixture({ failure });
    assert.deepEqual(fixture.call(), { ok: false, error: 'request_failed' }, failure);
    assert.equal(fixture.isLocked(), false, failure);
    assert.deepEqual(fixture.events.slice(-2), ['flush', 'release'], failure);
  }
});

test('PC serial rejects bad input and accepts empty batches without acquiring a lock', () => {
  const fixture = receiverFixture();
  for (const body of [{ token: 'wrong' }, { rows: [{ serialNumber: 'synthetic' }, {}] },
    { ts: 'invalid' }, { rows: Array.from({ length: 501 }, () => ({ serialNumber: 'synthetic' })) }]) {
    assert.equal(fixture.call(body).ok, false);
  }
  assert.deepEqual(fixture.call({ rows: [] }), { ok: true, written: 0 });
  assert.deepEqual(fixture.events, []);
  assert.deepEqual(fixture.rows, []);
});

for (const filename of ['m5stack_receiver.gs', 'mechatrax_receiver.gs']) {
  test(filename + ' serializes sheet creation, appends and filter replacement', () => {
    let competingResult;
    const fixture = receiverFixture({ filename, onWrite: () => {
      competingResult = fixture.call({ serialNumber: 'synthetic-second' });
    } });
    assert.deepEqual(fixture.call(), { ok: true });
    assert.deepEqual(competingResult, { ok: false, error: 'busy' });
    assert.deepEqual(fixture.call({ serialNumber: 'synthetic-second' }), { ok: true });
    const serialColumn = filename === 'mechatrax_receiver.gs' ? 13 : 1;
    assert.deepEqual(fixture.rows.slice(1).map((row) => row[serialColumn]),
      ['synthetic-first', 'synthetic-second']);
    for (const operation of ['createSheet', 'header', 'removeFilter']) {
      assert.equal(fixture.events.filter((event) => event === operation).length, 1, operation);
    }
    assert.equal(fixture.events.filter((event) => event === 'release').length, 2);
    assert.deepEqual(fixture.events.slice(-2), ['flush', 'release']);
    assert.equal(fixture.isLocked(), false);
  });

  test(filename + ' leaves storage untouched when its lock is busy', () => {
    const fixture = receiverFixture({ filename, busy: true });
    assert.deepEqual(fixture.call(), { ok: false, error: 'busy' });
    assert.deepEqual(fixture.events, ['lock']);
    assert.deepEqual(fixture.rows, []);
  });

  test(filename + ' flushes and releases its lock after storage failures', () => {
    for (const failure of ['spreadsheet', 'findSheet', 'createSheet', 'lastRow', 'header',
      'write', 'lastColumn', 'range', 'getFilter', 'filter', 'flush']) {
      const fixture = receiverFixture({ filename, failure });
      assert.deepEqual(fixture.call(), { ok: false, error: 'request_failed' }, failure);
      assert.deepEqual(fixture.events.slice(-2), ['flush', 'release'], failure);
      assert.equal(fixture.isLocked(), false, failure);
    }
    const removalFailure = receiverFixture({ filename, failure: 'removeFilter' });
    assert.deepEqual(removalFailure.call(), { ok: true });
    assert.deepEqual(removalFailure.call(), { ok: false, error: 'request_failed' });
    assert.deepEqual(removalFailure.events.slice(-2), ['flush', 'release']);
    assert.equal(removalFailure.isLocked(), false);
  });

  test(filename + ' validates tokens and input before acquiring a lock', () => {
    const fixture = receiverFixture({ filename });
    for (const body of [{ token: 'wrong' }, { serialNumber: '' }, { ts: 'invalid' }]) {
      assert.equal(fixture.call(body).ok, false);
    }
    assert.deepEqual(fixture.events, []);
    assert.deepEqual(fixture.rows, []);
  });
}

test('Mechatrax weather lookup stays outside the lock and remains best effort', () => {
  for (const failLookup of [false, true]) {
    let calls = 0;
    const fixture = receiverFixture({ filename: 'mechatrax_receiver.gs', weatherLookup: () => {
      calls++;
      assert.equal(fixture.isLocked(), false);
      if (failLookup) throw new Error('synthetic weather failure');
      return { airTemp: 12.5, precip: 1, sunshine: 0.5 };
    } });
    assert.deepEqual(fixture.call({ latitude: 0, longitude: 0 }), { ok: true });
    assert.equal(calls, 1);
    assert.deepEqual(fixture.rows[1].slice(-3), failLookup ? ['', '', ''] : [12.5, 1, 0.5]);
    assert.equal(fixture.rows[1][13], 'synthetic-first');
  }
});

for (const filename of ['m5stack_receiver.gs', 'mechatrax_receiver.gs', 'pc_serial_receiver.gs']) {
  test(filename + ' rejects missing tokens and writes strings literally', () => {
    const fixture = proxyFixture();
    fixture.properties.INGEST_TOKEN = 'synthetic-ingest';
    let written;
    const sheet = {
      getLastRow: () => 1, getLastColumn: () => 31, getFilter: () => null,
      appendRow: (row) => { written = row; },
      getRange: () => ({ setValues: (rows) => { written = rows[0]; }, createFilter: () => {} }),
    };
    const context = loadScript(filename, {
      ...fixture.services,
      LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
      SpreadsheetApp: { flush: () => {}, getActiveSpreadsheet: () => ({ getSheetByName: () => sheet }) },
      Utilities: { formatDate: () => '2026-01-01 00:00:00' },
    });
    const call = (body) => context.doPost({ postData: { contents: JSON.stringify(body) } });
    assert.deepEqual(call({ serialNumber: 'synthetic' }), { ok: false, error: 'unauthorized' });
    assert.deepEqual(call({ token: 'synthetic-ingest' }), { ok: false, error: 'missing field: serialNumber' });
    assert.deepEqual(call({ token: 'synthetic-ingest', serialNumber: 'synthetic', ts: 'invalid' }),
      { ok: false, error: 'invalid ts' });
    assert.equal(written, undefined);
    assert.deepEqual(call({ token: 'synthetic-ingest', serialNumber: '=1+1', deviceTs: '=1+1',
      battery_v: 'Infinity', temperature_c: -5 }), filename === 'pc_serial_receiver.gs'
      ? { ok: true, written: 1 } : { ok: true });
    assert(written.includes("'=1+1"));
    assert(!written.includes('=1+1'));
    assert(written.includes(-5));
    assert(!written.includes(Infinity));
  });

  test(filename + ' hides internal configuration and spreadsheet failures', () => {
    for (const stage of ['properties', 'spreadsheet']) {
      const fixture = proxyFixture();
      fixture.properties.INGEST_TOKEN = 'synthetic-ingest';
      const fail = () => { throw new Error('synthetic-private-configuration-and-book'); };
      const context = loadScript(filename, {
        ...fixture.services,
        ...(stage === 'properties' ? { PropertiesService: { getScriptProperties: fail } } : {}),
        LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
        SpreadsheetApp: { flush: () => {}, getActiveSpreadsheet: fail },
        Utilities: { formatDate: () => '2026-01-01 00:00:00' },
      });
      const result = context.doPost({ postData: { contents: JSON.stringify({
        token: 'synthetic-ingest', serialNumber: 'synthetic-device', temperature_c: 20,
      }) } });
      assert.deepEqual(result, { ok: false, error: 'request_failed' }, stage);
    }
  });

  test(filename + ' never echoes malformed request content', () => {
    const fixture = proxyFixture();
    fixture.properties.INGEST_TOKEN = 'synthetic-ingest';
    const context = loadScript(filename, fixture.services);
    for (const contents of ['{"token":"synthetic-sensitive-token","broken":}', 'null']) {
      const result = context.doPost({ postData: { contents } });
      assert.deepEqual(result, { ok: false, error: 'request_failed' });
    }
  });
}
