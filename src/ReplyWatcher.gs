/**
 * @fileoverview Reads department replies on request threads, classifies them, updates requests,
 * notifies HR and checks hire completion.
 *
 * Idempotency is per MESSAGE, not per thread and not via read/unread state: each request row
 * stores a cursor `last_processed_msg_id`. Only messages strictly after the cursor
 * (ordered by date, then id) are handled, and the cursor advances after each one. Opening or
 * marking a message read in Gmail has no effect. NH/ReplyProcessed is informational only.
 */

/** Words that negate a following approval keyword ("not done", "isn't granted"). */
const NEGATION_RE = /\b(not|no|never|isn'?t|aren'?t|wasn'?t|hasn'?t|haven'?t|yet to|unable to)\s+(been\s+|yet\s+)?$/i;

/**
 * Gmail query for request threads with recent activity. Normal mode adds -from:me so threads
 * that contain only the bot's own messages are not even fetched; SELF_TEST_MODE drops it and
 * bot mail is filtered per message by signature.
 * @param {Object} cfg config.
 * @return {string} query.
 */
function buildReplyQuery(cfg) {
  const q = `label:${LABELS.REQUEST} newer_than:14d`;
  return cfg.selfTestMode ? q : `${q} -from:me`;
}

// ---------------------------------------------------------------- pure cursor logic

/**
 * Compares two Gmail message ids (hex strings): shorter is older, then lexical order.
 * @param {string} a id.
 * @param {string} b id.
 * @return {number} <0 if a is older, 0 if equal, >0 if a is newer.
 */
function compareMsgIds(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : (x > y ? 1 : 0);
}

/**
 * True if a message (date, id) is strictly after the cursor. No cursor → everything is new.
 * If the cursor's date is unknown, only the id is compared.
 * @param {Date} date message date.
 * @param {string} id message id.
 * @param {?{id: string, date: ?Date}} cursor last processed message.
 * @return {boolean} after the cursor.
 */
function isAfterCursor(date, id, cursor) {
  if (!cursor || !cursor.id) return true;
  if (id === cursor.id) return false;
  const t = date instanceof Date ? date.getTime() : NaN;
  const c = cursor.date instanceof Date ? cursor.date.getTime() : NaN;
  if (!isNaN(t) && !isNaN(c) && t !== c) return t > c;
  return compareMsgIds(id, cursor.id) > 0;
}

/**
 * Pure: picks the messages to handle from a thread snapshot.
 * @param {Array<{id: string, date: Date, fromBot: boolean}>} items thread messages (any order).
 * @param {?{id: string, date: ?Date}} cursor last processed message.
 * @return {{toProcess: Array<Object>, newest: ?Object}} non-bot messages after the cursor in
 *   (date, id) order, and the newest message after the cursor (bot or not) to advance to.
 */
function selectNewMessages(items, cursor) {
  const after = items
    .filter((i) => isAfterCursor(i.date, i.id, cursor))
    .sort((a, b) => (a.date.getTime() - b.date.getTime()) || compareMsgIds(a.id, b.id));
  return {
    toProcess: after.filter((i) => !i.fromBot),
    newest: after.length ? after[after.length - 1] : null,
  };
}

// ---------------------------------------------------------------- classification

/**
 * Classifies the new part of a reply. Block keywords are checked before approval keywords;
 * a negated approval ("not done yet") does not count as approval.
 * @param {string} text reply text (quoted history already removed).
 * @param {Object} cfg config (blockKeywords, approvalKeywords).
 * @return {string} 'PROVIDED' | 'BLOCKED' | 'UNCLEAR'.
 */
function classifyReply(text, cfg) {
  const t = String(text || '').toLowerCase();
  if (cfg.blockKeywords.some((k) => findKeyword(t, k, false))) return 'BLOCKED';
  if (cfg.approvalKeywords.some((k) => findKeyword(t, k, true))) return 'PROVIDED';
  return 'UNCLEAR';
}

/**
 * Whole-word keyword search; optionally ignores negated occurrences.
 * @param {string} text lowercase text.
 * @param {string} keyword lowercase keyword.
 * @param {boolean} skipNegated ignore matches preceded by a negation.
 * @return {boolean} found.
 */
function findKeyword(text, keyword, skipNegated) {
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(keyword)}(?=$|[^a-z0-9])`, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 20), m.index + m[1].length);
    if (!skipNegated || !NEGATION_RE.test(before)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- Gmail processing

/**
 * Handles new replies on all recent NH/Request threads, at most MAX_EMAILS_PER_RUN messages.
 * Messages left over (budget/time) stay after the cursor and are handled next run.
 */
function processReplies() {
  const cfg = getConfig();
  const reqs = listRequests();
  const index = { byThread: {}, byId: {} };
  reqs.forEach((r) => {
    if (r.thread_id) index.byThread[r.thread_id] = r;
    index.byId[r.request_id] = r;
  });
  const threads = GmailApp.search(buildReplyQuery(cfg), 0, 100);
  let budget = cfg.maxEmailsPerRun;
  let total = 0;
  for (let i = 0; i < threads.length && budget > 0 && !isTimeUp(); i++) {
    try {
      const n = processRequestThread(threads[i], index, cfg, budget);
      budget -= n;
      total += n;
    } catch (e) {
      logEvent('ERROR', 'REPLY_THREAD_FAILED', String(e && e.stack || e), threads[i].getId());
    }
  }
  if (total) logEvent('INFO', 'REPLIES_PROCESSED', `${total} reply message(s)`);
}

/**
 * Processes the new messages of one request thread in order, advancing the request's cursor
 * after each. A failing message is logged + NH/Error and the cursor still moves past it.
 * @param {GoogleAppsScript.Gmail.GmailThread} thread request thread.
 * @param {{byThread: Object, byId: Object}} index requests by thread_id / request_id.
 * @param {Object} cfg config.
 * @param {number} budget max messages to handle.
 * @return {number} messages handled.
 */
function processRequestThread(thread, index, cfg, budget) {
  const req = findRequestForThread(thread, index);
  if (!req) {
    Logger.log(`processReplies: no request row for thread ${thread.getId()} (${thread.getFirstMessageSubject()})`);
    return 0;
  }
  const msgs = thread.getMessages();
  const cursor = resolveCursor(req, msgs);
  const items = msgs.map((m) => ({ id: m.getId(), date: m.getDate(), fromBot: isOwnMessage(m, cfg), msg: m }));
  const sel = selectNewMessages(items, cursor);

  let handled = 0;
  for (let i = 0; i < sel.toProcess.length; i++) {
    if (handled >= budget || isTimeUp()) return handled; // rest stays after the cursor
    const item = sel.toProcess[i];
    try {
      handleReply(item.msg, getRequest(req.request_id), cfg);
    } catch (e) {
      logEvent('ERROR', 'REPLY_FAILED', String(e && e.stack || e), item.id);
      thread.addLabel(getOrCreateLabel(LABELS.ERROR));
    } finally {
      updateRequest(req.request_id, { last_processed_msg_id: item.id });
    }
    handled++;
  }
  // Everything new is handled: move the cursor past trailing bot messages (e.g. reminders) too.
  const lastHandled = sel.toProcess.length ? sel.toProcess[sel.toProcess.length - 1].id : '';
  if (sel.newest && sel.newest.id !== lastHandled) {
    updateRequest(req.request_id, { last_processed_msg_id: sel.newest.id });
  }
  if (handled) thread.addLabel(getOrCreateLabel(LABELS.REPLY_PROCESSED));
  return handled;
}

/**
 * Finds the request row for a thread: by stored thread_id, else by the tag in the subject.
 * @param {GoogleAppsScript.Gmail.GmailThread} thread thread.
 * @param {{byThread: Object, byId: Object}} index requests index.
 * @return {Object|null} request.
 */
function findRequestForThread(thread, index) {
  const byThread = index.byThread[thread.getId()];
  if (byThread) return byThread;
  const tag = parseTag(thread.getFirstMessageSubject());
  return tag ? index.byId[`${tag.hireNo}-${tag.teamCode}`] || null : null;
}

/**
 * Turns the stored last_processed_msg_id into {id, date}. The date comes from the thread, else
 * from Gmail, else from sent_at; if all fail, only the id is compared.
 * @param {Object} req request row.
 * @param {Array<GoogleAppsScript.Gmail.GmailMessage>} msgs thread messages.
 * @return {?{id: string, date: ?Date}} cursor, or null if none stored.
 */
function resolveCursor(req, msgs) {
  const id = req.last_processed_msg_id;
  if (!id) return null;
  const inThread = msgs.find((m) => m.getId() === id);
  if (inThread) return { id, date: inThread.getDate() };
  try {
    return { id, date: GmailApp.getMessageById(id).getDate() };
  } catch (e) {
    const sent = req.sent_at ? new Date(req.sent_at) : null;
    return { id, date: sent && !isNaN(sent.getTime()) ? sent : null };
  }
}

/**
 * One reply: classify → update request → notify HR → completion check.
 * @param {GoogleAppsScript.Gmail.GmailMessage} msg reply.
 * @param {Object} req current request row.
 * @param {Object} cfg config.
 */
function handleReply(msg, req, cfg) {
  const requestId = req.request_id;
  const hire = getHire(req.hire_no);
  if (!hire) throw new Error(`No hire row ${req.hire_no} for ${requestId}`);
  const team = getTeamByCode(req.team_code) || { team_code: req.team_code, team_name: req.team_code };
  const text = stripQuoted(msg.getPlainBody());
  const repliedBy = msg.getFrom();
  const kind = classifyReply(text, cfg);
  logEvent('INFO', 'REPLY_CLASSIFIED', `${kind}: "${text.slice(0, 200)}" — ${repliedBy}`, requestId);

  if (req.status === REQ_STATUS.PROVIDED) {
    logEvent('INFO', 'REPLY_AFTER_PROVIDED', 'Request already PROVIDED; status unchanged', requestId);
    return;
  }
  const status = { PROVIDED: REQ_STATUS.PROVIDED, BLOCKED: REQ_STATUS.BLOCKED, UNCLEAR: REQ_STATUS.REPLIED_UNCLEAR }[kind];
  const patch = { status, replied_by: repliedBy, reply_snippet: text.slice(0, 200) };
  if (status === REQ_STATUS.PROVIDED) patch.confirmed_at = nowIso();
  updateRequest(requestId, patch);
  const updated = Object.assign({}, req, patch);

  if (status === REQ_STATUS.PROVIDED) notifyHrProvided(hire, updated, team);
  else if (status === REQ_STATUS.BLOCKED) notifyHrBlocked(hire, updated, team, text, repliedBy);
  else notifyHrUnclear(hire, updated, team, text, repliedBy);

  checkHireCompletion(req.hire_no);
}

/**
 * Re-evaluates a hire: all requests PROVIDED → COMPLETED + §4 summary (sent once);
 * any request past SENT → IN_PROGRESS.
 * @param {string} hireNo hire number.
 * @return {string} the hire's status after the check ('' if hire not found).
 */
function checkHireCompletion(hireNo) {
  const hire = getHire(hireNo);
  if (!hire) return '';
  if (hire.status === HIRE_STATUS.COMPLETED || hire.status === HIRE_STATUS.NEEDS_INFO) return hire.status;
  const reqs = getRequestsForHire(hireNo);
  if (!reqs.length) return hire.status;
  if (reqs.every((r) => r.status === REQ_STATUS.PROVIDED)) {
    notifyHrAllDone(hire, reqs);
    updateHire(hireNo, { status: HIRE_STATUS.COMPLETED, completed_at: nowIso() });
    logEvent('INFO', 'HIRE_COMPLETED', `All ${reqs.length} requests provided`, hireNo);
    return HIRE_STATUS.COMPLETED;
  }
  const moved = reqs.some((r) => r.status !== REQ_STATUS.PENDING && r.status !== REQ_STATUS.SENT);
  if (moved && hire.status !== HIRE_STATUS.IN_PROGRESS) {
    updateHire(hireNo, { status: HIRE_STATUS.IN_PROGRESS });
    return HIRE_STATUS.IN_PROGRESS;
  }
  return hire.status;
}
