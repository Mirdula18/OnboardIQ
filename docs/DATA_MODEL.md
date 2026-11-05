# Data Model — Google Sheet

One spreadsheet, five tabs. Row 1 is headers (frozen). `setup()` creates them.

## Tab: Config (key / value)

| key | default | notes |
|---|---|---|
| `HR_EMAIL` | `hr@company.com` | Receives all confirmations |
| `HR_SENDERS` | *(blank = any)* | Comma-separated allowed senders for new-hire emails |
| `STAKEHOLDER_CC` | *(blank)* | Comma-separated CCs on confirmations |
| `NEW_HIRE_KEYWORDS` | `new hire, new joiner, new joinee, onboarding` | |
| `APPROVAL_KEYWORDS` | `access provided, access granted, granted, done, completed, activated` | |
| `BLOCK_KEYWORDS` | `rejected, cannot, need more info, missing, not possible` | Checked **before** approval keywords |
| `POLL_MINUTES` | `5` | 1, 5, 10 or 15 |
| `REMINDER_HOURS` | `24` | |
| `MAX_REMINDERS` | `2` | |
| `MAX_EMAILS_PER_RUN` | `20` | |
| `DRY_RUN` | `TRUE` | Set `FALSE` to send for real |
| `BOT_NAME` | `OnboardIQ` | Sender display name and email signature (`— OnboardIQ`) |
| `SELF_TEST_MODE` | `FALSE` | `TRUE` = single-inbox testing: searches don't use `-from:me`; bot mail is detected by its signature |

## Tab: Teams

| column | example | notes |
|---|---|---|
| `team_code` | `WIFI` | Uppercase, A–Z0–9_; used in tag |
| `team_name` | `Wi-Fi / IT` | |
| `to_emails` | `it-helpdesk@company.com` | Comma-separated |
| `cc_emails` | | |
| `send_attachments` | `FALSE` | TRUE for ID card |
| `applies_to_locations` | | Blank = all |
| `applies_to_departments` | | Blank = all |
| `active` | `TRUE` | |

Seed rows: `IDCARD` (attachments TRUE), `GATE`, `WIFI`, `FACILITY` (desk/locker), `EMAIL` (corporate mailbox, optional). `setup()` seeds them with plus-aliases of the bot account (`you+idcard@…`) and only `IDCARD`, `GATE`, `WIFI` active; `HR_EMAIL` is seeded as `you+hr@…`.

## Tab: Hires

| column | type | notes |
|---|---|---|
| `hire_no` | text | `NH-1001`… (sequential) |
| `employee_id` | text | Dedupe key |
| `full_name` | text | |
| `department` | text | |
| `designation` | text | |
| `joining_date` | date | |
| `location` | text | |
| `manager` | text | |
| `contact_email` | text | |
| `phone` | text | |
| `drive_folder_url` | url | |
| `source_message_id` | text | Gmail message id of HR email |
| `status` | enum | `NEW, NEEDS_INFO, DISPATCHED, IN_PROGRESS, COMPLETED` |
| `created_at` | ISO | |
| `completed_at` | ISO | |

## Tab: Requests

| column | type | notes |
|---|---|---|
| `request_id` | text | `NH-1001-WIFI` (= tag without brackets) |
| `hire_no` | text | FK → Hires |
| `team_code` | text | FK → Teams |
| `status` | enum | `PENDING, SENT, PROVIDED, BLOCKED, REPLIED_UNCLEAR, OVERDUE` (dropdown) |
| `thread_id` | text | Gmail thread of the request |
| `sent_at` | ISO | |
| `last_reminder_at` | ISO | |
| `reminder_count` | number | |
| `replied_by` | text | |
| `reply_snippet` | text | First 200 chars of new reply text |
| `confirmed_at` | ISO | |
| `manual_override` | bool | TRUE if HR edited status by hand |
| `last_processed_msg_id` | text | Reply cursor: Gmail id of the newest message in the request thread already handled. Set to the outgoing request's id at dispatch; only messages after it (by date, then id) are processed. Clear it to make the bot re-read the whole thread |

Conditional formatting on `status`: PROVIDED green, SENT yellow, BLOCKED/OVERDUE red, REPLIED_UNCLEAR orange.

## Tab: Log

| column | notes |
|---|---|
| `timestamp` | ISO, Asia/Kolkata |
| `level` | INFO / WARN / ERROR / DRYRUN |
| `action` | e.g. `NEW_HIRE_PARSED`, `REQUEST_SENT`, `REPLY_CLASSIFIED` |
| `ref` | hire_no / request_id / message id |
| `details` | free text / JSON |

## Hire number generation

Read the max numeric part of `hire_no` in Hires and add 1, starting at 1001, inside the script lock.
