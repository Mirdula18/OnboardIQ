# Architecture — Onboarding Access Bot

## 1. Overview

```
 HR ──email──▶ Gmail inbox (bot account)
                    │  time-driven trigger every 5 min → runAll()
                    ▼
            ┌──────────────────┐
            │ Listener         │ GmailApp.search(keywords, -label:NH/Processed)
            └────────┬─────────┘
                     ▼
            ┌──────────────────┐     ┌──────────────┐
            │ Parser           │────▶│ Attachments  │──▶ Google Drive folder per hire
            └────────┬─────────┘     └──────────────┘
                     ▼
            ┌──────────────────┐
            │ SheetRepo        │──▶ Google Sheet (Hires, Requests, Teams, Config, Log)
            └────────┬─────────┘
                     ▼
            ┌──────────────────┐
            │ Dispatcher       │──email [NH-1023-IDCARD]──▶ ID card team
            │                  │──email [NH-1023-GATE]────▶ Gate access team
            │                  │──email [NH-1023-WIFI]────▶ Wi-Fi / IT team
            └──────────────────┘
                                         team replies in thread
                     ┌───────────────────────────┘
                     ▼
            ┌──────────────────┐
            │ ReplyWatcher     │ search 'label:NH/Request newer_than:14d -from:me' → per-message cursor
            └────────┬─────────┘
                     ▼
            ┌──────────────────┐
            │ Notifier         │──▶ HR: "ID card access provided" / blocked / all done
            └──────────────────┘
```

## 2. Execution model

- One time-driven trigger calls `runAll()` every `POLL_MINUTES`.
- `runAll()`:
  1. Acquire script lock (exit if busy).
  2. `processNewHireEmails()`
  3. `processReplies()`
  4. `sendReminders()`
  5. `syncManualOverrides()` (completion check for rows HR changed by hand)
  6. Release lock.
- Each step is independent; an exception in one is logged and the next still runs.

## 3. Components and functions

### Config.gs
- `getConfig()` → object from `Config` tab (key/value) merged with defaults, cached per run.
- `getTeams()` → active rows from `Teams` tab.
- Script Properties: `SHEET_ID`, `ROOT_FOLDER_ID`.

### Listener.gs
- `buildNewHireQuery(cfg)` → e.g. `in:inbox -label:NH/Processed -label:NH/Error -from:me ("new hire" OR "new joiner" OR onboarding) newer_than:7d`
- `findNewHireMessages(cfg)` → `GmailMessage[]` (first message of each thread only, max `MAX_EMAILS_PER_RUN`).
- `isAllowedSender(msg, cfg)`.

### Parser.gs
- `parseHire(body, subject)` → `{fullName, employeeId, department, designation, joiningDate, location, manager, email, phone}`.
- Strategy: strip HTML (`getPlainBody()`), then match `^\s*<label>\s*[:\-]\s*(.+)$` per line, with label synonyms (e.g. `Emp ID|Employee ID|Employee No`).
- `validateHire(hire)` → list of missing required fields.

### Attachments.gs
- `saveAttachments(msg, hire)` → `{folderUrl, fileIds[]}`; skips inline images under 10 KB (signatures).

### SheetRepo.gs
- `findHireByEmployeeId(id)`, `insertHire(hire)` → hireNo, `updateHire(hireNo, patch)`
- `insertRequest(req)`, `updateRequest(requestId, patch)`, `getRequestsForHire(hireNo)`, `getRequest(requestId)`
- `getPendingRequestsOlderThan(hours)`
- `logEvent(level, action, details)`

### Dispatcher.gs
- `selectTeamsForHire(hire, teams)` applies location/department rules.
- `dispatchRequestsForHire(hire)` creates request rows, sends emails, stores Gmail `threadId` and `messageId` on the request row.

