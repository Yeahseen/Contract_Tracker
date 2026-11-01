"use strict";
// Runs once a day (GitHub Actions). Reads the tracker's database, works out which contracts need a
// reminder, emails the admin(s) set in the tracker, and remembers what it has already reported.

const lib = require("./lib");

async function main(env, deps) {
  env = env || process.env;
  deps = deps || {};
  const fetchFn = deps.fetch || fetch;
  const tz = env.TZ_NAME || "Africa/Nairobi";
  const now = deps.now || new Date();
  const need = ["FIREBASE_DB_URL", "FIREBASE_API_KEY", "NOTIFIER_EMAIL", "NOTIFIER_PASSWORD"];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) throw new Error("Missing settings: " + missing.join(", "));
  const base = env.FIREBASE_DB_URL.replace(/\/$/, "");

  // sign in as the reminder account (a read-only Firebase user that may also record what it has sent)
  const sign = await fetchFn("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + encodeURIComponent(env.FIREBASE_API_KEY), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: env.NOTIFIER_EMAIL, password: env.NOTIFIER_PASSWORD, returnSecureToken: true })
  });
  const signData = await sign.json();
  if (!sign.ok) throw new Error("Could not sign in as the reminder account: " + ((signData.error && signData.error.message) || sign.status));
  const token = signData.idToken;

  const call = async (method, path, body) => {
    const r = await fetchFn(base + "/" + path + ".json?auth=" + encodeURIComponent(token), {
      method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!r.ok) throw new Error(method + " " + path + " failed (HTTP " + r.status + ")");
    return r.json();
  };

  const employees = (await call("GET", "employees")) || {};
  const settings = await call("GET", "settings");
  const stateAll = (await call("GET", "notify_state")) || {};
  const notifyState = {};
  Object.keys(stateAll).forEach((k) => { if (k[0] !== "_" && typeof stateAll[k] === "number") notifyState[k] = stateAll[k]; });

  const today = lib.ymdInTz(now, tz);
  const plan = lib.buildPlan({ employees, settings, notifyState, today, tz });
  const recipients = plan.notify.emails.length ? plan.notify.emails : String(env.NOTIFY_TO || "").split(/[,;\s]+/).filter(Boolean);
  if (!plan.notify.emails.length && recipients.length) plan.notify.emails = recipients;
  plan.shouldSend = plan.shouldSend || (plan.notify.enabled && recipients.length > 0 && (plan.triggers.length > 0 || (plan.weekly && (plan.items.length > 0 || plan.stale > 0))));

  const lastRun = { at: now.toISOString(), sent: 0, status: "" };
  if (!plan.notify.enabled) {
    lastRun.status = "reminders are switched off in the tracker";
  } else if (!recipients.length) {
    lastRun.status = "no recipient email address set in the tracker";
  } else if (!plan.shouldSend) {
    lastRun.status = "nothing new to report";
  } else {
    const mail = lib.renderEmail(plan, { tz, company: env.COMPANY_NAME || "Majani Mingi", appUrl: env.APP_URL || "" });
    let transport = deps.transport;
    if (!transport) {
      const nodemailer = require("nodemailer");
      const port = Number(env.SMTP_PORT || 465);
      transport = nodemailer.createTransport({ host: env.SMTP_HOST || "smtp.gmail.com", port, secure: port === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } });
    }
    await transport.sendMail({ from: env.MAIL_FROM || env.SMTP_USER, to: recipients.join(", "), subject: mail.subject, text: mail.text, html: mail.html });
    // only after the email has really gone out do we remember it, so a failed send is retried tomorrow
    if (plan.triggers.length) {
      const patch = {};
      plan.triggers.forEach((t) => { patch[lib.dbKey(t.key)] = t.level; });
      await call("PATCH", "notify_state", patch);
    }
    lastRun.sent = plan.triggers.length;
    lastRun.status = plan.triggers.length ? "emailed " + plan.triggers.length + " contract(s)" : "sent the Monday summary";
  }
  await call("PUT", "notify_state/_lastRun", lastRun);
  console.log("Reminder run " + today + ": " + lastRun.status);
  return { plan, lastRun };
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
module.exports = { main };
