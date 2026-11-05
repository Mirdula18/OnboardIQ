/**
 * @fileoverview Constants, defaults and config readers (Config tab + Script Properties).
 */

/** Default values for every key in the Config tab (docs/DATA_MODEL.md). */
const DEFAULT_CONFIG = {
  HR_EMAIL: 'hr@company.com',
  HR_SENDERS: '',
  STAKEHOLDER_CC: '',
  NEW_HIRE_KEYWORDS: 'new hire, new joiner, new joinee, onboarding',
  APPROVAL_KEYWORDS: 'access provided, access granted, granted, done, completed, activated',
  BLOCK_KEYWORDS: 'rejected, cannot, need more info, missing, not possible',
  POLL_MINUTES: '5',
  REMINDER_HOURS: '24',
  MAX_REMINDERS: '2',
  MAX_EMAILS_PER_RUN: '20',
  DRY_RUN: 'TRUE',
  BOT_NAME: 'OnboardIQ',
  SELF_TEST_MODE: 'FALSE',
};

/** Human-readable notes written next to each Config key by setup(). */
const CONFIG_NOTES = {
  HR_EMAIL: 'Receives all confirmations (comma-separated allowed)',
  HR_SENDERS: 'Comma-separated allowed senders for new-hire emails. Blank = anyone',
  STAKEHOLDER_CC: 'Comma-separated CCs on HR confirmations',
  NEW_HIRE_KEYWORDS: 'Subject/body keywords that mark a new-hire email',
  APPROVAL_KEYWORDS: 'Reply keywords meaning access is provided',
  BLOCK_KEYWORDS: 'Reply keywords meaning blocked / needs info (checked first)',
  POLL_MINUTES: '1, 5, 10 or 15. Run resetTrigger() after changing',
  REMINDER_HOURS: 'Hours before a reminder is sent for an unanswered request',
  MAX_REMINDERS: 'Reminders before a request is marked OVERDUE',
  MAX_EMAILS_PER_RUN: 'Max HR emails / replies handled per run',
  DRY_RUN: 'TRUE = log emails to the Log tab instead of sending',
  BOT_NAME: 'Sender display name and email signature',
  SELF_TEST_MODE: 'TRUE = single-inbox testing: do not exclude from:me; bot mail is detected by its signature',
};

/** Gmail label names (docs/ARCHITECTURE.md §4). */
const LABELS = {
  ROOT: 'NH',
  PROCESSED: 'NH/Processed',
  DUPLICATE: 'NH/Duplicate',
  ERROR: 'NH/Error',
  REQUEST: 'NH/Request',
  REPLY_PROCESSED: 'NH/ReplyProcessed',
  IGNORED: 'NH/Ignored',
  NEEDS_INFO: 'NH/NeedsInfo',
};

/** Sheet tab names. */
const SHEETS = {
  CONFIG: 'Config',
  TEAMS: 'Teams',
  HIRES: 'Hires',
  REQUESTS: 'Requests',
  LOG: 'Log',
};

/** Column headers per tab (docs/DATA_MODEL.md). */
const HEADERS = {
  Config: ['key', 'value', 'notes'],
  Teams: ['team_code', 'team_name', 'to_emails', 'cc_emails', 'send_attachments',
    'applies_to_locations', 'applies_to_departments', 'active'],
  Hires: ['hire_no', 'employee_id', 'full_name', 'department', 'designation', 'joining_date',
    'location', 'manager', 'contact_email', 'phone', 'drive_folder_url', 'source_message_id',
    'status', 'created_at', 'completed_at'],
  Requests: ['request_id', 'hire_no', 'team_code', 'status', 'thread_id', 'sent_at',
    'last_reminder_at', 'reminder_count', 'replied_by', 'reply_snippet', 'confirmed_at',
    'manual_override', 'last_processed_msg_id'],
  Log: ['timestamp', 'level', 'action', 'ref', 'details'],
};

/** Hire status values. */
const HIRE_STATUS = {
  NEW: 'NEW',
  NEEDS_INFO: 'NEEDS_INFO',
  DISPATCHED: 'DISPATCHED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
};

/** Request status values. */
const REQ_STATUS = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  PROVIDED: 'PROVIDED',
  BLOCKED: 'BLOCKED',
  REPLIED_UNCLEAR: 'REPLIED_UNCLEAR',
  OVERDUE: 'OVERDUE',
};

/** Script Property keys. */
const PROP_KEYS = {
  SHEET_ID: 'SHEET_ID',
  ROOT_FOLDER_ID: 'ROOT_FOLDER_ID',
};

