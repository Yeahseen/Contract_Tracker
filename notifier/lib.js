"use strict";
// Pure logic for the daily reminder job: who needs a reminder today, and what the email says.

function arrayFrom(v) {
  if (Array.isArray(v)) return v.filter((x) => x != null);
  if (v && typeof v === "object") return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]);
  return [];
}

// Same key encoding the app uses for Firebase keys.
function dbKey(id) {
  return String(id).replace(/[.$#\[\]\/%\x00-\x1f]/g, (c) => "%" + ("0" + c.charCodeAt(0).toString(16).toUpperCase()).slice(-2));
}

function ymdInTz(date, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function dayNumber(ymd) {
  const p = ymd.split("-").map(Number);
  return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 86400000);
}
function weekdayOf(ymd) {
  const p = ymd.split("-").map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();   // 1 = Monday
}
function daysUntil(todayYmd, iso, tz) {
  return dayNumber(ymdInTz(new Date(iso), tz)) - dayNumber(todayYmd);
}
function fmtDate(iso, tz) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}

function normalizeSettings(s) {
  const n = (s && s.notify) || {};
  const thresholds = arrayFrom(n.thresholds).map(Number).filter((x) => x > 0 && x <= 365);
  return {
    notify: {
      enabled: n.enabled !== false,
      emails: arrayFrom(n.emails).map(String).filter(Boolean),
      thresholds: thresholds.length ? thresholds : [60, 30, 14],
      weekly: n.weekly !== false,
      appUrl: n.appUrl ? String(n.appUrl) : ""
    }
  };
}

// The contract that counts is the live one with the latest start date (same rule as the app).
function currentContract(emp) {
  const live = arrayFrom(emp.contracts).filter((c) => c && !c.deleted);
  if (!live.length) return null;
  live.sort((a, b) => {
    const ta = a.startDate ? Date.parse(a.startDate) : -Infinity;
    const tb = b.startDate ? Date.parse(b.startDate) : -Infinity;
    if (tb !== ta) return tb - ta;
    return (b.addedAt ? Date.parse(b.addedAt) : 0) - (a.addedAt ? Date.parse(a.addedAt) : 0);
  });
  return live[0];
}

// -1 = expired within the last 30 days; otherwise the smallest reminder threshold the contract is inside.
function levelFor(days, thresholds) {
  if (days < 0) return days >= -30 ? -1 : "stale";
  const asc = thresholds.slice().sort((a, b) => a - b);
  for (const t of asc) if (days <= t) return t;
  return null;
}

function buildPlan(input) {
  const tz = input.tz || "Africa/Nairobi";
  const notify = normalizeSettings(input.settings).notify;
  const notifyState = input.notifyState || {};
  const employees = Array.isArray(input.employees) ? input.employees : arrayFrom(Object.keys(input.employees || {}).map((k) => input.employees[k]));
  const items = [];
  let stale = 0;

  for (const emp of employees) {
    if (!emp || emp.active === false) continue;                       // people who left are never chased
    const c = currentContract(emp);
    if (!c || !c.endDate) continue;
    const stage = emp.renewal && emp.renewal.contractId === c.id && emp.renewal.stage ? emp.renewal.stage : "none";
    if (stage === "renewed" || stage === "notrenewing") continue;     // the admin has already dealt with it
    const days = daysUntil(input.today, c.endDate, tz);
    const level = levelFor(days, notify.thresholds);
    if (level === "stale") { stale++; continue; }
    if (level === null) continue;
    items.push({
      key: c.id || (emp.id + "|" + c.startDate + "|" + c.endDate),
      name: emp.name, department: emp.department || "", designation: emp.designation || "",
      endDate: c.endDate, days, level, stage
    });
  }
  items.sort((a, b) => a.days - b.days);

  // a contract is reported again only when it becomes more urgent than the last time we told the admin
  const triggers = items.filter((i) => {
    const sent = notifyState[dbKey(i.key)];
    return sent === undefined || sent === null || i.level < sent;
  });
  const weekly = notify.weekly && weekdayOf(input.today) === 1;
  const shouldSend = notify.enabled && notify.emails.length > 0 &&
    (triggers.length > 0 || (weekly && (items.length > 0 || stale > 0)));
  return { items, triggers, stale, weekly, shouldSend, notify, kind: triggers.length ? "alert" : "weekly" };
}

const STAGE_LABEL = { none: "Not started", inprogress: "In progress", renewed: "Renewed", notrenewing: "Not renewing" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");

function whenText(days) {
  if (days < 0) return plural(-days, "day") + " ago";
  if (days === 0) return "today";
  return "in " + plural(days, "day");
}

function renderEmail(plan, opts) {
  const tz = opts.tz || "Africa/Nairobi";
  const company = opts.company || "Contract Tracker";
  const appUrl = plan.notify.appUrl || opts.appUrl || "";
  const thresholds = plan.notify.thresholds.slice().sort((a, b) => a - b);
  const triggerKeys = new Set(plan.triggers.map((t) => t.key));

  const countBy = (list) => {
    const parts = [];
    const expired = list.filter((i) => i.level === -1).length;
    if (expired) parts.push(expired + " expired");
    thresholds.forEach((t) => {
      const n = list.filter((i) => i.level === t).length;
      if (n) parts.push(n + " within " + t + " days");
    });
    return parts.join(", ");
  };

  const subject = plan.kind === "alert"
    ? company + " contracts: " + plural(plan.triggers.length, "contract") + " need attention (" + countBy(plan.triggers) + ")"
    : company + " weekly contract summary: " + plural(plan.items.length, "contract") + " still open";

  const sections = [{ title: "Expired in the last 30 days", level: -1 }]
    .concat(thresholds.map((t) => ({ title: "Ending within " + t + " days", level: t })));

  const textLines = [subject, ""];
  let html = '<div style="font-family:Arial,Helvetica,sans-serif;color:#1d2433;max-width:680px">' +
    '<h2 style="margin:0 0 4px;color:#16233f">' + esc(company) + " contracts</h2>" +
    '<p style="margin:0 0 16px;color:#667085;font-size:14px">' + esc(plan.kind === "alert"
      ? plural(plan.triggers.length, "contract") + " newly need attention: " + countBy(plan.triggers) + "."
      : "Nothing new today. This is your Monday summary of contracts that are still open.") + "</p>";

  for (const s of sections) {
    const list = plan.items.filter((i) => i.level === s.level);
    if (!list.length) continue;
    textLines.push(s.title.toUpperCase());
    html += '<h3 style="margin:18px 0 6px;font-size:15px;color:#16233f">' + esc(s.title) + "</h3>" +
      '<table style="border-collapse:collapse;width:100%;font-size:13px">' +
      '<tr style="background:#eef0f3;text-align:left"><th style="padding:6px 8px">Employee</th><th style="padding:6px 8px">Ends</th><th style="padding:6px 8px">Renewal</th></tr>';
    for (const i of list) {
      const isNew = triggerKeys.has(i.key);
      const detail = [i.department, i.designation].filter(Boolean).join(" · ");
      textLines.push("- " + i.name + (detail ? " (" + detail + ")" : "") + " - ends " + fmtDate(i.endDate, tz) + " (" + whenText(i.days) + ") - renewal: " + STAGE_LABEL[i.stage] + (isNew ? " [NEW]" : ""));
      html += '<tr style="border-top:1px solid #e2e4e8"><td style="padding:6px 8px"><strong>' + esc(i.name) + "</strong>" +
        (isNew ? ' <span style="background:#b3261e;color:#fff;font-size:10px;padding:1px 5px;border-radius:3px">NEW</span>' : "") +
        (detail ? '<br><span style="color:#667085">' + esc(detail) + "</span>" : "") + "</td>" +
        '<td style="padding:6px 8px;white-space:nowrap">' + esc(fmtDate(i.endDate, tz)) + '<br><span style="color:' + (i.days < 0 ? "#b3261e" : "#667085") + '">' + esc(whenText(i.days)) + "</span></td>" +
        '<td style="padding:6px 8px">' + esc(STAGE_LABEL[i.stage]) + "</td></tr>";
    }
    html += "</table>";
    textLines.push("");
  }
  if (plan.stale) {
    const m = plural(plan.stale, "older expired contract") + (plan.stale === 1 ? " is" : "s are") + " still open. Mark people who left as resigned, or add their new contract.";
    textLines.push(m, "");
    html += '<p style="margin:16px 0 0;font-size:13px;color:#667085">' + esc(m) + "</p>";
  }
  if (appUrl) {
    textLines.push("Open the tracker: " + appUrl);
    html += '<p style="margin:18px 0 0"><a href="' + esc(appUrl) + '" style="color:#2b3a5c">Open the tracker</a></p>';
  }
  html += '<p style="margin:18px 0 0;font-size:11px;color:#98a2b3">Sent automatically. Change who receives this under Admin tools in the tracker.</p></div>';
  return { subject, text: textLines.join("\n"), html };
}

module.exports = { arrayFrom, dbKey, ymdInTz, dayNumber, weekdayOf, daysUntil, fmtDate, normalizeSettings, currentContract, levelFor, buildPlan, renderEmail };
