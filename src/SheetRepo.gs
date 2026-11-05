/**
 * @fileoverview All reads/writes to the Google Sheet. No other file touches SpreadsheetApp
 * (except the onEdit entry point, which delegates here).
 */

let _ssCache = null;

// ---------------------------------------------------------------- low-level helpers

/**
 * Opens the bot spreadsheet (SHEET_ID script property, else the bound spreadsheet).
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet} spreadsheet.
 */
function getSpreadsheet() {
  if (_ssCache) return _ssCache;
  const id = getScriptProp(PROP_KEYS.SHEET_ID);
  _ssCache = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!_ssCache) throw new Error('No spreadsheet found. Run setup() from the bound Apps Script project.');
  return _ssCache;
}

/**
 * URL of the tracker spreadsheet.
 * @return {string} url.
 */
function getSheetUrl() {
  return getSpreadsheet().getUrl();
}

/**
 * Returns a tab by name or throws.
 * @param {string} name tab name.
 * @return {GoogleAppsScript.Spreadsheet.Sheet} sheet.
 */
function getSheet(name) {
  const sh = getSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error(`Missing tab "${name}" — run setup()`);
  return sh;
}

/**
 * Converts a cell value to a string (Dates → ISO / YYYY-MM-DD, booleans → TRUE/FALSE).
 * @param {*} v cell value.
 * @return {string} string value.
 */
function cellToString(v) {
  if (v instanceof Date) {
    const midnight = v.getHours() === 0 && v.getMinutes() === 0 && v.getSeconds() === 0;
    return midnight ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : toIso(v);
  }
  if (v === true) return 'TRUE';
  if (v === false) return 'FALSE';
  return v == null ? '' : String(v).trim();
}

/**
 * Header row of a sheet.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sh sheet.
 * @return {Array<string>} headers.
 */
function getHeaders(sh) {
  const lastCol = Math.max(sh.getLastColumn(), 1);
  return sh.getRange(1, 1, 1, lastCol).getValues()[0].map((h) => String(h).trim());
}

/**
 * Reads a whole tab as objects keyed by header, each with a `_row` (1-based sheet row).
 * @param {string} name tab name.
 * @return {{sheet: Object, headers: Array<string>, rows: Array<Object>}} table.
 */
function readTable(name) {
  const sh = getSheet(name);
  const values = sh.getDataRange().getValues();
  const headers = (values[0] || []).map((h) => String(h).trim());
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const o = { _row: i + 1 };
    let any = false;
    headers.forEach((h, j) => {
      if (!h) return;
      o[h] = cellToString(values[i][j]);
      if (o[h] !== '') any = true;
    });
    if (any) rows.push(o);
  }
  return { sheet: sh, headers, rows };
}

/**
 * Appends an object as a new row (cells stored as plain text).
 * @param {string} name tab name.
 * @param {Object} obj values keyed by header.
 * @return {number} new row number.
 */
function appendObject(name, obj) {
  const sh = getSheet(name);
  const headers = getHeaders(sh);
  const row = headers.map((h) => (obj[h] === undefined || obj[h] === null ? '' : String(obj[h])));
  const r = sh.getLastRow() + 1;
  const range = sh.getRange(r, 1, 1, headers.length);
  range.setNumberFormat('@');
  range.setValues([row]);
  return r;
}

/**
 * Writes only the given fields of one row.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sh sheet.
 * @param {Array<string>} headers headers.
 * @param {number} rowNum 1-based row.
 * @param {Object} patch fields to write.
 */
function patchRow(sh, headers, rowNum, patch) {
  Object.keys(patch).forEach((k) => {
    const c = headers.indexOf(k);
    if (c < 0) throw new Error(`Unknown column "${k}" in ${sh.getName()} — re-run setup() to add new columns`);
    const cell = sh.getRange(rowNum, c + 1);
    cell.setNumberFormat('@');
    cell.setValue(patch[k] === undefined || patch[k] === null ? '' : String(patch[k]));
  });
}