### ReplyWatcher.gs
- Reply tracking is **per message**, never by read/unread state or thread labels. Each request row keeps a cursor `last_processed_msg_id` (initialised to the outgoing request's message id at dispatch).
- `processReplies()` → searches `label:NH/Request newer_than:14d` (+ `-from:me` unless `SELF_TEST_MODE`), at most `MAX_EMAILS_PER_RUN` messages per run.
- `processRequestThread(thread)` → orders messages by (date, id), skips the bot's own messages and everything at or before the cursor (`selectNewMessages`, `isAfterCursor`, `compareMsgIds` — pure), handles the rest in order and advances the cursor after each message (also past trailing bot messages such as reminders). A failing message is logged + `NH/Error` and the cursor still moves past it.
- `classifyReply(text, cfg)` → `PROVIDED | BLOCKED | UNCLEAR`. Uses only the new part of the reply (cut at the first quoted line: `On ... wrote:` / lines starting with `>`).
- `handleReply(msg, req)` → classify → update request → notify → `checkHireCompletion(hireNo)`. The request is found by `thread_id`, falling back to the tag in the thread subject.

### Notifier.gs
- `notifyHrProvided(hire, req)`, `notifyHrBlocked(hire, req, replyText)`, `notifyHrUnclear(...)`, `notifyHrAllDone(hire, reqs)`, `notifyHrNeedsInfo(hire, missing, originalMsg)`, `sendReminder(req)`.
- `send({to, cc, subject, body, htmlBody, attachments, threadId})` — the **only** function that sends mail; honors DRY_RUN and quota checks. Replies in-thread via `GmailApp.getThreadById(threadId).reply(...)` when a threadId is given.

### Utils.gs
- `buildTag(hireNo, teamCode)` → `[NH-1023-WIFI]`
- `parseTag(subject)` → `{hireNo, teamCode}` via `/\[NH-(\d+)-([A-Z0-9_]+)\]/`
- `nowIso()`, `hoursBetween(a, b)`, `stripQuoted(text)`.

### Setup.gs
- `setup()` creates sheet tabs + headers + dropdown validation, Gmail labels, root Drive folder, script properties, the trigger.
- `resetTrigger()`, `teardown()` (removes triggers only).

## 4. Gmail labels

| Label | Meaning |
|---|---|
| `NH/Processed` | HR email handled |
| `NH/Duplicate` | HR email for an already-known employee |
| `NH/Error` | Failed; see Log tab |
| `NH/Request` | Outgoing department request thread |
| `NH/ReplyProcessed` | Informational only: thread has had at least one reply handled. Never used for filtering (labels are thread-level; idempotency is the `Requests.last_processed_msg_id` cursor) |
| `NH/Ignored` | HR-style email from a sender not in `HR_SENDERS` |
| `NH/NeedsInfo` | HR thread waiting for missing fields; HR's reply in this thread is re-parsed |

## 5. State machines

**Request:** `PENDING → SENT → (PROVIDED | BLOCKED | REPLIED_UNCLEAR)`; `SENT → OVERDUE` after max reminders. HR may set any status manually.

**Hire:** `NEW → (NEEDS_INFO | DISPATCHED) → IN_PROGRESS → COMPLETED`. `IN_PROGRESS` once any request is non-SENT; `COMPLETED` when all requests are `PROVIDED`.

## 6. Security & permissions

- OAuth scopes in `src/appsscript.json`: `https://mail.google.com/` (required by `GmailApp`), `gmail.modify`, `gmail.send`, `drive`, `spreadsheets`, `script.scriptapp`, `script.send_mail` (for `MailApp.getRemainingDailyQuota()`), `userinfo.email` (bot's own address via `Session`).
- Run under a dedicated shared mailbox (e.g. `onboarding@company.com`) if possible, not a personal inbox.
- Drive folders inherit sharing from the root folder; share root only with HR.

## 7. v2 ideas

- LLM-based field extraction for free-form HR emails.
- Google Form for teams to click "Provided" instead of replying.
- Slack/Chat notifications.
- Looker Studio dashboard on the sheet.