/** Root Drive folder name. */
const ROOT_FOLDER_NAME = 'Onboarding Access Bot';

/** Max execution time we allow ourselves (Apps Script hard limit is ~6 min). */
const MAX_RUN_MS = 4.5 * 60 * 1000;

let _configCache = null;
let _allTeamsCache = null;

/**
 * Returns the merged, typed config (Config tab over defaults). Cached per execution.
 * @return {Object} typed config object.
 */
function getConfig() {
  if (_configCache) return _configCache;
  let raw = {};
  try {
    raw = readConfigMap();
  } catch (e) {
    Logger.log(`getConfig: could not read Config tab, using defaults (${e})`);
  }
  _configCache = buildConfig(raw);
  return _configCache;
}

/**
 * Pure: builds a typed config object from a raw key/value map (blank values fall back to defaults).
 * @param {Object<string,string>} raw key/value map from the Config tab.
 * @return {Object} typed config.
 */
function buildConfig(raw) {
  const get = (k) => {
    const v = raw && raw[k] !== undefined ? String(raw[k]).trim() : '';
    return v !== '' ? v : DEFAULT_CONFIG[k];
  };
  const pollRaw = parseInt(get('POLL_MINUTES'), 10);
  return {
    hrEmail: splitList(get('HR_EMAIL')),
    hrSenders: splitList(get('HR_SENDERS')).map((s) => s.toLowerCase()),
    stakeholderCc: splitList(get('STAKEHOLDER_CC')),
    newHireKeywords: splitList(get('NEW_HIRE_KEYWORDS')).map((s) => s.toLowerCase()),
    approvalKeywords: splitList(get('APPROVAL_KEYWORDS')).map((s) => s.toLowerCase()),
    blockKeywords: splitList(get('BLOCK_KEYWORDS')).map((s) => s.toLowerCase()),
    pollMinutes: [1, 5, 10, 15].indexOf(pollRaw) >= 0 ? pollRaw : 5,
    reminderHours: toNumber(get('REMINDER_HOURS'), 24),
    maxReminders: toNumber(get('MAX_REMINDERS'), 2),
    maxEmailsPerRun: toNumber(get('MAX_EMAILS_PER_RUN'), 20),
    dryRun: toBool(get('DRY_RUN')),
    botName: get('BOT_NAME'),
    selfTestMode: toBool(get('SELF_TEST_MODE')),
  };
}

/**
 * Returns all valid, active teams from the Teams tab.
 * @return {Array<Object>} normalized team objects.
 */
function getTeams() {
  return getAllTeams().filter((t) => t.active);
}

/**
 * Returns all valid teams (active or not), normalized. Cached per execution.
 * @return {Array<Object>} normalized team objects.
 */
function getAllTeams() {
  if (_allTeamsCache) return _allTeamsCache;
  const teams = [];
  readTeamRows().forEach((r) => {
    const code = String(r.team_code || '').trim().toUpperCase();
    if (!code) return;
    if (!/^[A-Z0-9_]+$/.test(code)) {
      logEvent('WARN', 'TEAM_INVALID_CODE', `team_code "${code}" must be A-Z, 0-9 or _`, code);
      return;
    }
    const team = {
      team_code: code,
      team_name: String(r.team_name || code).trim(),
      to_emails: splitList(r.to_emails),
      cc_emails: splitList(r.cc_emails),
      send_attachments: toBool(r.send_attachments),
      applies_to_locations: splitList(r.applies_to_locations).map((s) => s.toLowerCase()),
      applies_to_departments: splitList(r.applies_to_departments).map((s) => s.toLowerCase()),
      active: toBool(r.active),
    };
    if (team.active && team.to_emails.length === 0) {
      logEvent('WARN', 'TEAM_NO_EMAIL', 'Active team has no to_emails; skipped', code);
      team.active = false;
    }
    teams.push(team);
  });
  _allTeamsCache = teams;
  return teams;
}

/**
 * Finds a team (active or inactive) by code.
 * @param {string} code team code.
 * @return {Object|null} team or null.
 */
function getTeamByCode(code) {
  const c = String(code || '').toUpperCase();
  return getAllTeams().find((t) => t.team_code === c) || null;
}

/**
 * Reads a Script Property.
 * @param {string} key property key.
 * @return {string|null} value.
 */
function getScriptProp(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

/**
 * Writes a Script Property.
 * @param {string} key property key.
 * @param {string} value value.
 */
function setScriptProp(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
}
