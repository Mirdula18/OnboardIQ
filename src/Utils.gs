/**
 * @fileoverview Tag build/parse, date helpers, text helpers, Gmail label + bot-identity helpers.
 */

const TZ = 'Asia/Kolkata';
const IST_OFFSET = '+05:30'; // Asia/Kolkata has no DST.
const TAG_REGEX = /\[NH-(\d+)-([A-Z0-9_]+)\]/;
const RUN_STARTED_AT = Date.now();

let _labelCache = {};
let _botEmail = null;

// ---------------------------------------------------------------- tags

/**
 * Builds the tracking tag, e.g. buildTag('NH-1023', 'WIFI') → '[NH-1023-WIFI]'.
 * @param {string|number} hireNo 'NH-1023' or 1023.
 * @param {string} teamCode team code (A-Z0-9_).
 * @return {string} tag with brackets.
 */
function buildTag(hireNo, teamCode) {
  const num = hireNumber(hireNo);
  const code = String(teamCode || '').trim().toUpperCase();
  if (!/^\d+$/.test(num)) throw new Error(`buildTag: bad hireNo "${hireNo}"`);
  if (!/^[A-Z0-9_]+$/.test(code)) throw new Error(`buildTag: bad teamCode "${teamCode}"`);
  return `[NH-${num}-${code}]`;
}

/**
 * Parses a tracking tag out of a subject.
 * @param {string} subject email subject.
 * @return {{hireNo: string, teamCode: string}|null} e.g. {hireNo:'NH-1023', teamCode:'WIFI'}.
 */
function parseTag(subject) {
  const m = TAG_REGEX.exec(String(subject || ''));
  return m ? { hireNo: `NH-${m[1]}`, teamCode: m[2] } : null;
}

/**
 * Request id = tag without brackets, e.g. 'NH-1023-WIFI'.
 * @param {string} hireNo hire number.
 * @param {string} teamCode team code.
 * @return {string} request id.
 */
function buildRequestId(hireNo, teamCode) {
  return buildTag(hireNo, teamCode).slice(1, -1);
}

/**
 * Numeric part of a hire number: 'NH-1023' → '1023'.
 * @param {string|number} hireNo hire number.
 * @return {string} digits.
 */
function hireNumber(hireNo) {
  return String(hireNo || '').trim().replace(/^NH-/i, '');
}

// ---------------------------------------------------------------- dates

/**
 * Current time as ISO string in Asia/Kolkata, e.g. '2026-11-05T20:15:00+05:30'.
 * @return {string} ISO timestamp.
 */
function nowIso() {
  return toIso(new Date());
}

/**
 * Formats a Date as ISO in Asia/Kolkata.
 * @param {Date} date date.
 * @return {string} ISO timestamp.
 */
function toIso(date) {
  return `${Utilities.formatDate(date, TZ, "yyyy-MM-dd'T'HH:mm:ss")}${IST_OFFSET}`;
}

/**
 * Formats an ISO string for display in IST, e.g. '05 Nov 2026, 08:15 PM IST'.
 * @param {string} iso ISO timestamp.
 * @return {string} display string ('' if blank).
 */
function formatDisplay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return `${Utilities.formatDate(d, TZ, 'dd MMM yyyy, hh:mm a')} IST`;
}

/**
 * Hours from a to b (b defaults to now). NaN if a is not a valid date.
 * @param {string|Date} a start.
 * @param {string|Date=} b end.
 * @return {number} hours.
 */
function hoursBetween(a, b) {
  const da = new Date(a);
  const db = b ? new Date(b) : new Date();
  if (!a || isNaN(da.getTime()) || isNaN(db.getTime())) return NaN;
  return (db.getTime() - da.getTime()) / 36e5;
}

/**
 * Normalizes a date string to YYYY-MM-DD. Accepts YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY,
 * DD.MM.YYYY and text dates like '10 Nov 2026'. Returns the trimmed input if unparseable.
 * @param {string} s raw date.
 * @return {string} normalized date.
 */
function normalizeDate(s) {
  const str = String(s || '').trim();
  if (!str) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const valid = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900;
  let m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/.exec(str);
  if (m && valid(+m[1], +m[2], +m[3])) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/.exec(str);
  if (m && valid(+m[3], +m[2], +m[1])) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  const d = new Date(str.replace(/(\d)(st|nd|rd|th)\b/i, '$1'));
  if (!isNaN(d.getTime()) && d.getFullYear() >= 1900) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return str;
}

// ---------------------------------------------------------------- text

