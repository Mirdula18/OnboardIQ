# How HR uses OnboardIQ

1. **Send one email per new hire** to the onboarding mailbox. Put "New Hire" in the subject and use this format:

   ```
   Subject: New Hire – Priya Sharma

   Full Name: Priya Sharma
   Employee ID: EMP2045
   Department: Engineering
   Designation: Software Engineer
   Joining Date: 2026-11-10
   Location: Coimbatore Office
   Reporting Manager: Arun Kumar
   Email: priya.sharma@company.com
   Phone: +91 98xxxxxxx
   ```

   - **Full Name, Employee ID and Joining Date are required.** If any is missing, OnboardIQ replies asking for it. Reply in that same thread with the full email.
   - Attach the photo, offer letter and ID proof. They are saved to Drive, and the photo goes to the ID card team.

2. **Wait for updates.** You'll get an email each time a team confirms ("Wi-Fi / IT access provided – 2 of 3 done") and a final **"All access provided ✅"** summary.

3. **If a team is stuck**, you'll get an "Action needed" email quoting their reply. Reply to the team in their request thread, or fix the status yourself in the tracker.

4. **Tracker:** the Google Sheet → `Requests` tab (green = provided, yellow = waiting, red = blocked/overdue, orange = unclear). You can change a status from the dropdown. The bot treats your change as final and re-checks completion on its next run.

5. Don't send the same hire twice. A repeat email for the same Employee ID is logged as a duplicate and nothing is re-sent.