/**
 * Updates the row whose `keyCol` equals `keyVal`.
 * @param {string} name tab name.
 * @param {string} keyCol key column.
 * @param {string} keyVal key value.
 * @param {Object} patch fields to write.
 * @return {boolean} true if a row was updated.
 */
function updateByKey(name, keyCol, keyVal, patch) {
  const t = readTable(name);
  const row = t.rows.find((r) => r[keyCol] === keyVal);
  if (!row) return false;
  patchRow(t.sheet, t.headers, row._row, patch);
  return true;
}

// ---------------------------------------------------------------- Config + Teams

/**
 * Reads the Config tab as a key → value map.
 * @return {Object<string,string>} map.
 */
function readConfigMap() {
  const map = {};
  readTable(SHEETS.CONFIG).rows.forEach((r) => {
    if (r.key) map[String(r.key).trim().toUpperCase()] = r.value;
  });
  return map;
}

/**
 * Reads raw Teams rows.
 * @return {Array<Object>} rows.
 */
function readTeamRows() {
  return readTable(SHEETS.TEAMS).rows;
}

// ---------------------------------------------------------------- Hires

/**
 * All hire rows.
 * @return {Array<Object>} hires.
 */
function listHires() {
  return readTable(SHEETS.HIRES).rows;
}

/**
 * Gets one hire by hire_no.
 * @param {string} hireNo e.g. 'NH-1001'.
 * @return {Object|null} hire.
 */
function getHire(hireNo) {
  return listHires().find((h) => h.hire_no === hireNo) || null;
}

/**
 * Finds a hire by employee id (case-insensitive).
 * @param {string} employeeId employee id.
 * @return {Object|null} hire.
 */
function findHireByEmployeeId(employeeId) {
  const id = String(employeeId || '').trim().toLowerCase();
  if (!id) return null;
  return listHires().find((h) => h.employee_id.toLowerCase() === id) || null;
}

/**
 * Fallback dedupe: finds a hire by full name + joining date (case-insensitive name).
 * @param {string} fullName name.
 * @param {string} joiningDate YYYY-MM-DD.
 * @return {Object|null} hire.
 */
function findHireByNameAndDate(fullName, joiningDate) {
  const n = String(fullName || '').trim().toLowerCase();
  if (!n || !joiningDate) return null;
  return listHires().find((h) => h.full_name.toLowerCase() === n && h.joining_date === joiningDate) || null;
}

/**
 * Finds the hire whose source_message_id is one of the given Gmail message ids.
 * @param {Array<string>} messageIds ids.
 * @return {Object|null} hire.
 */
function findHireBySourceMessageIds(messageIds) {
  return listHires().find((h) => h.source_message_id && messageIds.indexOf(h.source_message_id) >= 0) || null;
}

/**
 * Inserts a hire with the next sequential hire_no (max + 1, starting at NH-1001).
 * Must be called inside the script lock.
 * @param {Object} record hire fields keyed by Hires column (hire_no is assigned here).
 * @return {string} new hire_no.
 */
function insertHire(record) {
  const max = listHires().reduce((m, h) => Math.max(m, parseInt(hireNumber(h.hire_no), 10) || 0), 1000);
  const hireNo = `NH-${max + 1}`;
  appendObject(SHEETS.HIRES, Object.assign({}, record, { hire_no: hireNo }));
  return hireNo;
}

/**
 * Updates fields of a hire.
 * @param {string} hireNo hire number.
 * @param {Object} patch fields.
 * @return {boolean} updated.
 */
function updateHire(hireNo, patch) {
  return updateByKey(SHEETS.HIRES, 'hire_no', hireNo, patch);
}

// ---------------------------------------------------------------- Requests

/**
 * Inserts a request row and applies the status dropdown to it.
 * @param {Object} req request fields keyed by Requests column.
 */
function insertRequest(req) {
  const r = appendObject(SHEETS.REQUESTS, req);
  const sh = getSheet(SHEETS.REQUESTS);
  const col = getHeaders(sh).indexOf('status') + 1;
  if (col > 0) sh.getRange(r, col).setDataValidation(statusValidation(Object.keys(REQ_STATUS)));
}

/**
 * All request rows.
 * @return {Array<Object>} requests.
 */
