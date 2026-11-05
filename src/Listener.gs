/**
 * @fileoverview Finds new HR "new hire" emails, and HR follow-ups in NEEDS_INFO threads.
 */

/** Labels that mean "this HR thread is already handled". */
const HANDLED_HR_LABELS = ['NH/Processed', 'NH/Duplicate', 'NH/Error', 'NH/Ignored'];

/**
 * Gmail query for unprocessed new-hire emails, e.g.
 * in:inbox -label:NH/Processed … -from:me ("new hire" OR onboarding) newer_than:7d
 * @param {Object} cfg config.
 * @return {string} Gmail search query.
 */
function buildNewHireQuery(cfg) {
  const kw = cfg.newHireKeywords.map((k) => (/\s/.test(k) ? `"${k}"` : k)).join(' OR ');
  const parts = ['in:inbox'].concat(HANDLED_HR_LABELS.map((l) => `-label:${l}`));
  if (!cfg.selfTestMode) parts.push('-from:me');
  parts.push(`(${kw})`, 'newer_than:7d');
  return parts.join(' ');
}

/**
 * Returns the first message of each matching, unhandled thread (max MAX_EMAILS_PER_RUN).
 * Re-checks labels and keywords in code because Gmail search is fuzzy.
 * @param {Object} cfg config.
 * @return {Array<GoogleAppsScript.Gmail.GmailMessage>} messages.
 */
function findNewHireMessages(cfg) {
  const threads = GmailApp.search(buildNewHireQuery(cfg), 0, cfg.maxEmailsPerRun);
  const out = [];
  threads.forEach((thread) => {
    if (threadHasAnyLabel(thread, HANDLED_HR_LABELS.concat([LABELS.REQUEST]))) return;
    const msg = thread.getMessages()[0];
    if (/\[NH-\d+/.test(msg.getSubject())) return; // bot's own tracker mail
    if (cfg.selfTestMode && isBotGenerated(msg, cfg)) return;
    if (!matchesKeywords(`${msg.getSubject()}\n${msg.getPlainBody()}`, cfg.newHireKeywords)) return;
    out.push(msg);
  });
  return out;
}

/**
 * HR follow-ups in NEEDS_INFO threads: the latest non-bot message that hasn't been processed yet.
 * @param {Object} cfg config.
 * @return {Array<{msg: GoogleAppsScript.Gmail.GmailMessage, hire: Object}>} follow-ups.
 */
function findNeedsInfoFollowUps(cfg) {
  const threads = GmailApp.search(`label:${LABELS.NEEDS_INFO} newer_than:30d`, 0, cfg.maxEmailsPerRun);
  const out = [];
  threads.forEach((thread) => {
    const msgs = thread.getMessages();
    const hire = findHireBySourceMessageIds(msgs.map((m) => m.getId()));
    if (!hire || hire.status !== HIRE_STATUS.NEEDS_INFO) {
      thread.removeLabel(getOrCreateLabel(LABELS.NEEDS_INFO));
      return;
    }
    const candidates = msgs.filter((m) => (cfg.selfTestMode ? !isBotGenerated(m, cfg) : !isFromBot(m)));
    const latest = candidates[candidates.length - 1];
    if (!latest || latest.getId() === hire.source_message_id) return;
    // Only messages newer than the one we already processed.
    const ids = msgs.map((m) => m.getId());
    if (ids.indexOf(latest.getId()) < ids.indexOf(hire.source_message_id)) return;
    out.push({ msg: latest, hire });
  });
  return out;
}

/**
 * True if the sender is allowed (HR_SENDERS blank = everyone).
 * @param {GoogleAppsScript.Gmail.GmailMessage} msg message.
 * @param {Object} cfg config.
 * @return {boolean} allowed.
 */
function isAllowedSender(msg, cfg) {
  if (!cfg.hrSenders.length) return true;
  return cfg.hrSenders.indexOf(extractEmail(msg.getFrom())) >= 0;
}

/**
 * Case-insensitive keyword check.
 * @param {string} text text.
 * @param {Array<string>} keywords lowercase keywords.
 * @return {boolean} any keyword present.
 */
function matchesKeywords(text, keywords) {
  const t = String(text || '').toLowerCase();
  return keywords.some((k) => t.indexOf(k) >= 0);
}
