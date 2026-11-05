# CLAUDE.md — Onboarding Access Bot

Guidance for Claude (or any AI coding agent) working in this repository.

## What this project is

An email-driven automation that runs on **Google Apps Script** inside the company's Google (Gmail) account.

1. HR sends a "new hire" email (with attachments).
2. The bot detects it by keyword, extracts the new hire's details, and saves attachments to Drive.
3. It emails each relevant department (ID card, gate access, Wi-Fi/IT, etc.) a tagged access request.
4. It watches for department replies. When a team replies "access provided", it marks that request done and notifies HR.
5. When every team for a hire has confirmed, it sends HR a final "All access provided" summary.

Full specs live in `docs/`:

| File | Purpose |
|---|---|
| `docs/REQUIREMENTS.md` | Functional + non-functional requirements, acceptance criteria |
| `docs/ARCHITECTURE.md` | Components, flow, function list, triggers |
| `docs/DATA_MODEL.md` | Google Sheet tabs, columns, status values |
| `docs/EMAIL_TEMPLATES.md` | HR input format + every email the bot sends |
| `docs/BUILD_PLAN.md` | Ordered build steps with checklists |
| `docs/TESTING.md` | End-to-end test scenarios |

**Read the relevant doc before changing behavior. If code and docs disagree, docs win — or update the doc in the same change.**

## Tech stack

- Google Apps Script (V8 runtime), plain JavaScript (ES2019+). No npm packages at runtime.
- Built-in services only: `GmailApp`, `DriveApp`, `SpreadsheetApp`, `PropertiesService`, `LockService`, `ScriptApp`, `Utilities`, `Logger`.
- Google Sheet = database + dashboard.
- Optional local dev: [`clasp`](https://github.com/google/clasp) to push/pull code.

## Repository layout

```
/
├── CLAUDE.md
├── .clasp.json            # created by `clasp create` / `clasp clone` (not committed with real IDs)
├── samples/sample_hr_email.txt   # HR input example to send yourself
├── src/
│   ├── appsscript.json    # manifest (timezone Asia/Kolkata, V8, oauth scopes) — lives in src/ for clasp --rootDir src
│   ├── Config.gs          # reads Config tab + script properties; constants
│   ├── Main.gs            # runAll() entry point called by trigger
│   ├── Listener.gs        # finds new HR emails
│   ├── Parser.gs          # extracts hire fields from email body
│   ├── Attachments.gs     # saves attachments to Drive
│   ├── SheetRepo.gs       # all reads/writes to the Google Sheet
│   ├── Dispatcher.gs      # sends tagged requests to departments
│   ├── ReplyWatcher.gs    # reads replies, detects approval / rejection
│   ├── Notifier.gs        # HR confirmations, all-done, reminders, errors
│   ├── Templates.gs       # email body builders (match docs/EMAIL_TEMPLATES.md)
│   ├── Utils.gs           # tag build/parse, logging, date helpers
│   ├── Setup.gs           # one-time setup: create tabs, labels, folder, trigger; demo/test helpers
│   └── Tests.gs           # unit-style checks from docs/TESTING.md (testUtils runs all)
└── docs/
```

## Commands

```bash
npm i -g @google/clasp      # one-time
clasp login                 # one-time
clasp create --type sheets --title "Onboarding Access Bot" --rootDir src
clasp push                  # deploy code
clasp open                  # open the script editor
clasp logs                  # view executions (or use the Executions panel)
```

Without clasp: open the Sheet → Extensions → Apps Script, and paste each `src/*.gs` file.

First run: execute `setup()` from the editor once (creates tabs, labels, Drive folder, and the time-driven trigger; grants permissions).

## Core rules (do not break these)

1. **Idempotency.** Every processed HR email gets the Gmail label `NH/Processed`. The HR listener must exclude its labels. Department replies are tracked **per message** via the `Requests.last_processed_msg_id` cursor (never via read/unread or thread labels); `NH/ReplyProcessed` is informational only. Never send a request twice for the same `request_id`.
2. **Dedupe hires** on `employee_id` (fallback: name + joining date). A duplicate HR email is labeled `NH/Duplicate` and logged, not re-dispatched.
3. **Tracking tag format** is exactly `[NH-<hireNo>-<TEAMCODE>]`, e.g. `[NH-1023-WIFI]`. It must appear at the start of every request subject. Build and parse it only through `Utils.buildTag()` / `Utils.parseTag()`.
4. **Concurrency.** `runAll()` must take `LockService.getScriptLock()` with `tryLock(10000)` and exit quietly if it can't.
5. **No hard-coded emails.** Team addresses, HR address and keywords come from the `Config` tab. Secrets/IDs (sheet ID, folder ID) go in Script Properties.
6. **DRY_RUN mode.** If the `DRY_RUN` config value is `TRUE`, log every email that would be sent to the `Log` tab instead of sending. Default to `TRUE` until testing is done.
7. **Never ignore the bot's own mail.** Reply searches must use `-from:me` so outgoing requests aren't read as replies. Only exception: `SELF_TEST_MODE = TRUE` (single-inbox testing), where bot mail is recognised by its `— <BOT_NAME>` signature instead.
8. **Errors don't stop the batch.** Wrap each email in try/catch, write the error to the `Log` tab, label it `NH/Error`, and continue.
9. **Stay inside Apps Script limits.** Runtime per execution ≈ 6 minutes; process at most `MAX_EMAILS_PER_RUN` (default 20) per run. Daily email-sending quotas are lower on free Gmail than on Workspace.
10. Keep functions small and pure where possible; all Sheet I/O goes through `SheetRepo.gs`.

## Coding conventions

- `const`/`let`, arrow functions, template literals. 2-space indent. JSDoc on every exported function.
- Function names: verbs (`findNewHireThreads`, `dispatchRequestsForHire`).
- Dates stored as ISO strings in the sheet; display in `Asia/Kolkata`.
- Logging: `logEvent(level, action, details)` writes to the `Log` tab and `Logger`.
- Email bodies are built in `Templates.gs` only, and must match `docs/EMAIL_TEMPLATES.md`.

## Definition of done for any change

- Behaves as described in `docs/REQUIREMENTS.md`.
- Relevant scenarios in `docs/TESTING.md` pass in DRY_RUN and then live with alias inboxes.
- No duplicate sends when `runAll()` is run twice in a row.
- Docs updated if behavior changed.
