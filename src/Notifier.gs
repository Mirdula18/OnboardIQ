/**
 * @fileoverview send() is the ONLY function that sends mail. It honors DRY_RUN and quota checks.
 * The notify* helpers build a template (Templates.gs) and call send().
 */

/**
 * Sends (or, in DRY_RUN, logs) one email. Replies in-thread when threadId is given.
 * @param {{to: (string|Array<string>), cc: (string|Array<string>)=, subject: string, body: string,
 *   htmlBody: string=, attachments: Array<GoogleAppsScript.Base.Blob>=, threadId: string=,
 *   label: string=, ref: string=, forceSend: boolean=}} opts
 *   forceSend bypasses DRY_RUN — only for the test helpers in Setup.gs.
 * @return {{dryRun: boolean, threadId: string, messageId: string}} result; threadId is 'DRYRUN-…'
 *   and messageId is '' in dry-run mode.
 */
function send(opts) {
  const cfg = getConfig();
  const to = splitList(opts.to).join(',');
  const cc = splitList(opts.cc).join(',');
  const attachments = opts.attachments || [];
  if (!to && !opts.threadId) throw new Error('send(): "to" or "threadId" is required');

  if (cfg.dryRun && !opts.forceSend) {
    const threadId = opts.threadId || `DRYRUN-${Utilities.getUuid().slice(0, 8)}`;
    logEvent('DRYRUN', 'EMAIL_NOT_SENT', {
      to, cc, subject: opts.subject, threadId: opts.threadId || '(new thread)',
      attachments: attachments.map((b) => b.getName()), body: String(opts.body || '').slice(0, 2000),
    }, opts.ref);
    return { dryRun: true, threadId, messageId: '' };
  }

  checkQuota();
  const thread = getThreadSafe(opts.threadId);
  let sentMsg;
  if (thread) {
    sentMsg = replyInThread(thread, opts, to, cc, cfg);
  } else {
    if (!to) throw new Error(`send(): thread ${opts.threadId} not found and no "to" address`);
    if (opts.threadId) logEvent('WARN', 'THREAD_NOT_FOUND', `Sending as new email instead of reply to ${opts.threadId}`, opts.ref);
    sentMsg = GmailApp.createDraft(to, opts.subject, opts.body, mailOptions(cfg, opts, cc)).send();
  }
  const sentThread = sentMsg.getThread();
  if (opts.label) sentThread.addLabel(getOrCreateLabel(opts.label));
  logEvent('INFO', 'EMAIL_SENT', { to, cc, subject: opts.subject, threadId: sentThread.getId() }, opts.ref);
  return { dryRun: false, threadId: sentThread.getId(), messageId: sentMsg.getId() };
}

/**
 * Replies in an existing thread. Targets the latest message not sent by the bot (so the reply
 * goes to the other party); if every message is the bot's, replies to the last one and adds the
 * intended recipients as CC so they still receive it.
 * @param {GoogleAppsScript.Gmail.GmailThread} thread thread.
 * @param {Object} opts send() options.
 * @param {string} to comma-separated recipients.
 * @param {string} cc comma-separated cc.
 * @param {Object} cfg config.
 * @return {GoogleAppsScript.Gmail.GmailMessage} the sent reply.
 */
function replyInThread(thread, opts, to, cc, cfg) {
  const msgs = thread.getMessages();
  const others = msgs.filter((m) => !isFromBot(m));
  const target = others.length ? others[others.length - 1] : msgs[msgs.length - 1];
  const bot = getBotEmail();
  const ccList = splitList(cc).concat(isFromBot(target) ? splitList(to) : [])
    .filter((a, i, arr) => extractEmail(a) !== bot && arr.indexOf(a) === i);
  return target.createDraftReplyAll(opts.body, mailOptions(cfg, opts, ccList.join(','))).send();
}

/**
 * Builds GmailApp advanced options.
 * @param {Object} cfg config.
 * @param {Object} opts send() options.
 * @param {string} cc comma-separated cc.
 * @return {Object} options.
 */
function mailOptions(cfg, opts, cc) {
  const o = { name: cfg.botName };
  if (opts.htmlBody) o.htmlBody = opts.htmlBody;
  if (cc) o.cc = cc;
  if (opts.attachments && opts.attachments.length) o.attachments = opts.attachments;
  return o;
}

/**
 * Returns a thread by id, or null for blank / DRYRUN / missing ids.
 * @param {string} threadId id.
 * @return {GoogleAppsScript.Gmail.GmailThread|null} thread.
 */
function getThreadSafe(threadId) {
  if (!threadId || String(threadId).indexOf('DRYRUN') === 0) return null;
  try {
    return GmailApp.getThreadById(threadId);
  } catch (e) {
    return null;
  }
}

/**
 * Throws when the daily quota is exhausted; logs a WARN when it is below 20 (NFR-7).
 */
function checkQuota() {
  const left = MailApp.getRemainingDailyQuota();
  if (left <= 0) throw new Error('Daily email quota exhausted');
  if (left < 20) logEvent('WARN', 'LOW_QUOTA', `Remaining daily email quota: ${left}`);
}

/**
 * Short display name from a From header: 'Wi-Fi Team <it@x.com>' → 'Wi-Fi Team <it@x.com>' trimmed of quotes.
 * @param {string} from header.
 * @return {string} display.
 */
