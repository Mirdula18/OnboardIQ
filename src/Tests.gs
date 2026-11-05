/**
 * @fileoverview Unit-style checks from docs/TESTING.md. Run from the editor; results go to the
 * execution log. Pure functions only — no sheet, Gmail or Drive access.
 */

/**
 * Asserts deep equality (via JSON) and logs PASS/FAIL.
 * @param {string} name check name.
 * @param {*} actual actual value.
 * @param {*} expected expected value.
 */
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`);
  Logger.log(`PASS ${name}`);
}

/**
 * Tag build/parse round trip.
 */
function testParseTag() {
  assertEq('parseTag basic', parseTag('[NH-1023-WIFI] foo'), { hireNo: 'NH-1023', teamCode: 'WIFI' });
  assertEq('parseTag in reply', parseTag('Re: [NH-1001-IDCARD] ID Card access request'), { hireNo: 'NH-1001', teamCode: 'IDCARD' });
  assertEq('parseTag edited subject', parseTag('Done!! [NH-1001-GATE] (edited)'), { hireNo: 'NH-1001', teamCode: 'GATE' });
  assertEq('parseTag no tag', parseTag('Lunch plans'), null);
  assertEq('parseTag HR summary tag has no team', parseTag('[NH-1001] All access provided'), null);
  assertEq('buildTag from NH-', buildTag('NH-1023', 'wifi'), '[NH-1023-WIFI]');
  assertEq('buildTag from number', buildTag(1023, 'WIFI'), '[NH-1023-WIFI]');
  assertEq('round trip', parseTag(buildTag('NH-1050', 'FACILITY')), { hireNo: 'NH-1050', teamCode: 'FACILITY' });
  assertEq('requestId', buildRequestId('NH-1001', 'WIFI'), 'NH-1001-WIFI');
}

/**
 * Parser: sample §1 body → all fields; DD/MM/YYYY → ISO; synonyms; missing fields.
 */
function testParser() {
  const h = parseHire(SAMPLE_HR_BODY, 'New Hire – Priya Sharma');
  assertEq('parser fields', h, {
    fullName: 'Priya Sharma', employeeId: 'EMP2045', department: 'Engineering',
    designation: 'Software Engineer', joiningDate: '2026-11-10', location: 'Coimbatore Office',
    manager: 'Arun Kumar', email: 'priya.sharma@company.com', phone: '+91 98xxxxxxx',
  });
  assertEq('parser valid', validateHire(h), []);

  const syn = parseHire([
    '*Name:* Arjun Rao', 'Emp ID: emp 7788', 'DOJ: 10/11/2026', 'Role - Analyst',
    'Office: Chennai', 'Manager: Meena', 'E-mail: arjun@company.com <mailto:arjun@company.com>',
    '> Employee ID: QUOTED-SHOULD-BE-IGNORED',
  ].join('\n'), 'Fwd: onboarding');
  assertEq('synonym name', syn.fullName, 'Arjun Rao');
  assertEq('synonym emp id (spaces removed)', syn.employeeId, 'emp7788');
  assertEq('DD/MM/YYYY → ISO', syn.joiningDate, '2026-11-10');
  assertEq('dash separator', syn.designation, 'Analyst');
  assertEq('office → location', syn.location, 'Chennai');
  assertEq('mailto stripped', syn.email, 'arjun@company.com');

  assertEq('normalizeDate DD-MM-YYYY', normalizeDate('05-01-2027'), '2027-01-05');
  assertEq('normalizeDate text', normalizeDate('10 Nov 2026'), '2026-11-10');

  const missing = parseHire('Full Name: Rahul Verma\nJoining Date: 2026-12-01\nEmployee ID: ...', 'New Hire');
  assertEq('placeholder ... is blank', missing.employeeId, '');
  assertEq('missing employee id', validateHire(missing), ['Employee ID']);
  assertEq('name from subject', parseHire('Employee ID: E1', 'New Hire – Kavya N').fullName, 'Kavya N');
}

/**
 * Reply classification (block keywords first, negation-aware approval).
 */
function testClassify() {
  const cfg = buildConfig({});
  assertEq('provided', classifyReply('Access provided ✅', cfg), 'PROVIDED');
  assertEq('done', classifyReply('Done.', cfg), 'PROVIDED');
  assertEq('blocked', classifyReply('cannot do, missing photo', cfg), 'BLOCKED');
  assertEq('need more info', classifyReply('Need more info: which floor?', cfg), 'BLOCKED');
  assertEq('unclear', classifyReply('ok will do', cfg), 'UNCLEAR');
  assertEq('unclear tomorrow', classifyReply('Will check tomorrow', cfg), 'UNCLEAR');
  assertEq('negated', classifyReply('not done yet', cfg), 'UNCLEAR');
  assertEq('block beats approval', classifyReply('Access granted but photo missing', cfg), 'BLOCKED');
  assertEq('whole word only', classifyReply('undone', cfg), 'UNCLEAR');
}

/**
 * Quoted-text removal.
 */
function testStripQuoted() {
  const gmail = 'Need more info\n\nOn Thu, 5 Nov 2026 at 20:30, OnboardIQ <bot@x.com> wrote:\n> When access is ready reply "Access provided"';
  assertEq('gmail quote', stripQuoted(gmail), 'Need more info');
  const wrapped = 'Done\n\nOn Thu, Nov 5, 2026 at 8:30 PM OnboardIQ <\nbot@x.com> wrote:\n> old';
  assertEq('wrapped On…wrote', stripQuoted(wrapped), 'Done');
  assertEq('> lines', stripQuoted('Access provided\n> quoted\n> more'), 'Access provided');
  const outlook = 'Granted\r\n\r\nFrom: OnboardIQ <bot@x.com>\r\nSent: Thursday\r\nSubject: [NH-1-WIFI]';
  assertEq('outlook header', stripQuoted(outlook), 'Granted');
  assertEq('no quote', stripQuoted('  Will check tomorrow  '), 'Will check tomorrow');
  assertEq('"On it" kept', stripQuoted('On it, will finish by 5'), 'On it, will finish by 5');
}

/**
 * Per-message reply cursor (Requests.last_processed_msg_id), incl. T16 and T17 simulations.
 * Thread messages are modelled as {id, date, fromBot, unread, text}.
 */
function testReplyCursor() {
  const cfg = buildConfig({});
  const at = (min) => new Date(Date.UTC(2026, 10, 5, 10, min));
  const ids = (sel) => sel.toProcess.map((i) => i.id);

  assertEq('compareMsgIds length first', compareMsgIds('fff', '1000') < 0, true);
  assertEq('compareMsgIds lexical', compareMsgIds('18f2a', '18f2b') < 0, true);
  assertEq('compareMsgIds equal', compareMsgIds('18f2a', '18f2a'), 0);
  assertEq('no cursor → all new', isAfterCursor(at(1), 'a1', null), true);
  assertEq('same id is not after', isAfterCursor(at(5), 'a5', { id: 'a5', date: at(5) }), false);
  assertEq('earlier date is not after', isAfterCursor(at(4), 'a9', { id: 'a5', date: at(5) }), false);
  assertEq('later date is after', isAfterCursor(at(6), 'a1', { id: 'a5', date: at(5) }), true);
  assertEq('same date → id tie-break', isAfterCursor(at(5), 'a6', { id: 'a5', date: at(5) }), true);
  assertEq('unknown cursor date → id only', isAfterCursor(at(1), 'a6', { id: 'a5', date: null }), true);

  // Thread: bot request (cursor starts here), team reply, bot reminder — given out of order.
  const request = { id: 'a1', date: at(0), fromBot: true };
  const reply = { id: 'a2', date: at(10), fromBot: false };
  const reminder = { id: 'a3', date: at(20), fromBot: true };
  const sel = selectNewMessages([reminder, reply, request], { id: 'a1', date: at(0) });
  assertEq('skips bot + cursor', ids(sel), ['a2']);
  assertEq('newest includes bot msg', sel.newest.id, 'a3');
  assertEq('nothing after newest', selectNewMessages([request, reply, reminder], { id: 'a3', date: at(20) }).toProcess, []);
  assertEq('blank cursor → all non-bot', ids(selectNewMessages([request, reply, reminder], null)), ['a2']);

  // T16: team reply already opened (unread=false) before runAll → still processed.
  const opened = { id: 'b2', date: at(10), fromBot: false, unread: false, text: 'Access provided' };
  const t16 = selectNewMessages([{ id: 'b1', date: at(0), fromBot: true }, opened], { id: 'b1', date: at(0) });
  assertEq('T16 read reply still selected', ids(t16), ['b2']);
  assertEq('T16 classified', classifyReply(t16.toProcess[0].text, cfg), 'PROVIDED');

  // T17: "Need more info" then "Done" in the same thread → BLOCKED then PROVIDED.
  const thread = [
    { id: 'c1', date: at(0), fromBot: true },
    { id: 'c2', date: at(10), fromBot: false, text: 'Need more info - photo missing' },
  ];
  let cursor = { id: 'c1', date: at(0) };
  const run1 = selectNewMessages(thread, cursor);
  assertEq('T17 run 1 picks first reply', ids(run1), ['c2']);
  assertEq('T17 run 1 → BLOCKED', classifyReply(run1.toProcess[0].text, cfg), 'BLOCKED');
  cursor = { id: run1.newest.id, date: run1.newest.date };
  assertEq('T17 rerun without new mail → nothing', selectNewMessages(thread, cursor).toProcess, []);
  thread.push({ id: 'c3', date: at(30), fromBot: false, text: 'Done' });
  const run2 = selectNewMessages(thread, cursor);
  assertEq('T17 run 2 picks only the new reply', ids(run2), ['c3']);
  assertEq('T17 run 2 → PROVIDED', classifyReply(run2.toProcess[0].text, cfg), 'PROVIDED');

  // Both replies arriving before a single run are handled in order.
  const both = selectNewMessages(thread, { id: 'c1', date: at(0) });
  assertEq('T17 single run order', ids(both), ['c2', 'c3']);
}

/**
 * Template smoke test: subjects carry the tag/format from docs/EMAIL_TEMPLATES.md.
 */
function testTemplates() {
  const hire = {
    hire_no: 'NH-1001', full_name: 'Priya Sharma', employee_id: 'EMP2045', department: 'Engineering',
    designation: 'SE', joining_date: '2026-11-10', location: 'Coimbatore', manager: 'Arun', drive_folder_url: '',
  };
  const team = { team_code: 'WIFI', team_name: 'Wi-Fi / IT' };
  const req = buildRequestEmail({ hire, team, attachmentNames: [], botName: 'OnboardIQ' });
  assertEq('request subject', req.subject, '[NH-1001-WIFI] Wi-Fi / IT access request – Priya Sharma (joins 2026-11-10)');
  assertEq('request signature', req.body.indexOf('— OnboardIQ') >= 0, true);
  assertEq('request no attachment line', req.body.indexOf('Attached:') < 0, true);
  const done = buildAllDoneEmail({ hire, items: [], botName: 'OnboardIQ' });
  assertEq('all-done subject', done.subject, '[NH-1001] All access provided – Priya Sharma ✅');
}

/**
 * Runs every unit-style check (BUILD_PLAN Phase 1 "testUtils").
 */
function testUtils() {
  testParseTag();
  testParser();
  testClassify();
  testStripQuoted();
  testReplyCursor();
  testTemplates();
  Logger.log('ALL TESTS PASSED');
}
