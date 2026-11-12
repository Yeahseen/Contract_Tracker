(function () {
  "use strict";
  var MON = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  var DAY = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  var files = [], cur = { emp: null, ym: null, view: "one", dept: "__all" };
  var $ = function (s) { return document.querySelector(s); };

  function isAdminNow() { var r = document.getElementById("roleLabel"); return !!r && r.textContent === "Admin"; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function dk(d) { return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
  function ymk(d) { return d.getFullYear() + "-" + (d.getMonth() + 1); }
  function tm(d) { return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function normId(s) { return String(s).trim().replace(/^0+/, ""); }

  function toDate(v) {
    if (v instanceof Date) return v;
    if (typeof v === "number") { var p = XLSX.SSF.parse_date_code(v); return new Date(p.y, p.m - 1, p.d, p.H, p.M, Math.floor(p.S)); }
    if (typeof v === "string") {
      var s = v.trim(), m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T]?(\d{1,2})?:?(\d{2})?:?(\d{2})?/);
      if (m) return new Date(+m[3], +m[1] - 1, +m[2], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
      m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
      if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    }
    return null;
  }

  function parseFile(name, buf) {
    var wb = XLSX.read(buf, { type: "array" }), rows = [];
    wb.SheetNames.forEach(function (n) {
      XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: "" }).forEach(function (r) {
        var o = {}; Object.keys(r).forEach(function (k) { o[k.trim()] = r[k]; }); rows.push(o);
      });
    });
    if (!rows.length) return { name: name, type: "unknown", rows: [] };
    var h = rows[0], out = [];
    if ("Time" in h && ("Emp ID" in h || "Name" in h)) {
      rows.forEach(function (r) { var d = toDate(r["Time"]); if (d) out.push({ id: normId(r["Emp ID"]), name: String(r["Name"] || ""), dt: d }); });
      return { name: name, type: "punch", rows: out };
    }
    if ("Attendance Date" in h) {
      rows.forEach(function (r) { var d = toDate(r["Attendance Date"]); if (d) out.push({ id: normId(r["Employee"] || r["Emp ID"] || ""), name: String(r["Employee Name"] || ""), dt: d, type: String(r["Leave Type"] || "Leave"), dept: String(r["Department"] || "") }); });
      return { name: name, type: "leave", rows: out };
    }
    return { name: name, type: "unknown", rows: [] };
  }

  // ----- Public holidays -----
  var KE_MOON = { "2025-3-31": "Idd-ul-Fitr", "2025-6-6": "Idd-ul-Azha", "2026-3-20": "Idd-ul-Fitr", "2026-5-27": "Idd-ul-Azha" };
  var KE_ONEOFF = { "2025-10-17": "Day of mourning (Raila Odinga)" };
  var HKEY = "attendance:holidays";
  var hs = { ke: true, custom: [] };
  try { var sv = JSON.parse(window.localStorage.getItem(HKEY) || "null"); if (sv) { hs.ke = sv.ke !== false; hs.custom = Array.isArray(sv.custom) ? sv.custom : []; } } catch (e) { /* ignore */ }
  function saveH() { try { window.localStorage.setItem(HKEY, JSON.stringify(hs)); } catch (e) { /* ignore */ } }
  function easter(y) {
    var a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    var h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    var mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(y, mo - 1, da);
  }
  function isoToKey(s) { var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? +m[1] + "-" + +m[2] + "-" + +m[3] : null; }
  function keHolidays(y) {
    var list = [[0, 1, "New Year's Day"], [4, 1, "Labour Day"], [5, 1, "Madaraka Day"], [9, 10, "Mazingira Day"], [9, 20, "Mashujaa Day"], [11, 12, "Jamhuri Day"], [11, 25, "Christmas Day"], [11, 26, "Boxing Day"]]
      .map(function (x) { return { d: new Date(y, x[0], x[1]), n: x[2] }; });
    var e = easter(y);
    list.push({ d: new Date(y, e.getMonth(), e.getDate() - 2), n: "Good Friday" }, { d: new Date(y, e.getMonth(), e.getDate() + 1), n: "Easter Monday" });
    var taken = {}; list.forEach(function (h) { taken[dk(h.d)] = 1; });
    Object.keys(KE_MOON).forEach(function (k) { if (k.split("-")[0] == y) taken[k] = 1; });
    var out = {};
    list.sort(function (a, b) { return a.d - b.d; }).forEach(function (h) {
      var d = h.d, n = h.n;
      if (d.getDay() === 0) {   // Public Holidays Act s.4: a Sunday holiday moves to the next day that is not already a holiday
        var nx = new Date(d); do { nx.setDate(nx.getDate() + 1); } while (taken[dk(nx)]);
        taken[dk(nx)] = 1; d = nx; n = n + " (observed)";
      }
      out[dk(d)] = n;
    });
    Object.keys(KE_MOON).forEach(function (k) { if (k.split("-")[0] == y) out[k] = KE_MOON[k]; });
    Object.keys(KE_ONEOFF).forEach(function (k) { if (k.split("-")[0] == y) out[k] = KE_ONEOFF[k]; });
    return out;
  }
  function holMap(y) {
    var m = hs.ke ? keHolidays(y) : {};
    hs.custom.forEach(function (c) { var k = isoToKey(c.date); if (k && k.split("-")[0] == y) m[k] = c.name; });
    return m;
  }

  function all(type) { var a = []; files.forEach(function (f) { if (f.type === type) a = a.concat(f.rows); }); return a; }

  function trackerMap() {
    var m = {};
    try {
      var t = window.__contractTracker && window.__contractTracker.employees ? window.__contractTracker.employees() : [];
      t.forEach(function (e) { if (e.payrollNo) m[normId(e.payrollNo)] = e; });
    } catch (e) { /* ignore */ }
    return m;
  }

  function employees() {
    var m = {}, tm_ = trackerMap();
    all("punch").concat(all("leave")).forEach(function (r) {
      var e = m[r.id] || (m[r.id] = { id: r.id, name: "", dept: "" });
      if (r.name.length > e.name.length) e.name = r.name;
      if (r.dept && !e.dept) e.dept = r.dept;
    });
    Object.keys(m).forEach(function (k) { var t = tm_[k]; if (t) { m[k].name = t.name || m[k].name; m[k].dept = t.department || ""; m[k].linked = true; } });
    return Object.keys(m).map(function (k) { return m[k]; });
  }

  function months(emp) {
    var s = {};
    all("punch").concat(all("leave")).forEach(function (r) { if (r.id === emp) s[ymk(r.dt)] = 1; });
    return Object.keys(s).sort(function (a, b) { var x = a.split("-"), y = b.split("-"); return (x[0] - y[0]) || (x[1] - y[1]); });
  }

  function build(emp, ym) {
    var y = +ym.split("-")[0], m = +ym.split("-")[1] - 1, n = new Date(y, m + 1, 0).getDate(), rest2 = $("#attRest").value === "1";
    var pu = {}, lv = {};
    all("punch").forEach(function (r) { if (r.id === emp && ymk(r.dt) === ym) (pu[dk(r.dt)] = pu[dk(r.dt)] || []).push(r.dt); });
    all("leave").forEach(function (r) { if (r.id === emp && ymk(r.dt) === ym) lv[dk(r.dt)] = r.type; });
    var hmap = holMap(y), days = [], sum = { present: 0, none: 0, rest: 0, hours: 0, holiday: 0, worked: 0, leave: {} };
    for (var d = 1; d <= n; d++) {
      var dt = new Date(y, m, d), k = dk(dt), p = (pu[k] || []).sort(function (a, b) { return a - b; }), dow = dt.getDay();
      var isRest = dow === 0 || (rest2 && dow === 6), first = p[0], last = p[p.length - 1], hrs = null;
      if (p.length > 1 && (last - first) >= 300000) hrs = (last - first) / 36e5;
      var leave = lv[k] || "", hol = hmap[k] || "", status, cls = "";
      if (p.length && leave) { status = "Present + leave record (check)"; sum.present++; }
      else if (p.length) { status = hol ? "Present (worked on holiday)" : "Present"; sum.present++; if (hol) sum.worked++; }
      else if (leave) { status = leave; cls = "lv"; sum.leave[leave] = (sum.leave[leave] || 0) + 1; }
      else if (isRest) { status = "Rest day"; cls = "rest"; sum.rest++; }
      else if (hol) { status = "Public holiday"; cls = "hol"; sum.holiday++; }
      else { status = "No record"; cls = "nr"; sum.none++; }
      if (hrs) sum.hours += hrs;
      days.push({ date: dt, dow: DAY[dow], first: first ? tm(first) : "", last: p.length > 1 ? tm(last) : "", cnt: p.length, hrs: hrs, leave: leave, hol: hol, status: status, cls: cls });
    }
    return { y: y, m: m, days: days, sum: sum };
  }

  // ----- Department view -----
  function deptOf(e) { return e.dept || "Unassigned"; }
  function byName(a, b) { return (a.name || "").toLowerCase() < (b.name || "").toLowerCase() ? -1 : 1; }
  function groupEmps(emps) {
    return emps.filter(function (e) { return cur.dept === "__all" || deptOf(e) === cur.dept; }).sort(byName);
  }
  function groupMonths(grp) {
    var s = {}; grp.forEach(function (e) { months(e.id).forEach(function (k) { s[k] = 1; }); });
    return Object.keys(s).sort(function (a, b) { var x = a.split("-"), y = b.split("-"); return (x[0] - y[0]) || (x[1] - y[1]); });
  }
  function leaveCode(t) {
    var s = String(t).toLowerCase();
    if (/half pay/.test(s)) return "SH";
    if (/sick/.test(s)) return "SL";
    if (/annual/.test(s)) return "AL";
    if (/matern/.test(s)) return "ML";
    if (/patern/.test(s)) return "PL";
    if (/compass|bereave/.test(s)) return "CL";
    return (String(t).match(/\b\w/g) || ["L"]).slice(0, 2).join("").toUpperCase();
  }
  function cellOf(d) {
    if (d.cnt > 0 && d.leave) return { c: "P!", cls: "", t: "Punch and a leave record on the same day" };
    if (d.cnt > 0) return { c: d.hol ? "PH" : "P", cls: "", t: d.hol ? "Worked on " + d.hol : "Present" };
    if (d.leave) return { c: leaveCode(d.leave), cls: "lv", t: d.leave };
    if (d.cls === "rest") return { c: "R", cls: "rest", t: "Rest day" };
    if (d.cls === "hol") return { c: "H", cls: "hol", t: d.hol };
    return { c: "\u2013", cls: "nr", t: "No record" };
  }
  function leaveTotal(s) { var t = 0; Object.keys(s.leave).forEach(function (k) { t += s.leave[k]; }); return t; }
  function legendCodes(rows) {
    var m = {}; rows.forEach(function (r) { r.b.days.forEach(function (d) { if (d.leave) m[leaveCode(d.leave)] = d.leave; }); });
    return m;
  }

  function renderDept(emps) {
    var grp = groupEmps(emps), ms = groupMonths(grp);
    if (ms.indexOf(cur.ym) < 0) cur.ym = ms[0];
    $("#attTabs").innerHTML = ms.map(function (k) { var a = k.split("-"); return '<button type="button" class="' + (k === cur.ym ? "act" : "") + '" data-k="' + k + '">' + MON[a[1] - 1].slice(0, 3) + " " + a[0] + "</button>"; }).join("");
    var rows = grp.map(function (e) { return { e: e, b: build(e.id, cur.ym) }; });
    var b0 = rows[0].b, n = b0.days.length, tot = { p: 0, l: 0, nr: 0 };
    rows.forEach(function (r) { tot.p += r.b.sum.present; tot.l += leaveTotal(r.b.sum); tot.nr += r.b.sum.none; });
    var label = cur.dept === "__all" ? "All employees" : cur.dept;
    var h = '<h3 style="margin:1rem 0 0;font-family:var(--font-display)">' + esc(label) + " \u2013 " + MON[b0.m] + " " + b0.y + "</h3>";
    h += '<div class="att-sum"><div><b>' + rows.length + "</b><small>Employees</small></div><div><b>" + tot.p + "</b><small>Days present</small></div><div><b>" + tot.l + "</b><small>Leave days</small></div><div><b>" + tot.nr + "</b><small>No-record days</small></div></div>";
    var lc = legendCodes(rows), lk = Object.keys(lc).sort();
    h += '<div class="att-key">P present \u00b7 PH worked on a holiday \u00b7 H public holiday \u00b7 R rest day \u00b7 \u2013 no record' + lk.map(function (k) { return " \u00b7 " + k + " " + esc(lc[k]); }).join("") + ". Tap a name for that employee\u2019s full report.</div>";
    h += '<div class="table-wrap"><table class="att-table att-reg"><thead><tr><th class="nm">Employee</th>';
    b0.days.forEach(function (d) { h += '<th class="dy' + (d.dow === "Sun" ? " sun" : "") + '">' + d.date.getDate() + "<br><small>" + d.dow.charAt(0) + "</small></th>"; });
    h += '<th class="tt">Present</th><th class="tt">Leave</th><th class="tt">No rec.</th><th class="tt">Hours</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      h += '<tr><td class="nm"><button type="button" class="att-link" data-emp="' + esc(r.e.id) + '">' + esc(r.e.name || "Employee") + "</button><small> " + esc(r.e.id) + "</small></td>";
      r.b.days.forEach(function (d) { var c = cellOf(d); h += '<td class="' + c.cls + '" title="' + esc(c.t) + '">' + esc(c.c) + "</td>"; });
      h += '<td class="tt">' + r.b.sum.present + '</td><td class="tt">' + leaveTotal(r.b.sum) + '</td><td class="tt">' + r.b.sum.none + '</td><td class="tt">' + (r.b.sum.hours ? r.b.sum.hours.toFixed(1) : "") + "</td></tr>";
    });
    $("#attRep").innerHTML = h + "</tbody></table></div>";
  }

  function addRegister(wb, grp, ym, label) {
    var rows = grp.map(function (e) { return { e: e, b: build(e.id, ym) }; }), b0 = rows[0].b, n = b0.days.length;
    var ws = wb.addWorksheet(("Register " + MON[b0.m].slice(0, 3) + " " + b0.y).slice(0, 31));
    ws.addRow(["ATTENDANCE REGISTER \u2013 " + label.toUpperCase() + " \u2013 " + MON[b0.m].toUpperCase() + " " + b0.y]).font = { bold: true, size: 14, color: { argb: "FF16233F" } };
    ws.addRow([]);
    var hr = ws.addRow(["Employee", "ID"].concat(b0.days.map(function (d) { return d.date.getDate(); }), ["Present", "Leave", "No record", "Hours"]));
    var hr2 = ws.addRow(["", ""].concat(b0.days.map(function (d) { return d.dow.charAt(0); }), ["", "", "", ""]));
    [hr, hr2].forEach(function (r) { r.eachCell({ includeEmpty: true }, function (c) { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16233F" } }; c.alignment = { horizontal: "center" }; }); });
    var fills = { nr: "FFF8CBAD", lv: "FFDBEAFE", hol: "FFE2F0D9", rest: "FFE9ECEF" };
    rows.forEach(function (r) {
      var cells = r.b.days.map(function (d) { return cellOf(d); });
      var row = ws.addRow([r.e.name, r.e.id].concat(cells.map(function (c) { return c.c; }), [r.b.sum.present, leaveTotal(r.b.sum), r.b.sum.none, r.b.sum.hours ? +r.b.sum.hours.toFixed(2) : ""]));
      cells.forEach(function (c, i) { var cell = row.getCell(3 + i); cell.alignment = { horizontal: "center" }; if (fills[c.cls]) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fills[c.cls] } }; });
      for (var k = 0; k < 4; k++) row.getCell(3 + n + k).alignment = { horizontal: "center" };
    });
    ws.addRow([]);
    var lc = legendCodes(rows), txt = "P present, PH worked on a holiday, H public holiday, R rest day, \u2013 no record" + Object.keys(lc).sort().map(function (k) { return ", " + k + " " + lc[k]; }).join("");
    ws.addRow([txt]).font = { italic: true, size: 9 };
    ws.getColumn(1).width = 30; ws.getColumn(2).width = 8;
    for (var i = 0; i < n; i++) ws.getColumn(3 + i).width = 4.2;
    for (var j = 0; j < 4; j++) ws.getColumn(3 + n + j).width = 10;
    ws.views = [{ state: "frozen", xSplit: 2, ySplit: 4 }];
  }

  function render() {
    var emps = employees(), box = $("#attOut");
    if (!emps.length) { box.style.display = "none"; return; }
    box.style.display = "";
    var dv = cur.view === "dept";
    $("#attView").value = cur.view;
    $("#attEmpWrap").style.display = dv ? "none" : "";
    $("#attDeptWrap").style.display = dv ? "" : "none";
    var dset = {}; emps.forEach(function (e) { dset[deptOf(e)] = 1; });
    var dnames = Object.keys(dset).sort();
    if (cur.dept !== "__all" && !dset[cur.dept]) cur.dept = "__all";
    $("#attDept").innerHTML = '<option value="__all">All employees (' + emps.length + ')</option>' + dnames.map(function (n) {
      var c = emps.filter(function (e) { return deptOf(e) === n; }).length;
      return '<option value="' + esc(n) + '">' + esc(n) + " (" + c + ")</option>";
    }).join("");
    $("#attDept").value = cur.dept;
    if (dv) { renderDept(emps); return; }
    var sel = $("#attEmp"), old = cur.emp;
    sel.innerHTML = emps.map(function (e) { return '<option value="' + esc(e.id) + '">' + esc(e.name || "Employee") + " (ID " + esc(e.id) + ")</option>"; }).join("");
    cur.emp = emps.some(function (e) { return e.id === old; }) ? old : emps[0].id; sel.value = cur.emp;
    var ms = months(cur.emp);
    if (ms.indexOf(cur.ym) < 0) cur.ym = ms[0];
    $("#attTabs").innerHTML = ms.map(function (k) { var a = k.split("-"); return '<button type="button" class="' + (k === cur.ym ? "act" : "") + '" data-k="' + k + '">' + MON[a[1] - 1].slice(0, 3) + " " + a[0] + "</button>"; }).join("");
    var b = build(cur.emp, cur.ym), s = b.sum, e = emps.filter(function (x) { return x.id === cur.emp; })[0];
    var cards = [["Present", s.present], ["No record", s.none], ["Rest days", s.rest]];
    if (s.holiday) cards.push(["Public holidays", s.holiday]);
    if (s.worked) cards.push(["Worked on a holiday", s.worked]);
    Object.keys(s.leave).forEach(function (k) { cards.push([k, s.leave[k]]); });
    if (s.hours) cards.push(["Total hours", s.hours.toFixed(1)]);
    var h = '<h3 style="margin:1rem 0 0;font-family:var(--font-display)">' + esc(e.name) + (e.dept ? " · " + esc(e.dept) : "") + " – " + MON[b.m] + " " + b.y + "</h3>";
    h += '<div class="att-sum">' + cards.map(function (c) { return "<div><b>" + c[1] + "</b><small>" + esc(c[0]) + "</small></div>"; }).join("") + "</div>";
    h += '<div class="att-key"><i style="background:var(--att-nr)"></i>No record (no punch, no leave)<i style="background:var(--att-lv)"></i>Leave<i style="background:var(--att-hol)"></i>Public holiday<i style="background:var(--neutral-bg)"></i>Rest day</div>';
    h += '<div class="table-wrap"><table class="att-table"><thead><tr><th>Date</th><th>Day</th><th>First punch</th><th>Last punch</th><th>Punches</th><th>Hours</th><th>Leave type</th><th>Holiday</th><th>Status</th></tr></thead><tbody>';
    b.days.forEach(function (d) { h += '<tr class="' + d.cls + '"><td>' + pad(d.date.getDate()) + "-" + MON[b.m].slice(0, 3) + "-" + b.y + "</td><td>" + d.dow + "</td><td>" + d.first + "</td><td>" + d.last + "</td><td>" + d.cnt + "</td><td>" + (d.hrs ? d.hrs.toFixed(2) : "") + "</td><td>" + esc(d.leave) + "</td><td>" + esc(d.hol) + "</td><td>" + esc(d.status) + "</td></tr>"; });
    $("#attRep").innerHTML = h + "</tbody></table></div>";
  }

  function renderFiles() {
    $("#attFiles").innerHTML = files.map(function (f, i) {
      var t = f.type === "punch" ? "Punch records" : f.type === "leave" ? "Leave records" : "Not recognised";
      return "<div><span>" + esc(f.name) + ' <span class="t">· ' + t + " (" + f.rows.length + ')</span></span><button type="button" class="att-x" data-i="' + i + '" title="Remove">✕</button></div>';
    }).join("");
    var bad = files.filter(function (f) { return f.type === "unknown"; }).length;
    $("#attMsg").innerHTML = bad ? '<span class="err">Some files were not recognised. Punch files need “Emp ID” and “Time” columns; leave files need “Attendance Date” and “Leave Type”.</span>' : (files.length && !all("punch").length ? "Add at least one punch file." : "");
    render();
  }

  function addFiles(list) {
    Array.prototype.slice.call(list).forEach(function (f) {
      var r = new FileReader();
      r.onload = function () {
        try { var p = parseFile(f.name, new Uint8Array(r.result)); files = files.filter(function (x) { return x.name !== f.name; }); files.push(p); }
        catch (e) { files.push({ name: f.name, type: "unknown", rows: [] }); }
        renderFiles();
      };
      r.readAsArrayBuffer(f);
    });
  }

  function exportAll() {
    var wb = new ExcelJS.Workbook(), dv = cur.view === "dept", emps = dv ? groupEmps(employees()) : employees();
    if (dv && emps.length) { var lab = cur.dept === "__all" ? "All employees" : cur.dept; groupMonths(emps).forEach(function (ym) { addRegister(wb, emps, ym, lab); }); }
    emps.forEach(function (e) {
      months(e.id).forEach(function (ym) {
        var b = build(e.id, ym), nm = MON[b.m] + " " + b.y; if (emps.length > 1) nm = e.id + " " + nm;
        var ws = wb.addWorksheet(nm.slice(0, 31));
        ws.addRow(["BIOMETRIC ATTENDANCE REPORT – " + MON[b.m].toUpperCase() + " " + b.y]).font = { bold: true, size: 14, color: { argb: "FF16233F" } };
        ws.addRow(["Employee: " + e.name + " (ID " + e.id + ")" + (e.dept ? " – " + e.dept : "")]); ws.addRow([]);
        ws.addRow(["SUMMARY"]).font = { bold: true };
        ws.addRow(["Present", b.sum.present]);
        Object.keys(b.sum.leave).forEach(function (k) { ws.addRow([k, b.sum.leave[k]]); });
        ws.addRow(["No record (excl. rest days)", b.sum.none]); ws.addRow(["Rest days", b.sum.rest]);
        if (b.sum.holiday) ws.addRow(["Public holidays", b.sum.holiday]);
        if (b.sum.worked) ws.addRow(["Worked on a holiday", b.sum.worked]);
        if (b.sum.hours) ws.addRow(["Total hours", +b.sum.hours.toFixed(2)]);
        ws.addRow([]);
        var hr = ws.addRow(["Date", "Day", "First punch", "Last punch", "Punches", "Hours", "Leave type", "Holiday", "Status"]);
        hr.eachCell(function (c) { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16233F" } }; c.alignment = { horizontal: "center" }; });
        b.days.forEach(function (d) {
          var r = ws.addRow([pad(d.date.getDate()) + "-" + MON[b.m].slice(0, 3) + "-" + b.y, d.dow, d.first, d.last, d.cnt, d.hrs ? +d.hrs.toFixed(2) : "", d.leave, d.hol, d.status]);
          var col = d.cls === "nr" ? "FFF8CBAD" : d.cls === "lv" ? "FFDBEAFE" : d.cls === "rest" ? "FFE9ECEF" : d.cls === "hol" ? "FFE2F0D9" : null;
          r.eachCell(function (c) { c.alignment = { horizontal: "center" }; if (col) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: col } }; });
        });
        ws.columns = [{ width: 30 }, { width: 8 }, { width: 13 }, { width: 13 }, { width: 10 }, { width: 9 }, { width: 22 }, { width: 26 }, { width: 30 }];
      });
    });
    return wb.xlsx.writeBuffer().then(function (buf) {
      var blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = dv ? "Attendance_Register_" + (cur.dept === "__all" ? "All" : cur.dept).replace(/[^A-Za-z0-9]+/g, "_") + ".xlsx" : "Biometric_Attendance_Report.xlsx";
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    });
  }

  function showView(v) {
    if (v === "att" && !isAdminNow()) return;
    $("#contractsView").style.display = v === "att" ? "none" : "";
    $("#attendanceView").style.display = v === "att" ? "block" : "none";
    $("#tabContracts").classList.toggle("act", v !== "att");
    $("#tabAttendance").classList.toggle("act", v === "att");
    if (v === "att") render();
  }

  function renderHol() {
    $("#attKe").checked = hs.ke;
    $("#attHList").innerHTML = hs.custom.map(function (c, i) {
      return "<div><span>" + esc(c.date) + " · " + esc(c.name) + '</span><button type="button" class="att-x" data-i="' + i + '" title="Remove">✕</button></div>';
    }).join("") || '<div><span class="t">No custom holidays added.</span></div>';
  }

  function init() {
    renderHol();
    $("#attKe").addEventListener("change", function () { hs.ke = this.checked; saveH(); render(); });
    $("#attHAdd").addEventListener("click", function () {
      var d = $("#attHDate").value, n = $("#attHName").value.trim();
      if (!d || !n) { $("#attMsg").innerHTML = '<span class="err">Pick a date and type a name for the holiday.</span>'; return; }
      hs.custom = hs.custom.filter(function (c) { return c.date !== d; }); hs.custom.push({ date: d, name: n });
      hs.custom.sort(function (a, b) { return a.date < b.date ? -1 : 1; }); saveH();
      $("#attHDate").value = ""; $("#attHName").value = ""; $("#attMsg").textContent = ""; renderHol(); render();
    });
    $("#attHList").addEventListener("click", function (e) { var i = e.target.getAttribute("data-i"); if (i !== null) { hs.custom.splice(+i, 1); saveH(); renderHol(); render(); } });
    var drop = $("#attDrop"), fi = $("#attFile");
    drop.addEventListener("click", function () { fi.click(); });
    fi.addEventListener("change", function () { addFiles(fi.files); fi.value = ""; });
    ["dragover", "dragenter"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("on"); }); });
    ["dragleave", "drop"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("on"); }); });
    drop.addEventListener("drop", function (e) { addFiles(e.dataTransfer.files); });
    $("#attFiles").addEventListener("click", function (e) { var i = e.target.getAttribute("data-i"); if (i !== null) { files.splice(+i, 1); renderFiles(); } });
    $("#attTabs").addEventListener("click", function (e) { var k = e.target.getAttribute("data-k"); if (k) { cur.ym = k; render(); } });
    $("#attEmp").addEventListener("change", function () { cur.emp = this.value; render(); });
    $("#attView").addEventListener("change", function () { cur.view = this.value; render(); });
    $("#attDept").addEventListener("change", function () { cur.dept = this.value; render(); });
    $("#attRep").addEventListener("click", function (e) { var id = e.target.getAttribute("data-emp"); if (id) { cur.view = "one"; cur.emp = id; render(); } });
    $("#attRest").addEventListener("change", render);
    $("#attDl").addEventListener("click", function () {
      exportAll().catch(function () { $("#attMsg").innerHTML = '<span class="err">Could not create the Excel file.</span>'; });
    });
    $("#tabContracts").addEventListener("click", function () { showView("con"); });
    $("#tabAttendance").addEventListener("click", function () { showView("att"); });
  }
  init();
})();