function displayFrom(from) {
  return String(from || '').replace(/"/g, '').trim();
}

/**
 * §3 — tells HR one team has provided access (CC stakeholders).
 * @param {Object} hire hire row.
 * @param {Object} req updated request row.
 * @param {Object} team team.
 */
function notifyHrProvided(hire, req, team) {
  const cfg = getConfig();
  const reqs = getRequestsForHire(hire.hire_no);
  const pending = reqs.filter((r) => r.status !== REQ_STATUS.PROVIDED)
    .map((r) => (getTeamByCode(r.team_code) || { team_name: r.team_code }).team_name);
  const t = buildProvidedEmail({
    hire, teamName: team.team_name, repliedBy: displayFrom(req.replied_by), confirmedAt: req.confirmed_at,
    providedCount: reqs.length - pending.length, totalCount: reqs.length, pendingTeamNames: pending,
    sheetUrl: getSheetUrl(), botName: cfg.botName,
  });
  send({ to: cfg.hrEmail, cc: cfg.stakeholderCc, subject: t.subject, body: t.body, htmlBody: t.htmlBody, ref: req.request_id });
}

/**
 * §5 — tells HR a team is blocked / needs more info.
 * @param {Object} hire hire row.
 * @param {Object} req request row.
 * @param {Object} team team.
 * @param {string} replyText new reply text.
 * @param {string} repliedBy From header.
 */
function notifyHrBlocked(hire, req, team, replyText, repliedBy) {
  sendAttention(hire, req, team, replyText, repliedBy, false);
}

/**
 * §5 variant — asks HR to review an unclear reply.
 * @param {Object} hire hire row.
 * @param {Object} req request row.
 * @param {Object} team team.
 * @param {string} replyText new reply text.
 * @param {string} repliedBy From header.
 */
function notifyHrUnclear(hire, req, team, replyText, repliedBy) {
  sendAttention(hire, req, team, replyText, repliedBy, true);
}

/**
 * Shared body of notifyHrBlocked / notifyHrUnclear.
 * @param {Object} hire hire row.
 * @param {Object} req request row.
 * @param {Object} team team.
 * @param {string} replyText reply text.
 * @param {string} repliedBy From header.
 * @param {boolean} unclear unclear variant.
 */
function sendAttention(hire, req, team, replyText, repliedBy, unclear) {
  const cfg = getConfig();
  const t = buildAttentionEmail({
    hire, teamName: team.team_name, replySnippet: String(replyText || '').slice(0, 500),
    repliedBy: displayFrom(repliedBy), sheetUrl: getSheetUrl(), botName: cfg.botName, unclear,
  });
  send({ to: cfg.hrEmail, cc: cfg.stakeholderCc, subject: t.subject, body: t.body, htmlBody: t.htmlBody, ref: req.request_id });
}

/**
 * §4 — the "All access provided" summary (CC stakeholders + manager if the manager field is an email).
 * @param {Object} hire hire row.
 * @param {Array<Object>} reqs all request rows for the hire.
 */
function notifyHrAllDone(hire, reqs) {
  const cfg = getConfig();
  const items = reqs.map((r) => ({
    teamName: (getTeamByCode(r.team_code) || { team_name: r.team_code }).team_name,
    repliedBy: displayFrom(r.replied_by),
    confirmedAt: r.confirmed_at,
  }));
  const cc = cfg.stakeholderCc.slice();
  if (/@/.test(hire.manager || '')) cc.push(extractEmail(hire.manager));
  const t = buildAllDoneEmail({ hire, items, botName: cfg.botName });
  send({ to: cfg.hrEmail, cc, subject: t.subject, body: t.body, htmlBody: t.htmlBody, ref: hire.hire_no });
}

/**
 * §6 — replies in the original HR thread listing missing required fields.
 * @param {Object} hire hire row.
 * @param {Array<string>} missing missing field labels.
 * @param {GoogleAppsScript.Gmail.GmailMessage} originalMsg the HR email.
 */
function notifyHrNeedsInfo(hire, missing, originalMsg) {
  const cfg = getConfig();
  const t = buildNeedsInfoEmail({ missingFields: missing, originalSubject: originalMsg.getSubject(), botName: cfg.botName });
  send({
    to: extractEmail(originalMsg.getFrom()), threadId: originalMsg.getThread().getId(),
    subject: t.subject, body: t.body, htmlBody: t.htmlBody, ref: hire.hire_no,
  });
}

/**
 * §7 — reminder to a team, in the request thread.
 * @param {Object} hire hire row.
 * @param {Object} req request row.
 * @param {Object} team team.
 * @param {number} reminderNo 1-based reminder number.
 */
function sendReminder(hire, req, team, reminderNo) {
  const cfg = getConfig();
  const t = buildReminderEmail({ hire, team, reminderNo, maxReminders: cfg.maxReminders, botName: cfg.botName });
  send({
    to: team.to_emails, cc: team.cc_emails, threadId: req.thread_id,
    subject: t.subject, body: t.body, htmlBody: t.htmlBody, label: LABELS.REQUEST, ref: req.request_id,
  });
}

/**
 * §8 — tells HR a request is overdue after max reminders.
 * @param {Object} hire hire row.
 * @param {Object} req request row.
 * @param {Object} team team.
 */
function notifyHrOverdue(hire, req, team) {
  const cfg = getConfig();
  const hours = Math.round(hoursBetween(req.sent_at) || 0);
  const t = buildOverdueEmail({
    hire, teamName: team.team_name, maxReminders: cfg.maxReminders, hoursSinceSent: hours,
    sheetUrl: getSheetUrl(), botName: cfg.botName,
  });
  send({ to: cfg.hrEmail, cc: cfg.stakeholderCc, subject: t.subject, body: t.body, htmlBody: t.htmlBody, ref: req.request_id });
}
