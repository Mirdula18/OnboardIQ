/**
 * @fileoverview One-time setup (tabs, labels, Drive folder, script properties, trigger),
 * trigger management, and demo/test helpers.
 */

/**
 * One-time setup. Run from the Apps Script editor of the bound Sheet. Safe to re-run:
 * it only adds what is missing and never overwrites Config values or Teams rows.
 * @return {string} summary.
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Open the Google Sheet → Extensions → Apps Script and run setup() from there.');
  setScriptProp(PROP_KEYS.SHEET_ID, ss.getId());

  ensureSchema(ss);
  const added = seedConfigDefaults(seedConfigValues(), CONFIG_NOTES);
  const seeded = seedTeamsIfEmpty(defaultTeamRows());
  applySheetFormatting();

  Object.keys(LABELS).forEach((k) => getOrCreateLabel(LABELS[k]));
  const folder = ensureRootFolder();
  _configCache = null;
  resetTrigger();

  const summary = [
    `Sheet: ${ss.getUrl()}`,
    `Config keys added: ${added.length ? added.join(', ') : 'none (already present)'}`,
    `Teams seeded: ${seeded ? 'yes (plus-aliases of this account)' : 'no (Teams tab already has rows)'}`,
    `Gmail labels: ${Object.keys(LABELS).map((k) => LABELS[k]).join(', ')}`,
    `Drive folder: ${folder.getUrl()}`,
    `Trigger: runAll() every ${getConfig().pollMinutes} min`,
    `DRY_RUN: ${getConfig().dryRun}`,
  ].join('\n');
  logEvent('INFO', 'SETUP_DONE', summary);
  Logger.log(summary);
  return summary;
}

/**
 * Config values used when seeding: defaults, with HR_EMAIL set to <you>+hr@<domain> for testing.
 * @return {Object<string,string>} values.
 */
function seedConfigValues() {
  const vals = Object.assign({}, DEFAULT_CONFIG);
  const hr = plusAlias('hr');
  if (hr) vals.HR_EMAIL = hr;
  return vals;
}

/**
 * Seed rows for the Teams tab (docs/DATA_MODEL.md): IDCARD, GATE, WIFI active;
 * FACILITY and EMAIL present but inactive. Addresses are plus-aliases of this account.
 * @return {Array<Object>} rows.
 */
function defaultTeamRows() {
  const row = (code, name, alias, attach, active) => ({
    team_code: code, team_name: name, to_emails: plusAlias(alias) || `${alias}@company.com`,
    cc_emails: '', send_attachments: attach ? 'TRUE' : 'FALSE',
    applies_to_locations: '', applies_to_departments: '', active: active ? 'TRUE' : 'FALSE',
  });
  return [
    row('IDCARD', 'ID Card', 'idcard', true, true),
    row('GATE', 'Gate Access', 'gate', false, true),
    row('WIFI', 'Wi-Fi / IT', 'wifi', false, true),
    row('FACILITY', 'Facility (desk/locker)', 'facility', false, false),
    row('EMAIL', 'Corporate Mailbox', 'email', false, false),
  ];
}

/**
 * '<local>+<tag>@<domain>' for the account running the script, or '' if unknown.
 * @param {string} tag alias tag.
 * @return {string} address.
 */
function plusAlias(tag) {
  const me = getBotEmail();
  const at = me.indexOf('@');
  return at > 0 ? `${me.slice(0, at)}+${tag}${me.slice(at)}` : '';
}

/**
 * Returns the root Drive folder, creating it (and saving ROOT_FOLDER_ID) if needed.
 * @return {GoogleAppsScript.Drive.Folder} folder.
 */
function ensureRootFolder() {
  const id = getScriptProp(PROP_KEYS.ROOT_FOLDER_ID);
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (e) {
      Logger.log('Saved ROOT_FOLDER_ID not accessible; creating a new folder.');
    }
  }
  const folder = DriveApp.createFolder(ROOT_FOLDER_NAME);
  setScriptProp(PROP_KEYS.ROOT_FOLDER_ID, folder.getId());
  return folder;
}

