/**
 * @fileoverview Entry points: runAll() (time-driven trigger) and onEdit() (manual overrides),
 * plus the new-hire pipeline, reminders and manual-override sync.
 */

/**
 * Main entry point, called by the time-driven trigger every POLL_MINUTES.
 * Takes the script lock (exits quietly if busy); each step is isolated so one failure
 * doesn't stop the others.
 */
function runAll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log('runAll: another run holds the lock; exiting.');
    return;
  }
  try {
    const cfg = getConfig();
    Logger.log(`runAll: DRY_RUN=${cfg.dryRun} SELF_TEST_MODE=${cfg.selfTestMode}`);
    runStep('processNewHireEmails', processNewHireEmails);
    runStep('processReplies', processReplies);
    runStep('sendReminders', sendReminders);
    runStep('syncManualOverrides', syncManualOverrides);
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

/**
 * Runs one pipeline step, logging (not throwing) any error.
 * @param {string} name step name.
 * @param {Function} fn step function.
 */
function runStep(name, fn) {
  if (isTimeUp()) {
    logEvent('WARN', 'TIME_LIMIT', `Skipped ${name}; will continue next run`);
    return;
  }
  try {
    fn();
  } catch (e) {
    logEvent('ERROR', 'STEP_FAILED', `${name}: ${e && e.stack || e}`);
  }
}

/**
 * Simple trigger: when a human edits Requests.status, mark the row manual_override = TRUE.
 * @param {GoogleAppsScript.Events.SheetsOnEdit} e edit event.
 */
function onEdit(e) {
  try {
    markManualOverrideFromEdit(e);
  } catch (err) {
    console.error(`onEdit: ${err}`);
  }
}

// ---------------------------------------------------------------- new-hire pipeline

/**
 * Finds and processes new HR emails (and HR follow-ups in NEEDS_INFO threads).
 * Each email is isolated: errors are logged, the thread is labeled NH/Error, the batch continues.
 */
function processNewHireEmails() {
  const cfg = getConfig();
  const followUps = findNeedsInfoFollowUps(cfg);
  const fresh = findNewHireMessages(cfg).map((msg) => ({ msg, hire: null }));
  const items = followUps.concat(fresh).slice(0, cfg.maxEmailsPerRun);
  if (items.length) logEvent('INFO', 'HR_EMAILS_FOUND', `${items.length} email(s) to process`);
  items.forEach(({ msg, hire }) => {
    if (isTimeUp()) return;
    try {
      processHireMessage(msg, cfg, hire);
    } catch (e) {
      logEvent('ERROR', 'HR_EMAIL_FAILED', String(e && e.stack || e), msg.getId());
      msg.getThread().addLabel(getOrCreateLabel(LABELS.ERROR));
    }
  });
}

/**
 * One HR email: sender check → parse → dedupe → insert/update hire → save attachments →
 * NEEDS_INFO reply or dispatch → label NH/Processed.
 * @param {GoogleAppsScript.Gmail.GmailMessage} msg HR email.
 * @param {Object} cfg config.
 * @param {Object|null} knownHire the NEEDS_INFO hire this message follows up on, if any.
 */
function processHireMessage(msg, cfg, knownHire) {
  const thread = msg.getThread();
  const ref = msg.getId();
  if (!isAllowedSender(msg, cfg)) {
    logEvent('WARN', 'SENDER_NOT_ALLOWED', `Ignored email from ${msg.getFrom()}: "${msg.getSubject()}"`, ref);
    thread.addLabel(getOrCreateLabel(LABELS.IGNORED));
    return;
  }

  const parsed = parseHire(msg.getPlainBody(), msg.getSubject());
  const missing = validateHire(parsed);
  const existing = findExistingHire(parsed);

  if (existing && (!knownHire || existing.hire_no !== knownHire.hire_no)
      && existing.status !== HIRE_STATUS.NEEDS_INFO) {
    thread.addLabel(getOrCreateLabel(LABELS.DUPLICATE));
    thread.addLabel(getOrCreateLabel(LABELS.PROCESSED));
    logEvent('INFO', 'DUPLICATE_HIRE', `Already tracked as ${existing.hire_no} (${existing.status}); nothing sent`, existing.hire_no);
    return;
  }

  const target = knownHire || existing;
  const hireNo = target ? mergeIntoHire(target, parsed, ref) : insertHire(toHireRecord(parsed, ref));
  logEvent('INFO', 'NEW_HIRE_PARSED', parsed, hireNo);

  let hire = getHire(hireNo);
  const saved = saveAttachments(msg, hire);
  updateHire(hireNo, { drive_folder_url: saved.folderUrl });
  logEvent('INFO', 'ATTACHMENTS_SAVED', `${saved.names.length} file(s): ${saved.names.join(', ')}`, hireNo);
  hire = getHire(hireNo);

  if (missing.length) {
    updateHire(hireNo, { status: HIRE_STATUS.NEEDS_INFO });
    notifyHrNeedsInfo(hire, missing, msg);
    thread.addLabel(getOrCreateLabel(LABELS.PROCESSED));
    thread.addLabel(getOrCreateLabel(LABELS.NEEDS_INFO));
    logEvent('WARN', 'HIRE_NEEDS_INFO', `Missing: ${missing.join(', ')}`, hireNo);
    return;
  }

  const sent = dispatchRequestsForHire(hire);
  const reqs = getRequestsForHire(hireNo);
  const status = reqs.some((r) => r.status !== REQ_STATUS.PENDING) ? HIRE_STATUS.DISPATCHED : HIRE_STATUS.NEW;
  updateHire(hireNo, { status });
  thread.addLabel(getOrCreateLabel(LABELS.PROCESSED));
  thread.removeLabel(getOrCreateLabel(LABELS.NEEDS_INFO));
  logEvent('INFO', 'HIRE_DISPATCHED', `${sent} request(s) sent; hire ${status}`, hireNo);
}

/**
 * Dedupe lookup: employee_id first; fallback name + joining date (only when one side has no id,
 * so two different employee ids are never treated as the same person).
 * @param {Object} parsed parsed hire.
 * @return {Object|null} existing hire row.
 */
function findExistingHire(parsed) {
  const byId = findHireByEmployeeId(parsed.employeeId);
  if (byId) return byId;
  const byName = findHireByNameAndDate(parsed.fullName, parsed.joiningDate);
  if (byName && (!byName.employee_id || !parsed.employeeId)) return byName;
  return null;
}

/**
 * Parsed hire → Hires row (hire_no is assigned by insertHire).
 * @param {Object} p parsed hire.
 * @param {string} messageId source Gmail message id.
 * @return {Object} record.
 */
function toHireRecord(p, messageId) {
  return {
    employee_id: p.employeeId, full_name: p.fullName, department: p.department,
    designation: p.designation, joining_date: p.joiningDate, location: p.location,
    manager: p.manager, contact_email: p.email, phone: p.phone, drive_folder_url: '',
    source_message_id: messageId, status: HIRE_STATUS.NEW, created_at: nowIso(), completed_at: '',
  };
}

/**
 * Updates a NEEDS_INFO hire with newly supplied (non-blank) fields from a follow-up email.
 * @param {Object} hire existing hire row.
 * @param {Object} parsed parsed hire.
 * @param {string} messageId follow-up Gmail message id (becomes source_message_id).
 * @return {string} hire_no.
 */
function mergeIntoHire(hire, parsed, messageId) {
  const rec = toHireRecord(parsed, messageId);
  const patch = { source_message_id: messageId };
  ['employee_id', 'full_name', 'department', 'designation', 'joining_date', 'location',
    'manager', 'contact_email', 'phone'].forEach((k) => { if (rec[k]) patch[k] = rec[k]; });
  updateHire(hire.hire_no, patch);
  return hire.hire_no;
}

// ---------------------------------------------------------------- reminders + overrides

/**
 * Sends §7 reminders for SENT requests older than REMINDER_HOURS; after MAX_REMINDERS the
 * request becomes OVERDUE and HR gets §8.
 */
function sendReminders() {
  const cfg = getConfig();
  getPendingRequestsOlderThan(cfg.reminderHours).forEach((req) => {
    if (isTimeUp()) return;
    try {
      const hire = getHire(req.hire_no);
      const team = getTeamByCode(req.team_code) || { team_code: req.team_code, team_name: req.team_code, to_emails: [], cc_emails: [] };
      if (!hire || hire.status === HIRE_STATUS.COMPLETED) return;
      const count = toNumber(req.reminder_count, 0);
      if (count < cfg.maxReminders) {
        sendReminder(hire, req, team, count + 1);
        updateRequest(req.request_id, { reminder_count: String(count + 1), last_reminder_at: nowIso() });
        logEvent('INFO', 'REMINDER_SENT', `Reminder ${count + 1}/${cfg.maxReminders}`, req.request_id);
      } else {
        updateRequest(req.request_id, { status: REQ_STATUS.OVERDUE });
        notifyHrOverdue(hire, req, team);
        logEvent('WARN', 'REQUEST_OVERDUE', `No reply after ${cfg.maxReminders} reminders`, req.request_id);
        checkHireCompletion(req.hire_no);
      }
    } catch (e) {
      logEvent('ERROR', 'REMINDER_FAILED', String(e && e.stack || e), req.request_id);
    }
  });
}

/**
 * Re-checks completion for hires where HR changed a request status by hand (FR-5.7).
 */
function syncManualOverrides() {
  getHireNosWithManualOverrides().forEach((hireNo) => {
    try {
      checkHireCompletion(hireNo);
    } catch (e) {
      logEvent('ERROR', 'OVERRIDE_SYNC_FAILED', String(e && e.stack || e), hireNo);
    }
  });
}
