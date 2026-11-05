# Testing

Use Gmail plus-aliases so one inbox can play every role:
`you+hr@gmail.com` (HR), `you+idcard@gmail.com`, `you+gate@gmail.com`, `you+wifi@gmail.com` (teams).
Note: replies sent from your own account are `from:me`. For realistic reply tests, send team replies from a **second Gmail account**, or set `SELF_TEST_MODE = TRUE` in the Config tab: searches then drop `-from:me` and the bot recognises its own mail by the `— <BOT_NAME>` signature. `sendSampleHrEmail()` / `sendSampleHrEmailMissingId()` send T1 / T4 inputs; `resetDemoData()` clears rows + labels to rerun.

Run `runAll()` manually from the editor after each step instead of waiting for the trigger.

## Scenarios

| # | Scenario | Steps | Expected |
|---|---|---|---|
| T1 | Happy path | HR email (§1 format) with 2 attachments | Hire `NH-1001` DISPATCHED; Drive folder with 2 files; 3 request emails with tags; HR email labeled `NH/Processed` |
| T2 | Idempotency | Run `runAll()` twice more | No new rows, no new emails |
| T3 | Duplicate hire | Forward the same HR email again | Labeled `NH/Duplicate`; Log entry; nothing sent |
| T4 | Missing fields | HR email without Employee ID | Hire `NEEDS_INFO`; §6 reply to HR; no team emails |
| T5 | Keyword miss | Email "Lunch plans" | Ignored, no label |
| T6 | Unauthorized sender | `HR_SENDERS` set; email from another address | Ignored + Log WARN |
| T7 | Team provides | Reply "Access provided" on WIFI thread | Request PROVIDED; §3 email to HR showing 1/3 |
| T8 | Quoted text | Reply "Need more info" above quoted original containing "access provided" | Classified BLOCKED (quoted text ignored); §5 to HR |
| T9 | Unclear reply | Reply "Will check tomorrow" | REPLIED_UNCLEAR; HR asked to review |
| T10 | Completion | All teams reply provided | Hire COMPLETED; §4 summary sent once |
| T11 | Manual override | HR sets BLOCKED row to PROVIDED in sheet | Next run: completion re-checked; §4 sent if all done |
| T12 | Reminder | Set `REMINDER_HOURS = 0`, run | Reminder in thread; `reminder_count` increments; after max → OVERDUE + §8 |
| T13 | DRY_RUN | `DRY_RUN = TRUE`, HR email | Rows created, Log has DRYRUN entries, no real mail sent |
| T14 | Error isolation | Corrupt one email (e.g. delete a Teams row mid-run) | That item `NH/Error` + Log ERROR; others processed |
| T15 | Subject edited | Team changes subject but keeps tag | Still matched (thread is matched by `thread_id`) |
| T16 | Reply already read | Team replies "Access provided"; open/read it in the bot mailbox, then run `runAll()` | Still processed: request PROVIDED, §3 sent; `last_processed_msg_id` = that reply's id |
| T17 | Blocked then done | Team replies "Need more info" → run → same thread replies "Done" → run | First run BLOCKED + §5; second run PROVIDED + §3. Running again changes nothing. (Both replies before one run → handled in order, ending PROVIDED) |

## Unit-style checks (run from editor)

- `testParseTag()` — `[NH-1023-WIFI] foo` → `{hireNo: 'NH-1023', teamCode: 'WIFI'}`; no tag → `null`.
- `testParser()` — sample body from EMAIL_TEMPLATES §1 → all fields; DD/MM/YYYY → ISO date.
- `testClassify()` — "Access provided ✅" → PROVIDED; "cannot do, missing photo" → BLOCKED; "ok will do" → UNCLEAR.
- `testStripQuoted()` — removes `On ... wrote:` and `>` lines.
- `testReplyCursor()` — `compareMsgIds` / `isAfterCursor` / `selectNewMessages`: skips bot messages and everything at or before the cursor, orders by date then id; simulates T16 (read reply still selected) and T17 (BLOCKED then PROVIDED, no reprocessing).
- `testUtils()` runs all of the above.