function listRequests() {
  return readTable(SHEETS.REQUESTS).rows;
}

/**
 * Gets one request by id.
 * @param {string} requestId e.g. 'NH-1001-WIFI'.
 * @return {Object|null} request.
 */
function getRequest(requestId) {
  return readTable(SHEETS.REQUESTS).rows.find((r) => r.request_id === requestId) || null;
}

/**
 * Updates fields of a request.
 * @param {string} requestId request id.
 * @param {Object} patch fields.
 * @return {boolean} updated.
 */
function updateRequest(requestId, patch) {
  return updateByKey(SHEETS.REQUESTS, 'request_id', requestId, patch);
}

/**
 * All requests for one hire.
 * @param {string} hireNo hire number.
 * @return {Array<Object>} requests.
 */
function getRequestsForHire(hireNo) {
  return readTable(SHEETS.REQUESTS).rows.filter((r) => r.hire_no === hireNo);
}

/**
 * SENT requests whose last touch (last reminder, else sent_at) is at least `hours` old.
 * @param {number} hours threshold.
 * @return {Array<Object>} requests.
 */
function getPendingRequestsOlderThan(hours) {
  return readTable(SHEETS.REQUESTS).rows.filter((r) => {
    if (r.status !== REQ_STATUS.SENT) return false;
    return hoursBetween(r.last_reminder_at || r.sent_at) >= hours;
  });
}

/**
 * Distinct hire numbers that have at least one manually overridden request.
 * @return {Array<string>} hire numbers.
 */
function getHireNosWithManualOverrides() {
  const set = {};
  readTable(SHEETS.REQUESTS).rows.forEach((r) => {
    if (toBool(r.manual_override)) set[r.hire_no] = true;
  });
  return Object.keys(set);
}

/**
 * onEdit handler body: when a human edits Requests.status, set manual_override = TRUE.
 * @param {GoogleAppsScript.Events.SheetsOnEdit} e edit event.
 */
function markManualOverrideFromEdit(e) {
  if (!e || !e.range) return;
  const range = e.range;
  const sh = range.getSheet();
  if (sh.getName() !== SHEETS.REQUESTS) return;
  const headers = getHeaders(sh);
  const statusCol = headers.indexOf('status') + 1;
  const ovCol = headers.indexOf('manual_override') + 1;
  if (statusCol < 1 || ovCol < 1) return;
  if (statusCol < range.getColumn() || statusCol > range.getLastColumn()) return;
  const confCol = headers.indexOf('confirmed_at') + 1;
  for (let r = Math.max(range.getRow(), 2); r <= range.getLastRow(); r++) {
    sh.getRange(r, ovCol).setNumberFormat('@').setValue('TRUE');
    const status = String(sh.getRange(r, statusCol).getValue()).trim();
    if (confCol > 0 && status === REQ_STATUS.PROVIDED && !sh.getRange(r, confCol).getValue()) {
      sh.getRange(r, confCol).setNumberFormat('@').setValue(nowIso());
    }
  }
}

// ---------------------------------------------------------------- Log

/**
 * Writes one line to the Log tab and to Logger. Never throws.
 * @param {string} level INFO | WARN | ERROR | DRYRUN.
 * @param {string} action e.g. 'REQUEST_SENT'.
 * @param {string|Object=} details free text or object (JSON-encoded).
 * @param {string=} ref hire_no / request_id / message id.
 */
function logEvent(level, action, details, ref) {
  const d = details === undefined ? '' : (typeof details === 'string' ? details : JSON.stringify(details));
  Logger.log(`[${level}] ${action} ${ref || ''} ${d}`);
  try {
    appendObject(SHEETS.LOG, {
      timestamp: nowIso(), level, action, ref: ref || '', details: d.slice(0, 45000),
    });
  } catch (e) {
    Logger.log(`logEvent: could not write to Log tab (${e})`);
  }
}

// ---------------------------------------------------------------- setup / schema

/**
 * Creates any missing tabs and headers, freezes row 1, formats data cells as plain text,
 * and removes an empty default 'Sheet1'.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet=} ss spreadsheet (defaults to bot sheet).
 */
