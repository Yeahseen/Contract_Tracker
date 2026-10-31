# Contract Tracker – setup guide

## What is in this folder

| File | What it is |
|---|---|
| `index.html`, `app.js`, `styles.css`, `vendor/` | The tracker itself. You never edit these. |
| `config.js` | **The only file you edit.** Your Firebase address, key and admin emails. |
| `notifier/` + `.github/workflows/contract-reminders.yml` | The daily reminder-email job (runs free on GitHub). |

When the tracker is updated later, replace everything **except `config.js`**.

---

## 1. Put it online (Render)

Upload everything in this folder to the root of your GitHub repository (replace the old `index.html`).
Render redeploys by itself within a minute or two.

> The `.github` folder is hidden on some computers and may not upload. If it doesn't, see step 3.4.

## 2. Share the data between devices and protect it (Firebase)

Do these in the Firebase console, in this order:

1. **Authentication → Sign-in method → Email/Password → Enable.**
2. **Authentication → Users → Add user.** Create:
   * one account for each **admin** (people who may edit), e.g. `hr@yourcompany.com`
   * one for each **viewer** (read-only)
   * one **reminder account**, e.g. `reminders@yourcompany.com` (used only by the daily job)

   Use lowercase emails (they don't need to be real mailboxes) and passwords of 6+ characters.
3. **Authentication → Settings → User actions:** if you see *Enable create (sign-up)*, switch it **off**, so nobody else can register.
4. **Project settings (gear icon) → General → Web API Key.** Copy it.
5. Open **`config.js`**, fill in the three values and upload it to GitHub:
   * `firebaseDbUrl` – copy it exactly from *Realtime Database* (the address at the top)
   * `firebaseApiKey` – the key from step 4
   * `adminEmails` – e.g. `["hr@yourcompany.com"]`
6. Open the tracker and **sign in as an admin.** Your existing data appears and is moved to the new, safer layout automatically (the old copy is left untouched as a safety net).
7. **Only now lock the database:** in the tracker open **Admin tools → Database rules for Firebase**, type the admin, viewer and reminder-account emails, press **Copy rules**, then paste them into *Realtime Database → Rules* and **Publish**.
8. Check: open `<your database address>/employees.json` in a browser tab. It should say **Permission denied**.

## 3. Reminder emails – only the admin is notified

1. In the tracker: **Admin tools → Reminder emails.** Tick *Send reminder emails*, enter the admin's email address(es), the days to warn at (default `60, 30, 14`), your site's address, and **Save**.
2. Create an **app password** for the mailbox that will send the emails (for Gmail: Google Account → Security → turn on 2-Step Verification → *App passwords*).
3. In GitHub: **Settings → Secrets and variables → Actions → New repository secret.** Add:

   | Secret | Value |
   |---|---|
   | `FIREBASE_DB_URL` | same address as in `config.js` |
   | `FIREBASE_API_KEY` | same key as in `config.js` |
   | `NOTIFIER_EMAIL` / `NOTIFIER_PASSWORD` | the reminder account from step 2.2 |
   | `SMTP_USER` / `SMTP_PASS` | the sending mailbox and its app password |

   Optional: `MAIL_FROM`, `SMTP_HOST` (default `smtp.gmail.com`), `SMTP_PORT` (default `465`), `NOTIFY_TO` (used only if no recipient is set in the tracker), `APP_URL`.
4. Make sure the file `.github/workflows/contract-reminders.yml` is in your repository. If the hidden folder didn't upload: GitHub → **Add file → Create new file**, type `.github/workflows/contract-reminders.yml` as the name and paste the file's contents.
5. **Test it:** GitHub → **Actions → Contract reminders → Run workflow.** Check the inbox. *Admin tools* then shows when the job last ran.

**How it behaves.** It runs every morning at 07:00 Nairobi time. It emails the admin when a contract first enters a warning window (for example 60, 30 or 14 days left) or has just expired, and does not repeat the same warning. On Mondays it also sends a summary of anything still open. It ignores people marked as resigned and contracts marked *Renewed* or *Not renewing*. Contracts expired for more than 30 days are only mentioned as a count.

**Important.** GitHub pauses scheduled jobs in a *public* repository after 60 days without any activity. The job tries to keep itself switched on, and *Admin tools* shows when it last ran. To be safe, make the repository **private** (Render works with private repositories).

## 4. Everyday use

* **Needs attention** (top of the page, admins only) lists contracts expiring soon. Set the renewal stage right there.
* **Backup:** *Admin tools → Download backup*, once a month is a good habit. *Restore from backup* puts a backup back.
* **Activity log:** *Admin tools → View activity log* shows who changed what and when.
* **Deleting a contract period** hides it; it can be restored from *Deleted periods* in that employee's History.
* **Adding a viewer or admin later:** create the account in Firebase, add the email to `config.js` if it is an admin, then regenerate and republish the rules.
* **Two admins at once** is fine when they edit different employees. If they edit the *same* employee at the same moment, the last save wins (the activity log shows both).
* **No internet:** changes are kept on the device and sent when the connection returns.

## 5. Good to know

* The data is personal data about employees. Keep the number of admin and viewer accounts small, and remove accounts when people leave.
* Reminders are by email only. Days are counted on the Nairobi calendar.
* If you leave the three Firebase values in `config.js` empty, the tracker works in a single browser with the simple local passwords from `config.js`.
