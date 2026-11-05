/**
 * @fileoverview Creates request rows and sends one tagged access request per selected team.
 */

/**
 * Applies the per-team location / department rules (blank = all hires). Matching is
 * case-insensitive substring, e.g. 'coimbatore' matches 'Coimbatore Office'.
 * @param {Object} hire hire row.
 * @param {Array<Object>} teams active teams.
 * @return {Array<Object>} teams that apply to this hire.
 */
function selectTeamsForHire(hire, teams) {
  const loc = String(hire.location || '').toLowerCase();
  const dept = String(hire.department || '').toLowerCase();
  const matches = (value, rules) => !rules.length || rules.some((r) => value.indexOf(r) >= 0);
  return teams.filter((t) => matches(loc, t.applies_to_locations) && matches(dept, t.applies_to_departments));
}

/**
 * Sends one access request per selected team. Idempotent: a request that is already past
 * PENDING is never sent again. A failure for one team is logged and the others continue.
 * @param {Object} hire hire row (must have hire_no and drive_folder_url).
 * @return {number} number of requests sent (or dry-run logged) in this call.
 */
function dispatchRequestsForHire(hire) {
  const cfg = getConfig();
  const teams = selectTeamsForHire(hire, getTeams());
  if (!teams.length) {
    logEvent('WARN', 'NO_TEAMS_SELECTED', 'No active team applies to this hire', hire.hire_no);
    return 0;
  }
  let blobs = null;
  let sent = 0;
  teams.forEach((team) => {
    const requestId = buildRequestId(hire.hire_no, team.team_code);
    try {
      const existing = getRequest(requestId);
      if (existing && existing.status !== REQ_STATUS.PENDING) {
        logEvent('INFO', 'REQUEST_ALREADY_SENT', `Status ${existing.status}; not re-sent`, requestId);
        return;
      }
      if (!existing) {
        insertRequest({
          request_id: requestId, hire_no: hire.hire_no, team_code: team.team_code,
          status: REQ_STATUS.PENDING, reminder_count: '0', manual_override: 'FALSE',
        });
      }
      if (team.send_attachments && blobs === null) blobs = getHireAttachmentBlobs(hire);
      const attachments = team.send_attachments ? blobs : [];
      const t = buildRequestEmail({
        hire, team, attachmentNames: attachments.map((b) => b.getName()), botName: cfg.botName,
      });
      const res = send({
        to: team.to_emails, cc: team.cc_emails, subject: t.subject, body: t.body, htmlBody: t.htmlBody,
        attachments, label: LABELS.REQUEST, ref: requestId,
      });
      // The outgoing request is the reply cursor's starting point: only later messages are replies.
      updateRequest(requestId, {
        status: REQ_STATUS.SENT, thread_id: res.threadId, sent_at: nowIso(), last_processed_msg_id: res.messageId,
      });
      logEvent('INFO', 'REQUEST_SENT', `${team.team_name} → ${team.to_emails.join(', ')}${res.dryRun ? ' (dry run)' : ''}`, requestId);
      sent++;
    } catch (e) {
      logEvent('ERROR', 'REQUEST_FAILED', String(e && e.stack || e), requestId);
    }
  });
  return sent;
}