function ensureSchema(ss) {
  const book = ss || getSpreadsheet();
  _ssCache = book;
  Object.keys(HEADERS).forEach((name) => {
    const sh = book.getSheetByName(name) || book.insertSheet(name);
    const want = HEADERS[name];
    const have = sh.getLastColumn() > 0 ? getHeaders(sh) : [];
    if (have.join('') === '') {
      sh.getRange(1, 1, 1, want.length).setValues([want]);
    } else {
      const missing = want.filter((h) => have.indexOf(h) < 0);
      if (missing.length) sh.getRange(1, have.length + 1, 1, missing.length).setValues([missing]);
    }
    const width = getHeaders(sh).length;
    sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#e8eaed');
    sh.setFrozenRows(1);
    if (sh.getMaxRows() > 1) sh.getRange(2, 1, sh.getMaxRows() - 1, width).setNumberFormat('@');
  });
  const def = book.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && book.getSheets().length > 1) book.deleteSheet(def);
}

/**
 * Adds any Config keys that are missing (never overwrites existing values).
 * @param {Object<string,string>} defaults key → default value.
 * @param {Object<string,string>} notes key → note.
 * @return {Array<string>} keys that were added.
 */
function seedConfigDefaults(defaults, notes) {
  const existing = readConfigMap();
  const added = [];
  Object.keys(defaults).forEach((k) => {
    if (existing[k] !== undefined) return;
    appendObject(SHEETS.CONFIG, { key: k, value: defaults[k], notes: notes[k] || '' });
    added.push(k);
  });
  return added;
}

/**
 * Seeds the Teams tab only if it has no data rows.
 * @param {Array<Object>} rows team rows keyed by Teams column.
 * @return {boolean} true if seeded.
 */
function seedTeamsIfEmpty(rows) {
  if (readTeamRows().length > 0) return false;
  rows.forEach((r) => appendObject(SHEETS.TEAMS, r));
  return true;
}

/**
 * Builds a dropdown validation rule.
 * @param {Array<string>} values allowed values.
 * @return {GoogleAppsScript.Spreadsheet.DataValidation} rule.
 */
function statusValidation(values) {
  return SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build();
}

/**
 * Applies dropdowns and status colours to the Hires, Requests and Teams tabs.
 */
function applySheetFormatting() {
  const rows = 1000;
  const colourFor = {
    PROVIDED: '#b7e1cd', COMPLETED: '#b7e1cd',
    SENT: '#fff2cc', DISPATCHED: '#fff2cc', IN_PROGRESS: '#fff2cc',
    BLOCKED: '#f4cccc', OVERDUE: '#f4cccc', NEEDS_INFO: '#f4cccc',
    REPLIED_UNCLEAR: '#fce5cd',
    PENDING: '#eeeeee', NEW: '#eeeeee',
  };
  const styleStatus = (tab, values) => {
    const sh = getSheet(tab);
    const col = getHeaders(sh).indexOf('status') + 1;
    if (col < 1) return;
    const range = sh.getRange(2, col, rows, 1);
    range.setDataValidation(statusValidation(values));
    const rules = values.filter((v) => colourFor[v]).map((v) => SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(v).setBackground(colourFor[v]).setRanges([range]).build());
    sh.setConditionalFormatRules(rules);
  };
  styleStatus(SHEETS.REQUESTS, Object.keys(REQ_STATUS));
  styleStatus(SHEETS.HIRES, Object.keys(HIRE_STATUS));

  const teams = getSheet(SHEETS.TEAMS);
  const th = getHeaders(teams);
  ['send_attachments', 'active'].forEach((h) => {
    const c = th.indexOf(h) + 1;
    if (c > 0) teams.getRange(2, c, rows, 1).setDataValidation(statusValidation(['TRUE', 'FALSE']));
  });
}

/**
 * Deletes all data rows (keeps headers) of a tab. Used by resetDemoData().
 * @param {string} name tab name.
 */
function clearDataRows(name) {
  const sh = getSheet(name);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(sh.getLastColumn(), 1)).clearContent();
}
