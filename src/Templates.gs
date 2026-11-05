/**
 * @fileoverview Email body builders. Must match docs/EMAIL_TEMPLATES.md.
 * Each builder returns {subject, body, htmlBody}. Bodies are composed from "blocks" so the
 * plain-text and HTML versions always say the same thing:
 *   'string'            → paragraph
 *   {table: [[k, v]]}   → aligned key/value lines (text) / table (HTML)
 *   {list: ['a', 'b']}  → bullet list
 */

/**
 * Renders blocks to plain text + HTML.
 * @param {Array<string|Object>} blocks content blocks.
 * @return {{body: string, htmlBody: string}} rendered bodies.
 */
function renderBlocks(blocks) {
  const parts = blocks.filter((b) => b !== null && b !== undefined && b !== '');
  const body = parts.map(blockToText).join('\n\n');
  const html = parts.map(blockToHtml).join('');
  return {
    body,
    htmlBody: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#202124">${html}</div>`,
  };
}

/**
 * One block → plain text.
 * @param {string|Object} b block.
 * @return {string} text.
 */
function blockToText(b) {
  if (typeof b === 'string') return b;
  if (b.table) return b.table.map(([k, v]) => `  ${`${k}:`.padEnd(15)}${v || '-'}`).join('\n');
  if (b.list) return b.list.map((i) => `  • ${i}`).join('\n');
  return '';
}

/**
 * One block → HTML.
 * @param {string|Object} b block.
 * @return {string} html.
 */
function blockToHtml(b) {
  const inline = (s) => linkify(escapeHtml(s)).replace(/\n/g, '<br>');
  if (typeof b === 'string') return `<p style="margin:0 0 12px">${inline(b)}</p>`;
  if (b.table) {
    const rows = b.table.map(([k, v]) => '<tr>'
      + `<td style="padding:4px 12px 4px 0;color:#5f6368;white-space:nowrap">${escapeHtml(k)}</td>`
      + `<td style="padding:4px 0"><b>${inline(v || '-')}</b></td></tr>`).join('');
    return `<table style="border-collapse:collapse;margin:0 0 12px">${rows}</table>`;
  }
  if (b.list) return `<ul style="margin:0 0 12px">${b.list.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`;
  return '';
}

/**
 * Turns http(s) URLs in already-escaped text into links.
 * @param {string} escaped escaped text.
 * @return {string} html.
 */
function linkify(escaped) {
  return escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
}

/**
 * §2 Bot → Department: access request.
 * @param {{hire: Object, team: Object, attachmentNames: Array<string>, botName: string}} p params.
 * @return {{subject: string, body: string, htmlBody: string}} email.
 */
function buildRequestEmail(p) {
  const h = p.hire;
  const t = p.team;
  const subject = `${buildTag(h.hire_no, t.team_code)} ${t.team_name} access request – ${h.full_name} (joins ${h.joining_date})`;
  const names = p.attachmentNames || [];
  const r = renderBlocks([
    `Hello ${t.team_name} team,`,
    `A new employee is joining. Please arrange ${t.team_name} access.`,
    {
      table: [
        ['Name', h.full_name], ['Employee ID', h.employee_id], ['Department', h.department],
        ['Designation', h.designation], ['Joining date', h.joining_date], ['Location', h.location],
        ['Manager', h.manager],
      ],
    },
    names.length ? `Attached: ${names.join(', ')}` : '',
    'When access is ready, just REPLY to this email with "Access provided".\n'
      + 'If something is missing, reply with "Need more info" and what you need.',
    'Please keep the subject line unchanged — it is used for tracking.',
    `— ${p.botName}`,
  ]);
  return { subject, body: r.body, htmlBody: r.htmlBody };
}

/**
 * §3 Bot → HR: one team confirmed.
 * @param {{hire: Object, teamName: string, repliedBy: string, confirmedAt: string,
 *   providedCount: number, totalCount: number, pendingTeamNames: Array<string>,
 *   sheetUrl: string, botName: string}} p params.
 * @return {{subject: string, body: string, htmlBody: string}} email.
 */
function buildProvidedEmail(p) {
  const h = p.hire;
  const subject = `[NH-${hireNumber(h.hire_no)}] ${p.teamName} access provided – ${h.full_name}`;
  const r = renderBlocks([
    'Hi HR,',
    `${p.teamName} access has been provided for ${h.full_name} (${h.employee_id}).\n`
      + `Confirmed by: ${p.repliedBy} at ${formatDisplay(p.confirmedAt)}`,
    `Progress: ${p.providedCount} of ${p.totalCount} teams done.\n`
      + `Pending: ${p.pendingTeamNames.length ? p.pendingTeamNames.join(', ') : 'None'}`,
    `Tracker: ${p.sheetUrl}\n— ${p.botName}`,
  ]);
  return { subject, body: r.body, htmlBody: r.htmlBody };
}

