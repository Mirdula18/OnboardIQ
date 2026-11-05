# Requirements — Onboarding Access Bot

## 1. Goal

When HR hires someone, every facility/IT team should receive a clear access request automatically, and HR should be told — without chasing anyone — when each access has been granted.

## 2. Actors

| Actor | Role |
|---|---|
| HR | Sends the new-hire email; receives confirmations |
| Department teams | ID card, Gate access, Wi-Fi/IT, (configurable others). Receive requests, reply when done |
| Stakeholders | Optional CCs (e.g. hiring manager) on confirmations |
| Bot | Apps Script running in the shared Gmail account |

## 3. Functional requirements

### FR-1 Trigger: new hire notification
- FR-1.1 HR sends an email to the bot's Gmail inbox (or the bot's account is CC'd).
- FR-1.2 The email follows the format in `EMAIL_TEMPLATES.md §1` (key: value lines). Attachments are allowed (offer letter, photo, ID proof, etc.).

### FR-2 Email monitoring
- FR-2.1 The bot checks the inbox automatically every N minutes (default 5, configurable 1–15).
- FR-2.2 An email is relevant when its subject **or** body contains any configured keyword (default: `new hire`, `new joiner`, `new joinee`, `onboarding`), case-insensitive.
- FR-2.3 Optionally restrict to allowed senders (`HR_SENDERS` config). Emails from other senders are ignored and logged.
- FR-2.4 Each relevant email is processed exactly once (Gmail label `NH/Processed`).

### FR-3 Data extraction & attachments
- FR-3.1 Extract: Full name, Employee ID, Department, Designation, Joining date, Work location, Reporting manager, Personal/work email, Phone (optional fields may be blank).
- FR-3.2 Required fields: Full name, Employee ID, Joining date. If any is missing → mark hire `NEEDS_INFO`, email HR asking for the missing fields (template §6), do not dispatch.
- FR-3.3 Save all attachments to Drive: `Onboarding Access Bot/<EmployeeID>_<Name>/`. Store the folder URL in the sheet.
- FR-3.4 Duplicate check on Employee ID. Duplicate → label `NH/Duplicate`, log, no dispatch.
- FR-3.5 Write the hire to the `Hires` tab with a sequential hire number (`NH-1001`, `NH-1002`, …).

### FR-4 Automated departmental notifications
- FR-4.1 For each **active** team in the `Teams` config tab, create one request row and send one email (template §2).
- FR-4.2 Team selection may be rule-based: a team row can have `applies_to_locations` / `applies_to_departments`; blank = all hires.
- FR-4.3 Subject starts with the tracking tag `[NH-<no>-<TEAMCODE>]`.
- FR-4.4 Attach the hire's attachments only to teams with `send_attachments = TRUE` (e.g. ID card needs the photo; Wi-Fi does not).
- FR-4.5 CC addresses per team are supported.

### FR-5 Access confirmation
- FR-5.1 The bot reads new messages in request threads (`NH/Request`, active in the last 14 days) that are not from itself. Each message is handled exactly once, tracked per message (`Requests.last_processed_msg_id`); whether anyone has opened or read the message in Gmail does not matter.
- FR-5.2 Approval keywords (configurable): `access provided`, `access granted`, `granted`, `done`, `completed`, `activated`. → request status `PROVIDED`.
- FR-5.3 Rejection/info keywords: `rejected`, `cannot`, `need more info`, `missing`, `not possible`. → status `BLOCKED`, forward to HR (template §5).
- FR-5.4 Neither matched → status `REPLIED_UNCLEAR`, forward to HR for manual review.
- FR-5.5 On `PROVIDED`, email HR + stakeholders (template §3).
- FR-5.6 When **all** requests for a hire are `PROVIDED`, mark hire `COMPLETED` and send the summary (template §4).
- FR-5.7 HR can override a status manually in the sheet (dropdown); the bot respects manual values and re-evaluates completion.

### FR-6 Reminders (should-have)
- FR-6.1 Requests still `SENT` after `REMINDER_HOURS` (default 24) get a reminder in the same thread (template §7), max `MAX_REMINDERS` (default 2).
- FR-6.2 After max reminders, HR is notified the request is overdue.

### FR-7 Dashboard (should-have)
- FR-7.1 The Google Sheet shows each hire and per-team status with color coding.
- FR-7.2 A `Log` tab records every action and error with timestamp.

## 4. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | Runs entirely on Google Apps Script; no external server |
| NFR-2 | Each run finishes in < 5 min; max 20 emails per run |
| NFR-3 | Idempotent: running twice never duplicates sends |
| NFR-4 | Config changes (teams, emails, keywords) need no code change |
| NFR-5 | DRY_RUN mode for safe testing |
| NFR-6 | Personal data stays inside the company Google account; Drive folder shared only with HR |
| NFR-7 | Respect daily Gmail sending quotas; log a warning when `MailApp.getRemainingDailyQuota()` < 20 |
| NFR-8 | All times shown in Asia/Kolkata |

## 5. Out of scope (v1)

- Actually provisioning access in badge/Wi-Fi systems (teams still do that manually).
- Free-form email understanding via AI (possible v2: call an LLM API to extract fields).
- Offboarding.

## 6. Acceptance criteria (demo checklist)

- [ ] HR email with keyword + attachments → hire row created, attachments in Drive, within one trigger cycle.
- [ ] Each active team gets exactly one tagged email.
- [ ] Team replies "Access provided" → that row turns `PROVIDED`, HR gets a confirmation.
- [ ] All teams confirm → HR gets "All access provided" summary; hire `COMPLETED`.
- [ ] Same HR email forwarded again → logged as duplicate, nothing re-sent.
- [ ] Missing Employee ID → HR gets a "need info" email, no dispatch.
- [ ] Team replies "need more info" → HR is alerted, status `BLOCKED`.
