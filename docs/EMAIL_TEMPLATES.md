# Email Templates

Placeholders use `{{name}}`. All templates are implemented in `src/Templates.gs`. Plain-text body plus a simple HTML version (a table for details).

---

## §1 HR → Bot: new hire email (input format)

Share this with HR. The parser reads `Label: value` lines; label matching is case-insensitive, and synonyms in brackets are accepted.

```
Subject: New Hire – Priya Sharma

Full Name: Priya Sharma                 [Name, Employee Name]
Employee ID: EMP2045                    [Emp ID, Employee No]
Department: Engineering
Designation: Software Engineer          [Role, Title]
Joining Date: 2026-11-10                [DOJ, Date of Joining]  (YYYY-MM-DD or DD/MM/YYYY)
Location: Coimbatore Office             [Work Location, Office]
Reporting Manager: Arun Kumar           [Manager]
Email: priya.sharma@company.com
Phone: +91 98xxxxxxx

Attachments: photo.jpg, offer_letter.pdf, id_proof.pdf
```

Required: Full Name, Employee ID, Joining Date.

---

## §2 Bot → Department: access request

```
Subject: [NH-{{hireNo}}-{{teamCode}}] {{teamName}} access request – {{fullName}} (joins {{joiningDate}})

Hello {{teamName}} team,

A new employee is joining. Please arrange {{teamName}} access.

  Name:          {{fullName}}
  Employee ID:   {{employeeId}}
  Department:    {{department}}
  Designation:   {{designation}}
  Joining date:  {{joiningDate}}
  Location:      {{location}}
  Manager:       {{manager}}

{{#attachments}}Attached: {{attachmentNames}}{{/attachments}}

When access is ready, just REPLY to this email with "Access provided".
If something is missing, reply with "Need more info" and what you need.

Please keep the subject line unchanged — it is used for tracking.

— {{botName}}
```

---

## §3 Bot → HR: one team confirmed

```
Subject: [NH-{{hireNo}}] {{teamName}} access provided – {{fullName}}

Hi HR,

{{teamName}} access has been provided for {{fullName}} ({{employeeId}}).
Confirmed by: {{repliedBy}} at {{confirmedAt}}

Progress: {{providedCount}} of {{totalCount}} teams done.
Pending: {{pendingTeamNames}}

Tracker: {{sheetUrl}}
— {{botName}}
```
CC: `STAKEHOLDER_CC`.

---

## §4 Bot → HR: all access provided

```
Subject: [NH-{{hireNo}}] All access provided – {{fullName}} ✅

Hi HR,

All access for {{fullName}} ({{employeeId}}, joining {{joiningDate}}) is ready:

{{#requests}}
  • {{teamName}} — provided by {{repliedBy}} on {{confirmedAt}}
{{/requests}}

Documents: {{driveFolderUrl}}
— {{botName}}
```
CC: `STAKEHOLDER_CC` + manager email if known.

---

## §5 Bot → HR: team blocked / needs info

```
Subject: [NH-{{hireNo}}] Action needed: {{teamName}} – {{fullName}}

Hi HR,

The {{teamName}} team replied and needs attention:

"{{replySnippet}}"
— {{repliedBy}}

Please reply to them directly in the request thread, or update the status in the tracker: {{sheetUrl}}
— {{botName}}
```
(Same layout for UNCLEAR replies, with the subject "Please review reply".)

---

## §6 Bot → HR: missing details in the new-hire email

Sent as a reply in the original HR thread.

```
Hi,

I couldn't start onboarding requests because these details are missing:
  • {{missingFields}}

Please reply with the full new-hire email in this format:
Full Name: ...
Employee ID: ...
Joining Date: ...

— {{botName}}
```

---

## §7 Bot → Department: reminder

Sent as a reply in the same request thread.

```
Gentle reminder ({{reminderNo}}/{{maxReminders}}): {{fullName}} joins on {{joiningDate}}.
Please reply "Access provided" once {{teamName}} access is ready.

— {{botName}}
```

## §8 Bot → HR: overdue

```
Subject: [NH-{{hireNo}}] Overdue: {{teamName}} – {{fullName}}

No response from {{teamName}} after {{maxReminders}} reminders ({{hoursSinceSent}} hours).
Please follow up. Tracker: {{sheetUrl}}

— {{botName}}
```
