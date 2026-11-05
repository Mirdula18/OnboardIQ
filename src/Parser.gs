/**
 * @fileoverview Extracts new-hire fields from an HR email body (docs/EMAIL_TEMPLATES.md §1).
 */

/** Label synonyms per field (normalized: lowercase, letters/digits/spaces only). */
const FIELD_SYNONYMS = {
  fullName: ['full name', 'name', 'employee name', 'candidate name', 'new hire name'],
  employeeId: ['employee id', 'emp id', 'employee no', 'employee number', 'emp no', 'emp code',
    'employee code', 'emp id no'],
  department: ['department', 'dept'],
  designation: ['designation', 'role', 'title', 'job title', 'position'],
  joiningDate: ['joining date', 'date of joining', 'doj', 'start date', 'join date'],
  location: ['location', 'work location', 'office', 'office location', 'work location office'],
  manager: ['reporting manager', 'manager', 'manager name', 'reporting manager name', 'reports to'],
  email: ['email', 'e mail', 'email id', 'personal email', 'work email', 'official email'],
  phone: ['phone', 'phone number', 'mobile', 'mobile number', 'contact number', 'contact'],
};

/** Required fields and their display labels (FR-3.2). */
const REQUIRED_FIELDS = [
  ['fullName', 'Full Name'],
  ['employeeId', 'Employee ID'],
  ['joiningDate', 'Joining Date'],
];

/** `Label: value` (or `Label - value` with spaces around the dash). */
const FIELD_LINE_RE = /^\s*[•\-*]?\s*([A-Za-z][A-Za-z0-9 .()\/#'_-]{0,40}?)\s*(?::|\s[-–—]\s)\s*(.*?)\s*$/;

/**
 * Parses hire fields from a plain-text body. Lines starting with '>' (quoted history) are skipped,
 * the first occurrence of each field wins, and the subject is a fallback for the name
 * ("New Hire – Priya Sharma").
 * @param {string} body plain-text body.
 * @param {string} subject subject line.
 * @return {{fullName: string, employeeId: string, department: string, designation: string,
 *   joiningDate: string, location: string, manager: string, email: string, phone: string}} hire.
 */
function parseHire(body, subject) {
  const out = {};
  Object.keys(FIELD_SYNONYMS).forEach((f) => { out[f] = ''; });
  const index = buildLabelIndex();
  String(body || '').replace(/\r\n?/g, '\n').split('\n').forEach((raw) => {
    if (raw.trim().indexOf('>') === 0) return;
    const m = FIELD_LINE_RE.exec(raw.replace(/\*/g, ''));
    if (!m) return;
    const field = index[normalizeLabel(m[1])];
    if (!field || out[field]) return;
    out[field] = cleanValue(m[2]);
  });
  if (!out.fullName) {
    const sm = /(?:new\s+(?:hire|joiner|joinee)|onboarding)\s*(?::|[-–—])\s*(.+)$/i.exec(String(subject || ''));
    if (sm) out.fullName = cleanValue(sm[1]);
  }
  out.employeeId = out.employeeId.replace(/\s+/g, '');
  out.joiningDate = normalizeDate(out.joiningDate);
  return out;
}

/**
 * Lists the required fields that are blank.
 * @param {Object} hire parsed hire.
 * @return {Array<string>} display labels of missing fields (empty = valid).
 */
function validateHire(hire) {
  return REQUIRED_FIELDS.filter(([key]) => !String(hire[key] || '').trim()).map(([, label]) => label);
}

/**
 * Builds the normalized-label → field lookup.
 * @return {Object<string,string>} index.
 */
function buildLabelIndex() {
  const idx = {};
  Object.keys(FIELD_SYNONYMS).forEach((f) => FIELD_SYNONYMS[f].forEach((s) => { idx[s] = f; }));
  return idx;
}

/**
 * Normalizes a label: lowercase, drop (…), punctuation → space, collapse spaces.
 * @param {string} label raw label.
 * @return {string} normalized label.
 */
function normalizeLabel(label) {
  return String(label).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Cleans a value: strips Gmail '<mailto:…>' / '<http…>' suffixes, '[…]' notes and placeholder dots.
 * @param {string} v raw value.
 * @return {string} cleaned value ('' for placeholders like '...').
 */
function cleanValue(v) {
  const s = String(v || '')
    .replace(/\s*<(?:mailto:|https?:)[^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return /^[.…\-–_\s]*$/.test(s) ? '' : s;
}