/**
 * §4 Bot → HR: all access provided.
 * @param {{hire: Object, items: Array<{teamName: string, repliedBy: string, confirmedAt: string}>,
 *   botName: string}} p params.
 * @return {{subject: string, body: string, htmlBody: string}} email.
 */
function buildAllDoneEmail(p) {
  const h = p.hire;
  const subject = `[NH-${hireNumber(h.hire_no)}] All access provided – ${h.full_name} ✅`;
  const r = renderBlocks([
    'Hi HR,',
    `All access for ${h.full_name} (${h.employee_id}, joining ${h.joining_date}) is ready:`,
    {
      list: p.items.map((i) => `${i.teamName} — provided by ${i.repliedBy || 'HR (manual update)'}`
        + ` on ${formatDisplay(i.confirmedAt) || '-'}`),
    },
    `Documents: ${h.drive_folder_url || '-'}\n— ${p.botName}`,
  ]);
  return { subject, body: r.body, htmlBody: r.htmlBody };
}

/**
 * §5 Bot → HR: team blocked / needs info (or, with unclear=true, "Please review reply").
 * @param {{hire: Object, teamName: string, replySnippet: string, repliedBy: string,
 *   sheetUrl: string, botName: string, unclear: boolean}} p params.
 * @return {{subject: string, body: string, htmlBody: string}} email.
 */
function buildAttentionEmail(p) {
  const h = p.hire;
  const num = hireNumber(h.hire_no);
  const subject = p.unclear
    ? `[NH-${num}] Please review reply: ${p.teamName} – ${h.full_name}`
    : `[NH-${num}] Action needed: ${p.teamName} – ${h.full_name}`;
  const intro = p.unclear
    ? `The ${p.teamName} team replied, but it is not clear whether access was provided:`
    : `The ${p.teamName} team replied and needs attention:`;
  const r = renderBlocks([
    'Hi HR,',
    intro,
    `"${p.replySnippet}"\n— ${p.repliedBy}`,
    `Please reply to them directly in the request thread, or update the status in the tracker: ${p.sheetUrl}\n— ${p.botName}`,
  ]);
  return { subject, body: r.body, htmlBody: r.htmlBody };
}

/**
 * §6 Bot → HR: missing details (sent as a reply in the original HR thread).
 * @param {{missingFields: Array<string>, originalSubject: string, botName: string}} p params.
 * @return {{subject: string, body: string, htmlBody: string}} email.
 */
function buildNeedsInfoEmail(p) {
  const r = renderBlocks([
    'Hi,',
    "I couldn't start onboarding requests because these details are missing:",
    { list: p.missingFields },
    'Please reply with the full new-hire email in this format:\nFull Name: ...\nEmployee ID: ...\nJoining Date: ...',
    `— ${p.botName}`,
  ]);
  return { subject: `Re: ${p.originalSubject || 'New hire'}`, body: r.body, htmlBody: r.htmlBody };
}

/**
 * §7 Bot → Department: reminder (sent as a reply in the request thread).
 * @param {{hire: Object, team: Object, reminderNo: number, maxReminders: number, botName: string}} p params.
 * @return {{subject: string, body: string, htmlBody: string}} email.
 */
function buildReminderEmail(p) {
  const h = p.hire;
  const r = renderBlocks([
    `Gentle reminder (${p.reminderNo}/${p.maxReminders}): ${h.full_name} joins on ${h.joining_date}.\n`
      + `Please reply "Access provided" once ${p.team.team_name} access is ready.`,
    `— ${p.botName}`,
  ]);
  const subject = `Re: ${buildTag(h.hire_no, p.team.team_code)} ${p.team.team_name} access request – ${h.full_name} (joins ${h.joining_date})`;
  return { subject, body: r.body, htmlBody: r.htmlBody };
}

/**
 * §8 Bot → HR: overdue.
 * @param {{hire: Object, teamName: string, maxReminders: number, hoursSinceSent: number,
 *   sheetUrl: string, botName: string}} p params.
 * @return {{subject: string, body: string, htmlBody: string}} email.
 */
function buildOverdueEmail(p) {
  const h = p.hire;
  const subject = `[NH-${hireNumber(h.hire_no)}] Overdue: ${p.teamName} – ${h.full_name}`;
  const r = renderBlocks([
    `No response from ${p.teamName} after ${p.maxReminders} reminders (${p.hoursSinceSent} hours).\n`
      + `Please follow up. Tracker: ${p.sheetUrl}`,
    `— ${p.botName}`,
  ]);
  return { subject, body: r.body, htmlBody: r.htmlBody };
}