/**
 * Removes quoted history from a reply: cuts at 'On ... wrote:', '>' lines, Outlook headers,
 * 'Original Message' and forwarded-message markers.
 * @param {string} text plain-text body.
 * @return {string} only the new part of the reply, trimmed.
 */
function stripQuoted(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const next = (lines[i + 1] || '').trim();
    if (t.indexOf('>') === 0) break;
    if (/^On\s.+/i.test(t) && (/wrote:\s*$/i.test(t) || /wrote:\s*$/i.test(next))) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(t)) break;
    if (/^-{2,}\s*Forwarded message/i.test(t)) break;
    if (/^_{10,}$/.test(t)) break;
    if (/^From:\s.+/i.test(t) && /^(Sent|Date|To):/i.test(next)) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

/**
 * Splits a comma/semicolon/newline separated string (or array) into trimmed non-empty items.
 * @param {string|Array<string>} s input.
 * @return {Array<string>} items.
 */
function splitList(s) {
  if (Array.isArray(s)) return s.map((x) => String(x).trim()).filter(Boolean);
  return String(s || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
}

/**
 * Truthy config/sheet values: TRUE, YES, Y, 1 (case-insensitive) or boolean true.
 * @param {*} v value.
 * @return {boolean} parsed boolean.
 */
function toBool(v) {
  return ['TRUE', 'YES', 'Y', '1'].indexOf(String(v).trim().toUpperCase()) >= 0;
}

/**
 * Parses a number with a fallback.
 * @param {*} v value.
 * @param {number} fallback default.
 * @return {number} number.
 */
function toNumber(v, fallback) {
  const n = Number(v);
  return isNaN(n) || String(v).trim() === '' ? fallback : n;
}

/**
 * Extracts the bare, lowercased address from a From header: 'A <a@x.com>' → 'a@x.com'.
 * @param {string} from header value.
 * @return {string} email address.
 */
function extractEmail(from) {
  const m = /<([^>]+)>/.exec(String(from || ''));
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

/**
 * Escapes HTML special characters.
 * @param {string} s text.
 * @return {string} escaped text.
 */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Escapes a string for use inside a RegExp.
 * @param {string} s text.
 * @return {string} escaped.
 */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when this execution is close to the Apps Script time limit.
 * @return {boolean} time is up.
 */
function isTimeUp() {
  return Date.now() - RUN_STARTED_AT > MAX_RUN_MS;
}

// ---------------------------------------------------------------- gmail helpers

/**
 * Gets or creates a Gmail user label (cached per execution).
 * @param {string} name label name, e.g. 'NH/Processed'.
 * @return {GoogleAppsScript.Gmail.GmailLabel} label.
 */
function getOrCreateLabel(name) {
  if (_labelCache[name]) return _labelCache[name];
  const label = GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
  _labelCache[name] = label;
  return label;
}

/**
 * True if the thread carries any of the given labels.
 * @param {GoogleAppsScript.Gmail.GmailThread} thread thread.
 * @param {Array<string>} names label names.
 * @return {boolean} has label.
 */
function threadHasAnyLabel(thread, names) {
  const have = thread.getLabels().map((l) => l.getName());
  return names.some((n) => have.indexOf(n) >= 0);
}

/**
 * The bot account's email address (lowercase).
 * @return {string} email.
 */
function getBotEmail() {
  if (_botEmail === null) _botEmail = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  return _botEmail;
}

/**
 * True if the message was sent by the bot's own account address (exact address, aliases differ).
 * @param {GoogleAppsScript.Gmail.GmailMessage} msg message.
 * @return {boolean} from bot.
 */
function isFromBot(msg) {
  const bot = getBotEmail();
  return !!bot && extractEmail(msg.getFrom()) === bot;
}

/**
 * True if the message was written by this bot: sent from the bot account AND its new
 * (unquoted) text contains the bot signature "— <BOT_NAME>". Used in SELF_TEST_MODE.
 * @param {GoogleAppsScript.Gmail.GmailMessage} msg message.
 * @param {Object} cfg config.
 * @return {boolean} bot generated.
 */
function isBotGenerated(msg, cfg) {
  if (!isFromBot(msg)) return false;
  return stripQuoted(msg.getPlainBody()).indexOf(`— ${cfg.botName}`) >= 0;
}

/**
 * True if the message counts as the bot's own: in SELF_TEST_MODE only bot-generated mail
 * (signature check), otherwise anything sent from the bot account.
 * @param {GoogleAppsScript.Gmail.GmailMessage} msg message.
 * @param {Object} cfg config.
 * @return {boolean} own message.
 */
function isOwnMessage(msg, cfg) {
  return cfg.selfTestMode ? isBotGenerated(msg, cfg) : isFromBot(msg);
}