/**
 * Replaces the runAll() trigger using the current POLL_MINUTES.
 */
function resetTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'runAll')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  _configCache = null;
  const minutes = getConfig().pollMinutes;
  ScriptApp.newTrigger('runAll').timeBased().everyMinutes(minutes).create();
  Logger.log(`Trigger set: runAll() every ${minutes} min`);
}

/**
 * Removes all of this project's triggers (stops the bot). Data and labels are kept.
 */
function teardown() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  Logger.log('All triggers removed. Run resetTrigger() or setup() to start again.');
}

/**
 * DEMO RESET: clears Hires, Requests (incl. reply cursors) and Log rows and removes NH/* labels
 * from threads, so the same test emails can be processed again. Does not delete emails,
 * Drive files, Config or Teams.
 */
function resetDemoData() {
  [SHEETS.HIRES, SHEETS.REQUESTS, SHEETS.LOG].forEach((name) => clearDataRows(name));
  Object.keys(LABELS).forEach((k) => {
    if (LABELS[k] === LABELS.ROOT) return;
    const label = GmailApp.getUserLabelByName(LABELS[k]);
    if (!label) return;
    let threads = label.getThreads(0, 100);
    while (threads.length) {
      label.removeFromThreads(threads);
      threads = label.getThreads(0, 100);
    }
  });
  logEvent('INFO', 'DEMO_RESET', 'Hires/Requests/Log cleared, NH labels removed');
}

// ---------------------------------------------------------------- test helpers

/** Sample HR email body (docs/EMAIL_TEMPLATES.md §1). */
const SAMPLE_HR_BODY = [
  'Hi team,',
  '',
  'Please start onboarding for our new hire.',
  '',
  'Full Name: Priya Sharma',
  'Employee ID: EMP2045',
  'Department: Engineering',
  'Designation: Software Engineer',
  'Joining Date: 2026-11-10',
  'Location: Coimbatore Office',
  'Reporting Manager: Arun Kumar',
  'Email: priya.sharma@company.com',
  'Phone: +91 98xxxxxxx',
  '',
  'Attachments: offer_letter.pdf, id_proof.pdf',
  '',
  'Thanks,',
  'HR',
].join('\n');

/**
 * Sends the sample HR email (with 2 PDF attachments) to <you>+hr@… — ALWAYS really sends,
 * even in DRY_RUN, because it is test input, not bot output. It comes from your own account,
 * so the bot only picks it up when SELF_TEST_MODE = TRUE (or forward it from a second account).
 * @param {Object=} overrides optional {subject, body}.
 */
function sendSampleHrEmail(overrides) {
  const o = overrides || {};
  const pdf = (name, title) => Utilities.newBlob(
    `<h1>${title}</h1><p>Sample document for Priya Sharma (EMP2045).</p>`, 'text/html', `${name}.html`,
  ).getAs('application/pdf').setName(`${name}.pdf`);
  send({
    to: plusAlias('hr') || getBotEmail(),
    subject: o.subject || 'New Hire – Priya Sharma',
    body: o.body || SAMPLE_HR_BODY,
    attachments: [pdf('offer_letter', 'Offer Letter'), pdf('id_proof', 'ID Proof')],
    ref: 'TEST',
    forceSend: true,
  });
  Logger.log('Sample HR email sent. Now run runAll().');
}

/**
 * T4: sends the sample HR email without the Employee ID line (expect NEEDS_INFO + §6 reply).
 */
function sendSampleHrEmailMissingId() {
  sendSampleHrEmail({
    subject: 'New Hire – Rahul Verma',
    body: SAMPLE_HR_BODY.replace('Priya Sharma', 'Rahul Verma').replace(/^Employee ID:.*\n/m, ''),
  });
}
