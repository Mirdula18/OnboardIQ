# Build Plan — tonight (~5 hours)

Work top to bottom. Keep `DRY_RUN = TRUE` until Phase 6.

## Phase 0 — Setup (30 min)
- [ ] Create a Google Sheet "Onboarding Access Bot" (in the bot / shared Gmail account).
- [ ] Extensions → Apps Script (or `clasp create --type sheets --rootDir src`).
- [ ] Add `appsscript.json`: `"timeZone": "Asia/Kolkata"`, `"runtimeVersion": "V8"`, OAuth scopes from ARCHITECTURE §6.
- [ ] Write `Setup.gs` → `setup()` creates tabs/headers/dropdowns, seeds Config + Teams, creates Gmail labels and the root Drive folder, saves IDs to Script Properties.
- [ ] Run `setup()` once; approve permissions.
- [ ] Fill the Teams tab with test aliases: `yourname+idcard@gmail.com`, `+gate`, `+wifi`. Set `HR_EMAIL` to `yourname+hr@gmail.com`.

## Phase 1 — Foundations (45 min)
- [ ] `Config.gs`: `getConfig()`, `getTeams()`, defaults.
- [ ] `Utils.gs`: `buildTag`, `parseTag`, `stripQuoted`, date helpers.
- [ ] `SheetRepo.gs`: CRUD for Hires/Requests + `logEvent`.
- [ ] `Notifier.send()` with DRY_RUN + quota check.
- [ ] Quick test function `testUtils()` for tag round-trip and the parser.

## Phase 2 — Listener + Parser + Attachments (1 hr)
- [ ] `Listener.gs`: query builder, fetch, sender filter.
- [ ] `Parser.gs`: label synonyms, date normalization, `validateHire`.
- [ ] `Attachments.gs`: per-hire Drive folder, skip tiny inline images.
- [ ] `processNewHireEmails()`: dedupe → insert hire → save files → label → (NEEDS_INFO email if invalid).
- [ ] Test: send yourself a sample HR email (EMAIL_TEMPLATES §1) and run.

## Phase 3 — Dispatcher (45 min)
- [ ] `Templates.gs`: §2 request (text + HTML).
- [ ] `selectTeamsForHire`, `dispatchRequestsForHire`; store `thread_id`; label `NH/Request`.
- [ ] Hook into `processNewHireEmails()` after a successful insert.
- [ ] Test in DRY_RUN: Log tab shows one email per team.

## Phase 4 — Reply watcher + HR notifications (1 hr)
- [ ] `ReplyWatcher.gs`: search, `stripQuoted`, `classifyReply` (block keywords first), `handleReply`.
- [ ] `Notifier`: §3, §4, §5 templates; `checkHireCompletion`.
- [ ] Track replies per message via `Requests.last_processed_msg_id` (read state is irrelevant); label thread `NH/ReplyProcessed` for visibility only.

## Phase 5 — Main loop, trigger, reminders (30 min)
- [ ] `Main.gs` → `runAll()` with LockService and per-step try/catch.
- [ ] `sendReminders()` (§7, §8).
- [ ] `syncManualOverrides()`: re-check completion for rows with `manual_override = TRUE`.
- [ ] Trigger: `ScriptApp.newTrigger('runAll').timeBased().everyMinutes(5).create()` (in setup).

## Phase 6 — Live test + polish (45 min)
- [ ] Set `DRY_RUN = FALSE`.
- [ ] Run every scenario in `TESTING.md`.
- [ ] Add conditional formatting to the Requests status column.
- [ ] Write a short "How HR uses it" note (email format + tracker link).

## Demo script (5 min)
1. Show the Teams + Config tabs (no code changes needed to add a team).
2. Send the HR email with attachments → run `runAll()` → show the Hires row, Drive folder, and 3 emails in the team inboxes.
3. Reply "Access provided" from two teams and "Need more info" from one → run → show HR inbox + colors in the tracker.
4. Fix the blocked one → final "All access provided" email.
