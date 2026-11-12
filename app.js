(function () {
  "use strict";

  // Surface any unexpected error visibly instead of failing silently,
  // so a broken feature is obvious rather than looking like "nothing happened".
  (function () {
    var banner = document.getElementById("errorBanner");
    var text = document.getElementById("errorBannerText");
    var closeBtn = document.getElementById("errorBannerClose");
    if (!banner) return;
    window.addEventListener("error", function (e) {
      text.textContent = "Something went wrong: " + (e.message || "unknown error") + ". Try reloading the page.";
      banner.classList.add("show");
    });
    window.addEventListener("unhandledrejection", function (e) {
      text.textContent = "Something went wrong: " + ((e.reason && e.reason.message) || e.reason || "unknown error") + ". Try reloading the page.";
      banner.classList.add("show");
    });
    closeBtn.addEventListener("click", function () { banner.classList.remove("show"); });
  })();

  var toastEl = document.getElementById("toast");
  var toastText = document.getElementById("toastText");
  var toastTimer = null;
  function showToast(message, kind) {
    toastText.textContent = message;
    toastEl.className = "toast show" + (kind === "info" ? " info" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 7000);
  }
  document.getElementById("toastClose").addEventListener("click", function () {
    toastEl.classList.remove("show");
    clearTimeout(toastTimer);
  });

  var STORAGE_KEY = "contract-tracker:data:v2";
  var LEGACY_KEY = "contract-tracker:rows:v1";

  // Settings come from config.js (the only file you normally need to edit).
  var CFG = window.APP_CONFIG || {};
  var COMPANY = CFG.companyName || "Majani Mingi";
  var REPORT_TITLE = COMPANY + " Employees Contract Tracker";
  var FIREBASE_DB_URL = CFG.firebaseDbUrl || "";
  var FIREBASE_API_KEY = CFG.firebaseApiKey || "";
  var ADMIN_EMAILS = (Array.isArray(CFG.adminEmails) ? CFG.adminEmails : String(CFG.adminEmails || "").split(","))
    .map(function (x) { return String(x).trim().toLowerCase(); }).filter(Boolean);
  var LOCAL_PASSWORDS = CFG.localPasswords || { admin: "1234", viewer: "6789" };
  // With the three Firebase values filled in, people sign in with Firebase email + password and the
  // database itself refuses anyone who is not signed in. Without them the app runs in this browser only.
  var AUTH_ENABLED = !!(FIREBASE_DB_URL && FIREBASE_API_KEY);

  var todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  document.getElementById("todayLabel").textContent = todayStart.toLocaleDateString(undefined, {
    weekday: "short", year: "numeric", month: "short", day: "numeric"
  });

  var state = {
    employees: [],
    lastImport: null,
    sortKey: "daysRemaining",
    sortDir: 1,
    statusFilter: "",
    deptFilter: "",
    daysMin: null,
    daysMax: null,
    search: "",
    showResigned: false
  };

  // ---------- access gate ----------
  // A simple client-side gate: fine for keeping casual/accidental edits out,
  // but the passwords live in this file's source, so anyone who views the
  // page source can read them. Not real security for sensitive data.

  var ROLE_KEY = "contract-tracker:role";
  var currentRole = null;

  function isAdmin() { return currentRole === "admin"; }

  function applyRolePermissions() {
    document.querySelectorAll(".admin-only").forEach(function (el) {
      el.style.display = isAdmin() ? "" : "none";
    });
    var roleLabel = document.getElementById("roleLabel");
    if (roleLabel) roleLabel.textContent = isAdmin() ? "Admin" : "Viewer";
    var userLabel = document.getElementById("userLabel");
    if (userLabel) userLabel.textContent = authState.email || "";
  }

  var dataReadyPromise = null;
  function startLoad() {
    if (!dataReadyPromise) dataReadyPromise = loadState();
    return dataReadyPromise;
  }

  function setRole(role) {
    currentRole = role;
    if (!AUTH_ENABLED) { try { window.localStorage.setItem(ROLE_KEY, role); } catch (e) { /* ignore */ } }
    document.getElementById("loginGate").classList.remove("open");
    document.getElementById("appRoot").style.display = "";
    applyRolePermissions();
    startLoad().then(function () {
      document.getElementById("loadingState").style.display = "none";
      refresh();
      afterLoad();
    });
  }

  // Runs once the data is on screen: settings for admins, first save (which also carries an older
  // single-blob database over to the new layout), and the background check for other people's changes.
  function afterLoad() {
    var p = isAdmin() ? loadSettings() : Promise.resolve();
    p.then(function () {
      if (isAdmin() && FIREBASE_DB_URL) saveCloud();
      startPolling();
      renderAttention();
    });
  }

  // ----- Firebase Authentication (email + password) over its REST API -----
  var AUTH_KEY = "contract-tracker:auth";
  var authState = { idToken: null, expiresAt: 0, refreshToken: null, email: "" };

  function authError(kind, code) {
    var e = new Error(code || kind);
    e.kind = kind;
    e.code = code || "";
    return e;
  }

  function decodeJwt(token) {
    try {
      var p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      while (p.length % 4) p += "=";
      return JSON.parse(atob(p));
    } catch (e) { return null; }
  }

  function applyTokenResponse(data) {
    authState.idToken = data.idToken || data.id_token;
    authState.refreshToken = data.refreshToken || data.refresh_token || authState.refreshToken;
    authState.expiresAt = Date.now() + (parseInt(data.expiresIn || data.expires_in, 10) || 3600) * 1000;
    var claims = decodeJwt(authState.idToken);
    if (claims && claims.email) authState.email = claims.email;
    else if (data.email) authState.email = data.email;
    try {
      window.localStorage.setItem(AUTH_KEY, JSON.stringify({ refreshToken: authState.refreshToken, email: authState.email }));
    } catch (e) { /* ignore */ }
  }

  function authFetch(url, options) {
    return fetchWithTimeout(url, options, 10000).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var msg = (data && data.error && (data.error.message || data.error)) || ("HTTP " + res.status);
          throw authError("auth", String(msg));
        }
        return data;
      });
    }, function () { throw authError("network", "NETWORK"); });
  }

  function signInWithPassword(email, password) {
    return authFetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + encodeURIComponent(FIREBASE_API_KEY), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, password: password, returnSecureToken: true })
    }).then(applyTokenResponse);
  }

  function refreshIdToken() {
    if (!authState.refreshToken) return Promise.reject(authError("auth", "NO_REFRESH_TOKEN"));
    return authFetch("https://securetoken.googleapis.com/v1/token?key=" + encodeURIComponent(FIREBASE_API_KEY), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(authState.refreshToken)
    }).then(applyTokenResponse);
  }

  function getIdToken() {
    if (authState.idToken && Date.now() < authState.expiresAt - 120000) return Promise.resolve(authState.idToken);
    return refreshIdToken().then(function () { return authState.idToken; });
  }

  // Which role the page shows. This only decides which buttons appear: the database rules
  // are what actually stop a non-admin from writing.
  function roleForEmail(email) {
    return (email && ADMIN_EMAILS.indexOf(String(email).toLowerCase()) !== -1) ? "admin" : "viewer";
  }

  function loginMessage(err) {
    var c = (err && err.code) || "";
    if (err && err.kind === "network") return "Couldn't reach the sign-in service. Check your internet connection and try again.";
    if (/INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND|INVALID_EMAIL/.test(c)) return "Incorrect email or password.";
    if (/TOO_MANY_ATTEMPTS/.test(c)) return "Too many attempts. Wait a few minutes and try again.";
    if (/USER_DISABLED/.test(c)) return "This account has been disabled.";
    if (/OPERATION_NOT_ALLOWED|PASSWORD_LOGIN_DISABLED/.test(c)) return "Email/password sign-in isn't turned on in Firebase yet.";
    if (/API.?KEY/i.test(c)) return "The Firebase API key in this page isn't valid.";
    return "Couldn't sign in (" + c + ").";
  }

  var loginError = document.getElementById("loginError");
  var loginPassword = document.getElementById("loginPassword");
  var loginEmail = document.getElementById("loginEmail");
  var loginBtn = document.getElementById("loginSubmitBtn");
  var loginBusy = false;

  function showLoginError(msg) {
    loginError.textContent = msg;
    loginError.style.display = "block";
  }

  function attemptLogin() {
    if (AUTH_ENABLED) {
      var email = loginEmail.value.trim();
      var secret = loginPassword.value;
      if (!email || !secret) { showLoginError("Enter your email and password."); return; }
      if (loginBusy) return;
      loginBusy = true;
      loginBtn.disabled = true;
      loginBtn.textContent = "Signing in\u2026";
      signInWithPassword(email, secret).then(function () {
        loginPassword.value = "";
        loginError.style.display = "none";
        setRole(roleForEmail(authState.email));
      }).catch(function (err) {
        showLoginError(loginMessage(err));
        loginPassword.value = "";
        loginPassword.focus();
      }).then(function () {
        loginBusy = false;
        loginBtn.disabled = false;
        loginBtn.textContent = "Sign in";
      });
      return;
    }

    // No Firebase sign-in configured: simple local-only gate.
    var pw = loginPassword.value;
    if (pw === LOCAL_PASSWORDS.admin) { setRole("admin"); return; }
    if (pw === LOCAL_PASSWORDS.viewer) { setRole("viewer"); return; }
    showLoginError("Incorrect password.");
    loginPassword.value = "";
    loginPassword.focus();
  }

  loginBtn.addEventListener("click", attemptLogin);
  loginPassword.addEventListener("keydown", function (e) { if (e.key === "Enter") attemptLogin(); });
  loginEmail.addEventListener("keydown", function (e) { if (e.key === "Enter") attemptLogin(); });

  document.getElementById("signOutBtn").addEventListener("click", function () {
    try {
      window.localStorage.removeItem(ROLE_KEY);
      if (AUTH_ENABLED) {
        // don't leave the employee data or the sign-in on this device after signing out
        window.localStorage.removeItem(AUTH_KEY);
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch (e) { /* ignore */ }
    window.location.reload();
  });

  if (AUTH_ENABLED) {
    document.getElementById("loginEmailWrap").style.display = "";
    document.getElementById("loginSub").textContent = "Employees Contract Tracker \u2014 sign in with your email and password.";
    loginPassword.setAttribute("autocomplete", "current-password");
    loginEmail.focus();
  } else {
    loginPassword.focus();
  }

  var dropzone = document.getElementById("dropzone");
  var fileInput = document.getElementById("fileInput");
  var fileError = document.getElementById("fileError");
  var fileWarning = document.getElementById("fileWarning");
  var dataView = document.getElementById("dataView");
  var tableBody = document.getElementById("tableBody");
  var resultCount = document.getElementById("resultCount");

  // ---------- persistence ----------
  // The browser always keeps a local copy (so the app works offline). When a Firebase database is
  // configured, every employee is its own record under /employees, so two people editing different
  // employees never overwrite each other. /meta/updatedAt is a tiny stamp every device checks about
  // once a minute, /log is an append-only activity log and /settings holds the reminder settings.

  var LOG_KEY = "contract-tracker:log";
  var lastSaved = {};          // employee id -> signature of what the cloud is known to hold
  var lastImportSaved = "null";
  var settingsSaved = "";
  var lastSeenStamp = null;
  var pendingLogs = [];
  var writeChain = Promise.resolve();
  var pollTimer = null;

  function hashStr(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
    return String(h) + ":" + s.length;
  }

  // Canonical form: key order, nulls and empty containers don't matter (the database drops them too).
  function canon(v) {
    if (Array.isArray(v)) {
      var a = v.map(canon).filter(function (x) { return x !== undefined; });
      return a.length ? a : undefined;
    }
    if (v && typeof v === "object") {
      var o = {};
      Object.keys(v).sort().forEach(function (k) {
        var c = canon(v[k]);
        if (c !== undefined) o[k] = c;
      });
      return Object.keys(o).length ? o : undefined;
    }
    if (v === null || v === undefined || v === "") return undefined;
    return v;
  }
  function sigOf(v) { return hashStr(JSON.stringify(canon(v)) || "null"); }

  // Firebase keys may not contain . $ # [ ] / or control characters.
  function dbKey(id) {
    return String(id).replace(/[.$#\[\]\/%\x00-\x1f]/g, function (c) {
      return "%" + ("0" + c.charCodeAt(0).toString(16).toUpperCase()).slice(-2);
    });
  }

  function arrayFrom(v) {
    if (Array.isArray(v)) return v.filter(function (x) { return x != null; });
    if (v && typeof v === "object") {
      return Object.keys(v).sort(function (a, b) { return Number(a) - Number(b); }).map(function (k) { return v[k]; });
    }
    return [];
  }

  function defaultSettings() {
    return { notify: { enabled: true, emails: [], thresholds: [60, 30, 14], weekly: true, appUrl: "" } };
  }

  function normalizeSettings(s) {
    var d = defaultSettings();
    var n = (s && s.notify) || {};
    var thresholds = arrayFrom(n.thresholds).map(Number).filter(function (x) { return x > 0 && x <= 365; });
    return {
      notify: {
        enabled: n.enabled !== false,
        emails: arrayFrom(n.emails).map(String),
        thresholds: thresholds.length ? thresholds : d.notify.thresholds,
        weekly: n.weekly !== false,
        appUrl: n.appUrl ? String(n.appUrl) : ""
      }
    };
  }

  function normalizeEmployee(e) {
    e.contracts = arrayFrom(e.contracts);
    e.contracts.forEach(function (c) {
      if (c.startDate === undefined) c.startDate = null;
      if (c.endDate === undefined) c.endDate = null;
      if (c.durationMonths === undefined) c.durationMonths = null;
    });
    e.payrollNo = e.payrollNo || "";
    e.department = e.department || "";
    e.designation = e.designation || "";
    e.active = e.active !== false;
    return e;
  }

  state.settings = defaultSettings();

  function currentUserLabel() {
    return authState.email || (currentRole === "admin" ? "admin" : (currentRole || "unknown"));
  }

  function syncStatus(s) {
    var el = document.getElementById("syncStatus");
    if (!el) return;
    var map = {
      "not-configured": "Saved in this browser only",
      "checking": "Checking cloud\u2026",
      "syncing": "Syncing\u2026",
      "synced": "Synced to cloud",
      "offline": "Offline \u2014 will sync when back online",
      "denied": "Not saved to cloud \u2014 this account is read-only",
      "local-only": "Saved in this browser only"
    };
    el.textContent = map[s] || "";
    el.className = s === "synced" ? "synced" : ((s === "offline" || s === "denied") ? "offline" : "");
  }

  function fetchWithTimeout(url, options, ms) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ms || 8000);
    var opts = Object.assign({}, options, { signal: controller.signal });
    return fetch(url, opts).finally(function () { clearTimeout(timer); });
  }

  // One place that talks to the database. With sign-in on, every request carries the person's
  // Firebase ID token; a rejected token is refreshed once and the request retried.
  function cloudRequest(method, path, body, query) {
    var base = FIREBASE_DB_URL.replace(/\/$/, "");
    function send(token) {
      var params = [];
      if (token) params.push("auth=" + encodeURIComponent(token));
      if (query) params.push(query);
      var url = base + "/" + path + ".json" + (params.length ? "?" + params.join("&") : "");
      var opts = { method: method };
      if (body !== undefined) {
        opts.headers = { "Content-Type": "application/json" };
        opts.body = typeof body === "string" ? body : JSON.stringify(body);
      }
      return fetchWithTimeout(url, opts, 20000);
    }
    if (!AUTH_ENABLED) return send(null);
    return getIdToken().then(send).then(function (res) {
      if (res.status !== 401) return res;
      authState.expiresAt = 0;
      return getIdToken().then(send);
    });
  }

  function saveLocal() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        employees: state.employees,
        lastImport: state.lastImport,
        settings: state.settings,
        baseline: lastSaved,
        lastImportSaved: lastImportSaved
      }));
    } catch (e) { /* storage unavailable */ }
  }

  function unsyncedEmployees() {
    return state.employees.filter(function (e) { return lastSaved[e.id] !== sigOf(e); });
  }

  // ----- activity log -----
  function readLocalLog() {
    try { return JSON.parse(window.localStorage.getItem(LOG_KEY) || "[]"); } catch (e) { return []; }
  }
  function appendLocalLog(entry) {
    try {
      var list = readLocalLog();
      list.push(entry);
      window.localStorage.setItem(LOG_KEY, JSON.stringify(list.slice(-500)));
    } catch (e) { /* ignore */ }
  }
  function logAction(action, emp, detail) {
    var entry = {
      at: new Date().toISOString(),
      by: currentUserLabel(),
      action: action,
      employeeId: emp ? emp.id : null,
      name: emp ? emp.name : null,
      detail: detail || ""
    };
    if (FIREBASE_DB_URL) pendingLogs.push(entry); else appendLocalLog(entry);
  }
  function loadLog() {
    if (!FIREBASE_DB_URL) return Promise.resolve(readLocalLog().slice().reverse());
    return cloudRequest("GET", "log", undefined, "orderBy=%22%24key%22&limitToLast=300").then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (map) {
      return Object.keys(map || {}).sort().reverse().map(function (k) { return map[k]; });
    });
  }

  // ----- saving -----
  function saveState(opts) {
    saveLocal();
    return saveCloud(opts && opts.replaceAll);
  }

  function saveCloud(replaceAll) {
    if (!FIREBASE_DB_URL) { syncStatus("local-only"); return Promise.resolve(); }
    var run = function () { return doSaveCloud(replaceAll); };
    writeChain = writeChain.then(run, run);
    return writeChain;
  }

  function doSaveCloud(replaceAll) {
    if (!isAdmin()) return Promise.resolve();
    var changed = replaceAll ? state.employees.slice() : unsyncedEmployees();
    var importSig = sigOf(state.lastImport);
    var importChanged = importSig !== lastImportSaved;
    var settingsNow = sigOf(state.settings);
    var settingsChanged = settingsSaved !== "" && settingsNow !== settingsSaved;
    var logsLeft = pendingLogs.splice(0);
    if (!replaceAll && !changed.length && !importChanged && !settingsChanged && !logsLeft.length) return Promise.resolve();

    syncStatus("syncing");
    var map = {};
    changed.forEach(function (e) { map[dbKey(e.id)] = e; });
    var anyData = replaceAll || changed.length > 0 || importChanged || settingsChanged;

    function ok(res) {
      if (!res.ok) { var err = new Error("HTTP " + res.status); err.status = res.status; throw err; }
      return res;
    }
    var p = Promise.resolve();
    if (replaceAll || changed.length) p = p.then(function () { return cloudRequest(replaceAll ? "PUT" : "PATCH", "employees", map).then(ok); });
    if (importChanged) p = p.then(function () { return cloudRequest("PUT", "meta/lastImport", state.lastImport).then(ok); });
    if (settingsChanged) p = p.then(function () { return cloudRequest("PUT", "settings", state.settings).then(ok); });
    if (anyData) p = p.then(function () { return cloudRequest("PUT", "meta/updatedAt", { ".sv": "timestamp" }).then(ok); });
    p = p.then(function () {
      changed.forEach(function (e) { lastSaved[e.id] = sigOf(e); });
      if (replaceAll) {
        Object.keys(lastSaved).forEach(function (id) {
          if (!state.employees.some(function (e) { return e.id === id; })) delete lastSaved[id];
        });
      }
      lastImportSaved = importSig;
      if (settingsChanged) settingsSaved = settingsNow;
    });
    // log entries are posted one at a time so a failure part-way neither duplicates nor loses them
    function postNext() {
      if (!logsLeft.length) return Promise.resolve();
      return cloudRequest("POST", "log", logsLeft[0]).then(ok).then(function () { logsLeft.shift(); return postNext(); });
    }
    p = p.then(postNext);
    return p.then(function () {
      // Another device may have saved between our write and now, so don't claim to be up to date:
      // the next check re-reads the data (keeping anything this device hasn't saved yet).
      if (anyData) lastSeenStamp = null;
      saveLocal();
    }).then(function () {
      syncStatus("synced");
    }, function (err) {
      pendingLogs = logsLeft.concat(pendingLogs);
      saveLocal();
      syncStatus(err && (err.status === 401 || err.status === 403) ? "denied" : "offline");
    });
  }

  // ----- loading -----
  function loadLocal() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        var list = parsed ? arrayFrom(parsed.employees) : [];
        if (list.length) {
          state.employees = list.map(normalizeEmployee);
          state.lastImport = parsed.lastImport || null;
          if (parsed.settings) state.settings = normalizeSettings(parsed.settings);
          lastSaved = parsed.baseline || {};
          lastImportSaved = parsed.lastImportSaved != null ? parsed.lastImportSaved : "null";
          return true;
        }
        return false;
      }
      // migrate legacy v1 flat-row format if present
      var legacyRaw = window.localStorage.getItem(LEGACY_KEY);
      if (legacyRaw) {
        var legacy = JSON.parse(legacyRaw);
        if (legacy && Array.isArray(legacy.rows) && legacy.rows.length) {
          state.employees = legacy.rows.map(function (r) {
            return normalizeEmployee({
              id: makeId(r.payrollNo, r.name),
              payrollNo: r.payrollNo || "",
              name: r.name,
              department: r.department || "",
              designation: r.designation || "",
              active: true,
              resignedAt: null,
              contracts: [{
                startDate: r.startDate || null,
                endDate: r.endDate || null,
                source: "import",
                addedAt: legacy.importedAt || new Date().toISOString()
              }]
            });
          });
          state.lastImport = legacy.sourceName ? { fileName: legacy.sourceName, importedAt: legacy.importedAt } : null;
          lastSaved = {};
          saveLocal();
          return true;
        }
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  function adoptRemote(map) {
    var keys = Object.keys(map || {});
    // signatures of what the cloud holds, taken before any local tidy-up (such as assigning contract ids)
    var sigs = keys.map(function (k) { return sigOf(map[k]); });
    state.employees = keys.map(function (k) { return normalizeEmployee(map[k]); });
    state.employees.forEach(ensureContractIds);
    lastSaved = {};
    keys.forEach(function (k, i) { lastSaved[state.employees[i].id] = sigs[i]; });
  }

  function loadMeta(migrated) {
    return cloudRequest("GET", "meta").then(function (r) { return r.ok ? r.json() : null; }).then(function (meta) {
      if (meta) {
        lastSeenStamp = meta.updatedAt != null ? meta.updatedAt : null;
        if (!migrated) {
          state.lastImport = meta.lastImport || null;
          lastImportSaved = sigOf(state.lastImport);
        }
      } else if (!migrated) {
        lastImportSaved = sigOf(state.lastImport);
      }
    }).catch(function () { /* meta is optional */ });
  }

  function loadState() {
    if (!FIREBASE_DB_URL) {
      syncStatus("not-configured");
      return Promise.resolve(loadLocal());
    }
    syncStatus("checking");
    return cloudRequest("GET", "employees")
      .then(function (r) { if (!r.ok) throw new Error("bad response " + r.status); return r.json(); })
      .then(function (map) {
        if (map && Object.keys(map).length) {
          adoptRemote(map);
          return loadMeta(false).then(function () { saveLocal(); syncStatus("synced"); return true; });
        }
        // Nothing under /employees yet. Look for the older single-blob format and carry it over.
        return cloudRequest("GET", "data").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
          .then(function (legacy) {
            var list = legacy ? arrayFrom(legacy.employees) : [];
            if (list.length) {
              state.employees = list.map(normalizeEmployee);
              state.employees.forEach(ensureContractIds);
              state.lastImport = legacy.lastImport || null;
              lastSaved = {};
              lastImportSaved = "null";
              return loadMeta(true).then(function () { saveLocal(); syncStatus("synced"); return true; });
            }
            var had = loadLocal();      // cloud is empty: use this device's copy; the admin's first save seeds the cloud
            if (!had) lastSaved = {};
            return loadMeta(had).then(function () { syncStatus("synced"); return had; });
          });
      })
      .catch(function () {
        syncStatus("offline");
        return loadLocal();
      });
  }

  function loadSettings() {
    if (!FIREBASE_DB_URL || !isAdmin()) { settingsSaved = sigOf(state.settings); return Promise.resolve(); }
    return cloudRequest("GET", "settings").then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
      if (s) state.settings = normalizeSettings(s);
      settingsSaved = sigOf(state.settings);
      saveLocal();
    }).catch(function () { settingsSaved = sigOf(state.settings); });
  }

  // ----- keeping several devices in step -----
  function refreshFromCloud(stamp) {
    return cloudRequest("GET", "employees").then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (map) {
      var remote = Object.keys(map || {}).map(function (k) {
        var sig = sigOf(map[k]);
        return { sig: sig, emp: normalizeEmployee(map[k]) };
      });
      var remoteIds = {};
      var localById = {};
      state.employees.forEach(function (e) { localById[e.id] = e; });
      var merged = [];
      remote.forEach(function (r) {
        remoteIds[r.emp.id] = true;
        var l = localById[r.emp.id];
        if (l && lastSaved[l.id] !== sigOf(l)) { merged.push(l); }          // keep this device's unsaved edit
        else { ensureContractIds(r.emp); merged.push(r.emp); lastSaved[r.emp.id] = r.sig; }
      });
      state.employees.forEach(function (l) {
        if (remoteIds[l.id]) return;
        if (lastSaved[l.id] !== sigOf(l)) merged.push(l);                    // new here, not saved yet
        else delete lastSaved[l.id];                                         // removed elsewhere (e.g. a restore)
      });
      state.employees = merged;
      lastSeenStamp = stamp;
      saveLocal();
      if (historyTargetEmp) {
        var again = state.employees.filter(function (e) { return e.id === historyTargetEmp.id; })[0] || null;
        historyTargetEmp = again;
        if (again && historyBackdrop.classList.contains("open")) openHistory(again);
      }
      refresh();
      return loadSettings();
    });
  }

  function pollOnce() {
    if (!FIREBASE_DB_URL || !currentRole) return Promise.resolve();
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return Promise.resolve();
    if (isAdmin() && (unsyncedEmployees().length || pendingLogs.length)) saveCloud();   // retry anything that didn't reach the cloud
    return cloudRequest("GET", "meta/updatedAt").then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (stamp) {
      if (stamp != null && stamp !== lastSeenStamp) return refreshFromCloud(stamp);
    }).catch(function () { /* offline: try again next time */ });
  }

  function startPolling() {
    if (!FIREBASE_DB_URL || pollTimer) return;
    pollTimer = setInterval(pollOnce, 60000);
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") pollOnce(); });
    window.addEventListener("online", pollOnce);
  }
  window.__contractTracker = {
    poll: pollOnce,
    // Read-only list used by the Attendance tab to match biometric IDs to payroll numbers.
    employees: function () { return state.employees.map(function (e) { return { payrollNo: e.payrollNo, name: e.name, department: e.department }; }); }
  };

  function makeId(payrollNo, name) {
    if (payrollNo != null && String(payrollNo).trim() !== "") return "p:" + String(payrollNo).trim();
    return "n:" + String(name || "").trim().toLowerCase();
  }

  // ---------- excel parsing ----------

  // Headings are compared ignoring capitals, extra spaces and punctuation, and a few common
  // alternative names are accepted (for example "Name", "Contract End Date", "Expiry Date").
  function normalizeHeader(h) {
    return String(h == null ? "" : h).toLowerCase()
      .replace(/[\u00a0\s]+/g, " ").replace(/[.:#*_\-\/()]+/g, " ").replace(/\s+/g, " ").trim();
  }

  var HEADER_SYNONYMS = {
    payrollNo: ["payroll no", "payroll number", "payroll", "pay roll no", "payroll nos", "staff no", "staff number", "employee no", "employee number", "emp no", "pf no"],
    name: ["employee name", "employee names", "name", "names", "employee", "full name", "full names", "staff name", "name of employee", "names of employee", "emp name"],
    department: ["department", "dept", "department name", "section", "division"],
    designation: ["designation", "job title", "position", "title", "job designation", "role"],
    startDate: ["start date", "contract start", "contract start date", "date started", "commencement date", "date of commencement", "start", "engagement date", "date of engagement"],
    durationMonths: ["duration months", "duration", "contract duration", "months"],
    endDate: ["end date", "contract end", "contract end date", "expiry date", "expiry", "date of expiry", "end", "contract expiry", "contract expiry date", "contract expires", "end of contract"]
  };
  var HEADER_LOOKUP = {};
  Object.keys(HEADER_SYNONYMS).forEach(function (k) { HEADER_SYNONYMS[k].forEach(function (s) { HEADER_LOOKUP[s] = k; }); });
  function headerKey(h) { return HEADER_LOOKUP[normalizeHeader(h)] || null; }

  // Columns a sheet must have before we'll import rows from it. Duration is
  // left out since the Period feature can work from start/end dates alone.
  var MANDATORY_COLUMNS = [
    { key: "payrollNo", label: "Payroll No." },
    { key: "name", label: "Employee Name" },
    { key: "department", label: "Department" },
    { key: "designation", label: "Designation" },
    { key: "startDate", label: "Start Date" },
    { key: "endDate", label: "End Date" }
  ];

  function excelDateToJS(v) {
    if (v instanceof Date) return v;
    if (typeof v === "number") {
      var parsed = XLSX.SSF.parse_date_code(v);
      if (!parsed) return null;
      return new Date(parsed.y, parsed.m - 1, parsed.d);
    }
    if (typeof v === "string" && v.trim()) {
      var d = new Date(v);
      if (!isNaN(d.getTime())) return d;
    }
    return null;
  }

  function findHeaderRow(sheetRows) {
    var limit = Math.min(sheetRows.length, 100);
    for (var i = 0; i < limit; i++) {
      var row = sheetRows[i] || [];
      var hasName = false, hasEnd = false;
      for (var j = 0; j < row.length; j++) {
        var k = headerKey(row[j]);
        if (k === "name") hasName = true;
        if (k === "endDate") hasEnd = true;
      }
      if (hasName && hasEnd) return i;
    }
    return -1;
  }

  // For the error message: the headings of the row that looks most like a heading row.
  function describeSheetHeadings(sheetRows) {
    var best = -1, bestScore = -1;
    for (var i = 0; i < Math.min(sheetRows.length, 30); i++) {
      var row = sheetRows[i] || [];
      var seen = {}, filled = 0;
      row.forEach(function (c) { if (c != null && String(c).trim() !== "") { filled++; var k = headerKey(c); if (k) seen[k] = true; } });
      var score = Object.keys(seen).length * 100 + (filled > 1 ? 1 : 0);
      if (filled && score > bestScore) { best = i; bestScore = score; }
    }
    if (best < 0) return "(the sheet is empty)";
    var cells = (sheetRows[best] || []).filter(function (c) { return c != null && String(c).trim() !== ""; })
      .slice(0, 10).map(function (c) { var s = String(c).trim(); return "\u201c" + (s.length > 24 ? s.slice(0, 24) + "\u2026" : s) + "\u201d"; });
    return "row " + (best + 1) + " reads " + cells.join(", ");
  }

  function parseWorkbook(wb) {
    var byKey = {};
    var order = [];
    var warnings = []; // sheets that looked like a contract register but were missing mandatory columns
    var candidateSheetCount = 0;
    var sheetNotes = [];

    wb.SheetNames.forEach(function (sheetName) {
      var ws = wb.Sheets[sheetName];
      var rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
      var headerIdx = findHeaderRow(rows);
      if (headerIdx === -1) {   // doesn't look like a contract register: remember what it does contain, for the message
        sheetNotes.push({ sheet: sheetName, note: describeSheetHeadings(rows) });
        return;
      }

      candidateSheetCount++;

      var headerRow = rows[headerIdx];
      var colIndex = {};
      headerRow.forEach(function (h, idx) {
        var key = headerKey(h);
        if (key && colIndex[key] == null) colIndex[key] = idx;
      });

      var missing = MANDATORY_COLUMNS.filter(function (c) { return colIndex[c.key] == null; }).map(function (c) { return c.label; });
      if (missing.length) {
        warnings.push({ sheet: sheetName, missing: missing });
        return; // don't import partial/malformed rows from this sheet
      }

      for (var r = headerIdx + 1; r < rows.length; r++) {
        var row = rows[r];
        if (!row) continue;
        var name = row[colIndex.name];
        if (name == null || String(name).trim() === "") continue;

        var payrollNo = colIndex.payrollNo != null ? row[colIndex.payrollNo] : null;
        var department = colIndex.department != null ? row[colIndex.department] : null;
        var designation = colIndex.designation != null ? row[colIndex.designation] : null;
        var startDate = colIndex.startDate != null ? excelDateToJS(row[colIndex.startDate]) : null;
        var endDate = colIndex.endDate != null ? excelDateToJS(row[colIndex.endDate]) : null;
        var durationRaw = colIndex.durationMonths != null ? row[colIndex.durationMonths] : null;
        var durationMonths = (durationRaw != null && durationRaw !== "" && !isNaN(Number(durationRaw))) ? Number(durationRaw) : null;

        var key = makeId(payrollNo, name) + "|" + (startDate ? startDate.toISOString() : "") + "|" + (endDate ? endDate.toISOString() : "");
        var entry = {
          payrollNo: payrollNo != null ? String(payrollNo).trim() : "",
          name: String(name).trim(),
          department: department != null ? String(department).trim() : "",
          designation: designation != null ? String(designation).trim() : "",
          startDate: startDate ? startDate.toISOString() : null,
          endDate: endDate ? endDate.toISOString() : null,
          durationMonths: durationMonths
        };

        if (!(key in byKey)) order.push(key);
        byKey[key] = entry;
      }
    });

    return {
      entries: order.map(function (k) { return byKey[k]; }),
      warnings: warnings,
      candidateSheetCount: candidateSheetCount,
      sheetNotes: sheetNotes
    };
  }

  // ---------- upsert (import + manual share this) ----------

  // "KENNEDY MAWANDA  Mwangi", "Mwangi, Kennedy Mawanda" and "kennedy mawanda mwangi" all give the same key.
  function nameKey(name) {
    return String(name || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean).sort().join(" ");
  }

  // Returns { emp, by } where by is "payroll" (payroll number matched) or "name" (matched on the name only).
  function findEmployeeMatch(payrollNo, name) {
    var pn = payrollNo != null ? String(payrollNo).trim() : "";
    var list = state.employees;
    var i;
    if (pn) {
      for (i = 0; i < list.length; i++) {
        if (list[i].payrollNo === pn || list[i].id === "p:" + pn) return { emp: list[i], by: "payroll" };
      }
    }
    var nk = nameKey(name);
    if (nk) {
      for (i = 0; i < list.length; i++) {
        if (nameKey(list[i].name) !== nk) continue;
        // the same name with a different payroll number is a different person
        if (pn && list[i].payrollNo && list[i].payrollNo !== pn) continue;
        return { emp: list[i], by: "name" };
      }
    }
    return null;
  }

  function findEmployee(payrollNo, name) {
    var m = findEmployeeMatch(payrollNo, name);
    return m ? m.emp : null;
  }

  function sameContract(a, b) {
    return (a.startDate || null) === (b.startDate || null) && (a.endDate || null) === (b.endDate || null);
  }

  function generateContractId() {
    return "c:" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // Older saved records have no contract ids; give each one a stable id so it can be targeted.
  function ensureContractIds(emp) {
    var changed = false;
    (emp.contracts || []).forEach(function (c) {
      if (!c.id) { c.id = generateContractId(); changed = true; }
    });
    return changed;
  }

  function isPlaceholder(c) {
    return !c.deleted && c.startDate === null && c.endDate === null && c.source === "import";
  }

  function upsertContract(entry, source) {
    var m = findEmployeeMatch(entry.payrollNo, entry.name);
    var emp = m ? m.emp : null;
    var now = new Date().toISOString();
    var by = currentUserLabel();
    var added = false, reactivated = false, restored = false, created = false;

    if (!emp) {
      emp = {
        id: makeId(entry.payrollNo, entry.name),
        payrollNo: entry.payrollNo || "",
        name: entry.name,
        department: entry.department || "",
        designation: entry.designation || "",
        active: true,
        resignedAt: null,
        contracts: []
      };
      state.employees.push(emp);
      created = true;
    }

    var mf = emp.manualFields || {};
    if (entry.department && !mf.department) emp.department = entry.department;
    if (entry.designation && !mf.designation) emp.designation = entry.designation;
    if (entry.payrollNo) emp.payrollNo = entry.payrollNo;

    var hasDates = !!(entry.startDate || entry.endDate);
    var live = emp.contracts.filter(function (c) { return !c.deleted; });
    var existing = emp.contracts.filter(function (c) { return sameContract(c, entry); })[0];

    if (existing) {
      if (existing.deleted && source === "manual") {
        existing.deleted = false;
        delete existing.deletedAt;
        delete existing.deletedBy;
        added = true;
        restored = true;
      }
    } else if (!hasDates && live.length) {
      // a row with no dates adds nothing when the employee already has contract periods
    } else {
      if (hasDates) {
        // a dated period replaces an earlier "no dates yet" placeholder from an import
        emp.contracts = emp.contracts.filter(function (c) { return !isPlaceholder(c); });
      }
      var c = {
        id: generateContractId(),
        startDate: entry.startDate || null,
        endDate: entry.endDate || null,
        durationMonths: (entry.durationMonths != null && !isNaN(entry.durationMonths)) ? entry.durationMonths : null,
        source: source,
        addedAt: now,
        addedBy: by
      };
      if (entry.docUrl) c.docUrl = entry.docUrl;
      emp.contracts.push(c);
      added = true;
    }

    if (added && !emp.active) {
      emp.active = true;
      emp.resignedAt = null;
      emp.resignReason = "";
      reactivated = true;
    }

    return { added: added, reactivated: reactivated, restored: restored, created: created, matchedBy: m ? m.by : "new", emp: emp };
  }

  // ---------- derived data ----------

  // Contracts that were deleted stay in the record (so they can be restored) but never count.
  function liveContracts(emp) {
    return (emp.contracts || []).filter(function (c) { return !c.deleted; });
  }

  var RENEWAL_STAGES = [
    { value: "none", label: "Not started" },
    { value: "inprogress", label: "In progress" },
    { value: "renewed", label: "Renewed" },
    { value: "notrenewing", label: "Not renewing" }
  ];
  function renewalLabel(v) {
    var s = RENEWAL_STAGES.filter(function (x) { return x.value === v; })[0];
    return s ? s.label : "Not started";
  }
  // A renewal stage belongs to one contract: once a newer contract is added it starts again at "Not started".
  function renewalStageFor(emp, current) {
    return (emp.renewal && current && emp.renewal.contractId === current.id && emp.renewal.stage) ? emp.renewal.stage : "none";
  }

  function getCurrentContract(emp) {
    var live = liveContracts(emp);
    if (!live.length) return null;
    var sorted = live.slice().sort(function (a, b) {
      var ta = a.startDate ? new Date(a.startDate).getTime() : -Infinity;
      var tb = b.startDate ? new Date(b.startDate).getTime() : -Infinity;
      if (tb !== ta) return tb - ta;
      var aa = a.addedAt ? new Date(a.addedAt).getTime() : 0;
      var ab = b.addedAt ? new Date(b.addedAt).getTime() : 0;
      return ab - aa;
    });
    return sorted[0];
  }

  function statusForContract(contract) {
    if (!contract || !contract.endDate) return "pending";
    var end = new Date(contract.endDate);
    end.setHours(0, 0, 0, 0);
    var days = Math.round((end.getTime() - todayStart.getTime()) / 86400000);
    if (days < 0) return "expired";
    if (days <= 30) return "critical";
    return "active";
  }

  function daysForContract(contract) {
    if (!contract || !contract.endDate) return null;
    var end = new Date(contract.endDate);
    end.setHours(0, 0, 0, 0);
    return Math.round((end.getTime() - todayStart.getTime()) / 86400000);
  }

  function addMonths(date, n) {
    var d = new Date(date.getTime());
    var day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    var lastDayOfTarget = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDayOfTarget));
    return d;
  }

  function periodLabel(contract) {
    if (!contract) return "\u2014";
    if (contract.durationMonths != null && !isNaN(contract.durationMonths)) {
      var n = contract.durationMonths;
      return n + " month" + (n === 1 ? "" : "s");
    }
    if (contract.startDate && contract.endDate) {
      var days = Math.round((new Date(contract.endDate).getTime() - new Date(contract.startDate).getTime()) / 86400000);
      if (days < 28) return days + " day" + (days === 1 ? "" : "s");
      var months = Math.round(days / 30.4368);
      return "~" + months + " month" + (months === 1 ? "" : "s");
    }
    return "\u2014";
  }

  function deriveRow(emp) {
    var current = getCurrentContract(emp);
    return {
      id: emp.id,
      payrollNo: emp.payrollNo,
      name: emp.name,
      department: emp.department,
      designation: emp.designation,
      active: emp.active,
      startDate: current ? current.startDate : null,
      endDate: current ? current.endDate : null,
      period: periodLabel(current),
      daysRemaining: daysForContract(current),
      status: statusForContract(current),
      contractCount: liveContracts(emp).length,
      renewal: renewalStageFor(emp, current)
    };
  }

  // ---------- rendering ----------

  function fmtDate(iso) {
    if (!iso) return "\u2014";
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function statusLabel(s) { return { expired: "Expired", critical: "Critical", active: "Active", pending: "Pending data" }[s] || s; }

  function daysLabel(row) {
    if (row.daysRemaining == null) return "\u2014";
    if (row.daysRemaining < 0) return Math.abs(row.daysRemaining) + "d overdue";
    if (row.daysRemaining === 0) return "Today";
    return row.daysRemaining + "d";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function populateDeptFilter(rows) {
    var sel = document.getElementById("deptFilter");
    var current = sel.value;
    var depts = Array.from(new Set(rows.map(function (r) { return r.department; }).filter(Boolean))).sort();
    sel.innerHTML = '<option value="">All departments</option>' +
      depts.map(function (d) { return '<option value="' + escapeHtml(d) + '">' + escapeHtml(d) + "</option>"; }).join("");
    if (depts.indexOf(current) !== -1) sel.value = current;
  }

  function getFilteredSorted() {
    var all = state.employees.map(deriveRow);
    var visible = state.showResigned ? all : all.filter(function (r) { return r.active; });
    var q = state.search.trim().toLowerCase();

    var filtered = visible.filter(function (r) {
      if (state.statusFilter && r.status !== state.statusFilter) return false;
      if (state.deptFilter && r.department !== state.deptFilter) return false;
      if (state.daysMin !== null || state.daysMax !== null) {
        if (r.daysRemaining == null) return false;                       // no end date, so no "days left"
        if (state.daysMin !== null && r.daysRemaining < state.daysMin) return false;
        if (state.daysMax !== null && r.daysRemaining > state.daysMax) return false;
      }
      if (q) {
        var hay = (r.name + " " + r.department + " " + r.designation + " " + r.payrollNo).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    filtered.sort(function (a, b) {
      var ka = a[state.sortKey], kb = b[state.sortKey];
      if (state.sortKey === "daysRemaining") {
        var va = ka == null ? Infinity : ka, vb = kb == null ? Infinity : kb;
        return (va - vb) * state.sortDir;
      }
      if (state.sortKey === "startDate" || state.sortKey === "endDate") {
        var da = ka ? new Date(ka).getTime() : -Infinity, db_ = kb ? new Date(kb).getTime() : -Infinity;
        return (da - db_) * state.sortDir;
      }
      var sa = (ka || "").toString().toLowerCase(), sb = (kb || "").toString().toLowerCase();
      if (sa < sb) return -1 * state.sortDir;
      if (sa > sb) return 1 * state.sortDir;
      return 0;
    });

    return { all: all, activeOnly: all.filter(function (r) { return r.active; }), filtered: filtered };
  }

  function render() {
    var res = getFilteredSorted();
    var activeOnly = res.activeOnly, filtered = res.filtered, all = res.all;

    var counts = { expired: 0, critical: 0, active: 0, pending: 0 };
    activeOnly.forEach(function (r) { counts[r.status]++; });
    document.getElementById("countExpired").textContent = counts.expired;
    document.getElementById("countCritical").textContent = counts.critical;
    document.getElementById("countActive").textContent = counts.active;
    document.getElementById("countPending").textContent = counts.pending;
    document.getElementById("resignedCount").textContent = all.length - activeOnly.length;

    document.querySelectorAll(".stat").forEach(function (btn) {
      btn.classList.toggle("active-filter", btn.getAttribute("data-filter") === state.statusFilter);
    });

    populateDeptFilter(state.showResigned ? all : activeOnly);

    resultCount.textContent = filtered.length + " of " + (state.showResigned ? all.length : activeOnly.length) + " employee" + (activeOnly.length === 1 ? "" : "s") + " shown";

    if (!filtered.length) {
      tableBody.innerHTML = '<tr class="empty-row"><td colspan="12">No employees match these filters.</td></tr>';
    } else {
      tableBody.innerHTML = filtered.map(function (r) {
        var renewalCell = (isAdmin() && r.active)
          ? '<select class="renewal-select" data-id="' + escapeHtml(r.id) + '" aria-label="Renewal stage for ' + escapeHtml(r.name) + '">' +
              RENEWAL_STAGES.map(function (s) { return '<option value="' + s.value + '"' + (s.value === r.renewal ? " selected" : "") + ">" + s.label + "</option>"; }).join("") +
            "</select>"
          : (r.renewal === "none" ? "\u2014" : '<span class="pill renewal-' + r.renewal + '">' + escapeHtml(renewalLabel(r.renewal)) + "</span>");
        return '<tr class="' + (r.active ? "" : "resigned-row") + '" data-id="' + escapeHtml(r.id) + '">' +
          '<td class="num" data-label="Payroll No.">' + escapeHtml(r.payrollNo || "\u2014") + "</td>" +
          '<td class="name" data-label="Employee">' + escapeHtml(r.name) + "</td>" +
          '<td class="dept" data-label="Department">' + escapeHtml(r.department || "\u2014") + "</td>" +
          '<td data-label="Designation">' + escapeHtml(r.designation || "\u2014") + "</td>" +
          '<td class="date" data-label="Start date">' + fmtDate(r.startDate) + "</td>" +
          '<td class="date" data-label="End date">' + fmtDate(r.endDate) + "</td>" +
          '<td class="dept" data-label="Period">' + escapeHtml(r.period) + "</td>" +
          '<td class="days" data-label="Days remaining">' + daysLabel(r) + "</td>" +
          '<td data-label="Status"><span class="pill ' + r.status + '">' + statusLabel(r.status) + "</span></td>" +
          '<td data-label="Renewal">' + renewalCell + "</td>" +
          '<td data-label="Employment"><span class="pill ' + (r.active ? "employed" : "resigned") + '">' + (r.active ? "Employed" : "Resigned") + "</span></td>" +
          '<td class="actions-cell">' +
            '<button class="link-btn" data-action="history" data-id="' + escapeHtml(r.id) + '">History (' + r.contractCount + ")</button>" +
            (isAdmin() ? '<button class="link-btn" data-action="renew" data-id="' + escapeHtml(r.id) + '">Renew</button>' : "") +
            (isAdmin() ? '<button class="link-btn ' + (r.active ? "warn" : "") + '" data-action="toggle-active" data-id="' + escapeHtml(r.id) + '">' + (r.active ? "Resign" : "Reactivate") + "</button>" : "") +
          "</td>" +
        "</tr>";
      }).join("");
    }

    renderAttention();

    document.querySelectorAll("thead th.sortable").forEach(function (th) {
      var key = th.getAttribute("data-key");
      th.classList.toggle("sorted", key === state.sortKey);
      if (key === state.sortKey) th.setAttribute("data-dir", state.sortDir === 1 ? "\u2191" : "\u2193");
    });
  }

  function showData() {
    dropzone.style.display = "none";
    dataView.style.display = "block";
    var when = state.lastImport && state.lastImport.importedAt ? new Date(state.lastImport.importedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
    document.getElementById("sourceLabel").textContent = state.lastImport
      ? "Last import: " + state.lastImport.fileName + (when ? " \u00b7 " + when : "")
      : "No workbook imported yet \u2014 employees added manually";
    render();
  }

  function showDropzone() {
    dropzone.style.display = "block";
    dataView.style.display = "none";
    var viewerNote = document.getElementById("viewerEmptyNote");
    if (viewerNote) viewerNote.style.display = isAdmin() ? "none" : "block";
  }

  function refresh() {
    if (state.employees.length) showData(); else showDropzone();
  }

  // ---------- file handling ----------

  function handleFile(file) {
    if (!isAdmin()) return;
    fileError.style.display = "none";
    fileWarning.style.display = "none";
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var data = new Uint8Array(e.target.result);
        var wb = XLSX.read(data, { type: "array", cellDates: false });
        var result = parseWorkbook(wb);

        if (result.candidateSheetCount === 0) {
          fileError.textContent = "Couldn't find the employee name and contract end date columns in this workbook.\n" +
            result.sheetNotes.map(function (n) { return "\u2022 Sheet \u201c" + n.sheet + "\u201d: " + n.note; }).join("\n") +
            "\n\nThe tracker looks (in the first 100 rows of each sheet) for a heading such as Employee Name or Name, and one such as End Date, Contract End Date or Expiry Date. " +
            "It also needs Payroll No., Department, Designation and Start Date. Rename the headings to match and try again.";
          fileError.style.display = "block";
          return;
        }

        if (!result.entries.length) {
          // every candidate sheet was missing at least one mandatory column
          var msg = "Found " + result.candidateSheetCount + " sheet" + (result.candidateSheetCount === 1 ? "" : "s") +
            " that looked like a contract register, but none had all the required columns:\n" +
            result.warnings.map(function (w) { return "\u2022 \u201c" + w.sheet + "\u201d is missing: " + w.missing.join(", "); }).join("\n") +
            "\n\nRequired columns: " + MANDATORY_COLUMNS.map(function (c) { return c.label; }).join(", ") + ". Nothing was imported.";
          fileError.textContent = msg;
          fileError.style.display = "block";
          return;
        }

        var newEmployees = 0, periodsAdded = 0, unchanged = 0, byName = 0;
        result.entries.forEach(function (entry) {
          var r = upsertContract(entry, "import");
          if (r.created) newEmployees++;
          if (r.added) periodsAdded++; else unchanged++;
          if (r.matchedBy === "name" && entry.payrollNo) byName++;
        });
        state.lastImport = { fileName: file.name, importedAt: new Date().toISOString() };
        logAction("import", null, file.name + ": " + result.entries.length + " rows read, " + newEmployees + " new employees, " + periodsAdded + " contract periods added");
        saveState();

        if (result.warnings.length) {
          fileWarning.textContent = "Imported successfully, but skipped " + result.warnings.length + " sheet" + (result.warnings.length === 1 ? "" : "s") + " missing required columns:\n" +
            result.warnings.map(function (w) { return "\u2022 \u201c" + w.sheet + "\u201d is missing: " + w.missing.join(", "); }).join("\n");
          fileWarning.style.display = "block";
        }

        refresh();
        showToast("Upload successful \u2014 \u201c" + file.name + "\u201d: " + result.entries.length + " employee record" + (result.entries.length === 1 ? "" : "s") +
          " read, " + newEmployees + " new, " + periodsAdded + " contract period" + (periodsAdded === 1 ? "" : "s") + " added, " + unchanged + " already up to date." +
          (byName ? " " + byName + " matched an existing employee by name because the payroll number was different or missing." : ""));
      } catch (err) {
        fileError.textContent = "Couldn't read that file. Make sure it's a valid .xlsx workbook.";
        fileError.style.display = "block";
      }
    };
    reader.onerror = function () {
      fileError.textContent = "Couldn't read that file. Please try again.";
      fileError.style.display = "block";
    };
    reader.readAsArrayBuffer(file);
  }

  document.getElementById("browseBtn").addEventListener("click", function () { fileInput.click(); });
  document.getElementById("importBtn").addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
    fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.add("drag-over"); });
  });
  ["dragleave", "drop"].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.remove("drag-over"); });
  });
  dropzone.addEventListener("drop", function (e) {
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  // ---------- filter / sort controls ----------

  document.getElementById("searchInput").addEventListener("input", function (e) { state.search = e.target.value; render(); });
  document.getElementById("deptFilter").addEventListener("change", function (e) { state.deptFilter = e.target.value; render(); });

  // Days-left filter: presets, or a custom range (blank = no limit; negative numbers mean already expired).
  var daysSel = document.getElementById("daysFilter");
  var daysFrom = document.getElementById("daysFrom");
  var daysTo = document.getElementById("daysTo");
  function intOrNull(v) { var n = parseInt(String(v).trim(), 10); return isNaN(n) ? null : n; }
  function applyDaysFilter() {
    var v = daysSel.value;
    document.getElementById("daysCustom").style.display = v === "custom" ? "inline-flex" : "none";
    if (!v) { state.daysMin = null; state.daysMax = null; }
    else if (v === "expired") { state.daysMin = null; state.daysMax = -1; }
    else if (v === "custom") { state.daysMin = intOrNull(daysFrom.value); state.daysMax = intOrNull(daysTo.value); }
    else { state.daysMin = 0; state.daysMax = parseInt(v, 10); }
    render();
  }
  function daysFilterLabel() {
    if (state.daysMin === null && state.daysMax === null) return "";
    if (state.daysMin === null) return state.daysMax === -1 ? "already expired" : "at most " + state.daysMax + " days left";
    if (state.daysMax === null) return "at least " + state.daysMin + " days left";
    return state.daysMin + " to " + state.daysMax + " days left";
  }
  daysSel.addEventListener("change", applyDaysFilter);
  daysFrom.addEventListener("input", applyDaysFilter);
  daysTo.addEventListener("input", applyDaysFilter);
  document.getElementById("showResignedToggle").addEventListener("change", function (e) { state.showResigned = e.target.checked; render(); });
  document.getElementById("clearFiltersBtn").addEventListener("click", function () {
    state.search = ""; state.deptFilter = ""; state.statusFilter = "";
    state.daysMin = null; state.daysMax = null;
    daysSel.value = ""; daysFrom.value = ""; daysTo.value = "";
    document.getElementById("daysCustom").style.display = "none";
    document.getElementById("searchInput").value = "";
    render();
  });
  document.querySelectorAll(".stat").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var f = btn.getAttribute("data-filter");
      state.statusFilter = state.statusFilter === f ? "" : f;
      render();
    });
  });
  document.querySelectorAll("thead th.sortable").forEach(function (th) {
    th.addEventListener("click", function () {
      var key = th.getAttribute("data-key");
      if (state.sortKey === key) state.sortDir *= -1; else { state.sortKey = key; state.sortDir = 1; }
      render();
    });
  });

  // ---------- export to Word ----------

  function exportContext() {
    var rows = getFilteredSorted().filtered;
    var counts = { expired: 0, critical: 0, active: 0, pending: 0 };
    rows.forEach(function (r) { counts[r.status]++; });
    var parts = [];
    if (state.statusFilter) parts.push("Status: " + statusLabel(state.statusFilter));
    if (state.deptFilter) parts.push("Department: " + state.deptFilter);
    if (daysFilterLabel()) parts.push("Period left: " + daysFilterLabel());
    if (state.search.trim()) parts.push('Search: "' + state.search.trim() + '"');
    parts.push(state.showResigned ? "Including resigned employees" : "Active employees only");
    return {
      rows: rows, counts: counts,
      filterDesc: parts.join(" \u00b7 "),
      generatedOn: new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    };
  }

  function exportToWord() {
    var x = exportContext();
    var rows = x.rows, counts = x.counts;
    var D = window.docx;
    var W = [1000, 2400, 1600, 1800, 1300, 1300, 1100, 1300, 1300];

    function cell(text, i, header) {
      return new D.TableCell({
        width: { size: W[i], type: D.WidthType.DXA },
        shading: header ? { type: D.ShadingType.CLEAR, fill: "16233F", color: "auto" } : undefined,
        margins: { top: 70, bottom: 70, left: 100, right: 100 },
        children: [new D.Paragraph({ children: [new D.TextRun({ text: String(text), bold: !!header, color: header ? "FFFFFF" : "1D2433", size: 16 })] })]
      });
    }

    var headerRow = new D.TableRow({
      tableHeader: true,
      children: ["Payroll No.", "Employee Name", "Department", "Designation", "Start Date", "End Date", "Period", "Days Remaining", "Status"]
        .map(function (t, i) { return cell(t, i, true); })
    });

    var dataRows = rows.map(function (r) {
      var vals = [r.payrollNo || "\u2014", r.name, r.department || "\u2014", r.designation || "\u2014",
        fmtDate(r.startDate), fmtDate(r.endDate), r.period, daysLabel(r), statusLabel(r.status)];
      return new D.TableRow({ children: vals.map(function (v, i) { return cell(v, i, false); }) });
    });
    if (!dataRows.length) {
      dataRows = [new D.TableRow({ children: [new D.TableCell({
        columnSpan: 9,
        children: [new D.Paragraph({ children: [new D.TextRun({ text: "No employees match the current filters.", italics: true, size: 16 })] })]
      })] })];
    }

    function stat(label, value, color, last) {
      return [new D.TextRun({ text: label + ": ", bold: true, size: 18 }),
              new D.TextRun({ text: String(value) + (last ? "" : "      "), size: 18, color: color })];
    }

    var doc = new D.Document({
      creator: COMPANY,
      title: REPORT_TITLE,
      sections: [{
        properties: { page: { size: { orientation: D.PageOrientation.LANDSCAPE }, margin: { top: 720, bottom: 720, left: 720, right: 720 } } },
        children: [
          new D.Paragraph({ spacing: { after: 60 }, children: [new D.TextRun({ text: REPORT_TITLE, bold: true, size: 34, color: "16233F" })] }),
          new D.Paragraph({ spacing: { after: 180 }, children: [new D.TextRun({ text: "Generated " + x.generatedOn + " \u00b7 " + x.filterDesc + " \u00b7 " + rows.length + " employee(s) shown", size: 18, color: "667085" })] }),
          new D.Paragraph({ spacing: { after: 240 }, children: []
            .concat(stat("Expired", counts.expired, "B3261E"))
            .concat(stat("Critical (under 30 days)", counts.critical, "B5650B"))
            .concat(stat("Active", counts.active, "276749"))
            .concat(stat("Pending data", counts.pending, "667085", true)) }),
          new D.Table({ width: { size: 14400, type: D.WidthType.DXA }, rows: [headerRow].concat(dataRows) })
        ]
      }]
    });

    D.Packer.toBlob(doc).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = COMPANY.replace(/\s+/g, "-") + "-Contract-Tracker-" + new Date().toISOString().slice(0, 10) + ".docx";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      showToast("Word document downloaded.");
    }).catch(function () {
      fileError.textContent = "Couldn't generate the Word document. Please try again.";
      fileError.style.display = "block";
    });
  }

  document.getElementById("exportWordBtn").addEventListener("click", exportToWord);

  // PDF: fills the print area with the same report, then opens the browser's print dialog
  // where "Save as PDF" is chosen as the destination.
  function exportToPDF() {
    var x = exportContext();
    var rows = x.rows, counts = x.counts;
    var rowsHtml = rows.map(function (r) {
      return "<tr>" +
        "<td>" + escapeHtml(r.payrollNo || "\u2014") + "</td>" +
        "<td>" + escapeHtml(r.name) + "</td>" +
        "<td>" + escapeHtml(r.department || "\u2014") + "</td>" +
        "<td>" + escapeHtml(r.designation || "\u2014") + "</td>" +
        "<td>" + fmtDate(r.startDate) + "</td>" +
        "<td>" + fmtDate(r.endDate) + "</td>" +
        "<td>" + escapeHtml(r.period) + "</td>" +
        "<td>" + escapeHtml(daysLabel(r)) + "</td>" +
        "<td>" + escapeHtml(statusLabel(r.status)) + "</td>" +
      "</tr>";
    }).join("");

    document.getElementById("printArea").innerHTML =
      "<h1>" + escapeHtml(REPORT_TITLE) + "</h1>" +
      "<h2>Generated " + x.generatedOn + "<br>" + escapeHtml(x.filterDesc) + " \u00b7 " + rows.length + " employee(s) shown</h2>" +
      "<table class='summary-line'><tr>" +
        "<td><b>Expired:</b> " + counts.expired + "</td>" +
        "<td><b>Critical (under 30 days):</b> " + counts.critical + "</td>" +
        "<td><b>Active:</b> " + counts.active + "</td>" +
        "<td><b>Pending data:</b> " + counts.pending + "</td>" +
      "</tr></table>" +
      "<table><thead><tr>" +
        "<th>Payroll No.</th><th>Employee Name</th><th>Department</th><th>Designation</th>" +
        "<th>Start Date</th><th>End Date</th><th>Period</th><th>Days Remaining</th><th>Status</th>" +
      "</tr></thead><tbody>" + (rowsHtml || "<tr><td colspan='9'>No employees match the current filters.</td></tr>") + "</tbody></table>" +
      "<div class='print-footer'>Printed " + x.generatedOn + "</div>";

    showToast("Print dialog opening \u2014 choose \u201cSave as PDF\u201d as the destination.", "info");
    setTimeout(function () { window.print(); }, 200);
  }

  document.getElementById("exportPdfBtn").addEventListener("click", exportToPDF);

  // ---------- row actions ----------

  tableBody.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (!isAdmin() && btn.getAttribute("data-action") !== "history") return;
    var id = btn.getAttribute("data-id");
    var emp = state.employees.find(function (x) { return x.id === id; });
    if (!emp) return;

    if (btn.getAttribute("data-action") === "toggle-active") {
      if (emp.active) {
        openResignModal(emp);
      } else {
        emp.active = true;
        emp.resignedAt = null;
        emp.resignReason = "";
        logAction("reactivate", emp, "");
        saveState();
        render();
      }
    } else if (btn.getAttribute("data-action") === "history") {
      openHistory(emp);
    } else if (btn.getAttribute("data-action") === "renew") {
      openContractModal(emp);
    }
  });

  // ---------- add / renew contract modal ----------

  var contractBackdrop = document.getElementById("contractModalBackdrop");
  var contractForm = document.getElementById("contractForm");
  var contractFormError = document.getElementById("contractFormError");
  var f_payrollNo = document.getElementById("f_payrollNo");
  var f_name = document.getElementById("f_name");
  var f_department = document.getElementById("f_department");
  var f_designation = document.getElementById("f_designation");
  var f_docUrl = document.getElementById("f_docUrl");
  var f_startDate = document.getElementById("f_startDate");
  var f_period = document.getElementById("f_period");
  var f_endDateWrap = document.getElementById("f_endDateWrap");
  var f_endDate = document.getElementById("f_endDate");
  var periodPreview = document.getElementById("periodPreview");

  function updatePeriodPreview() {
    var val = f_period.value;
    if (val === "custom") {
      f_endDateWrap.style.display = "block";
      periodPreview.textContent = "";
      return;
    }
    f_endDateWrap.style.display = "none";
    if (!val) { periodPreview.textContent = "No end date will be set \u2014 this shows as pending until you add one."; return; }
    if (!f_startDate.value) { periodPreview.textContent = "Pick a start date to see the calculated end date."; return; }
    var start = new Date(f_startDate.value + "T00:00:00");
    var end = addMonths(start, parseInt(val, 10));
    periodPreview.textContent = "Ends " + end.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  f_period.addEventListener("change", updatePeriodPreview);
  f_startDate.addEventListener("change", updatePeriodPreview);

  function openContractModal(emp) {
    contractFormError.style.display = "none";
    contractForm.reset();
    f_endDateWrap.style.display = "none";
    periodPreview.textContent = "";
    if (emp) {
      document.getElementById("contractModalTitle").textContent = "Renew contract";
      document.getElementById("contractModalSub").textContent = "Adding this for " + emp.name + " creates a new contract period in their history.";
      f_payrollNo.value = emp.payrollNo || "";
      f_name.value = emp.name || "";
      f_department.value = emp.department || "";
      f_designation.value = emp.designation || "";
    } else {
      document.getElementById("contractModalTitle").textContent = "Add a contract";
      document.getElementById("contractModalSub").textContent = "Matching an existing payroll number or name adds this as a new contract period for that employee. Otherwise a new employee record is created.";
    }
    contractBackdrop.classList.add("open");
    f_name.focus();
  }
  function closeContractModal() {
    contractBackdrop.classList.remove("open");
    if (reopenHistoryAfterSubmit) {
      reopenHistoryAfterSubmit = false;
      if (historyTargetEmp) openHistory(historyTargetEmp);
    }
  }

  document.getElementById("addContractBtn").addEventListener("click", function () { openContractModal(null); });
  document.getElementById("addFirstBtn").addEventListener("click", function () { openContractModal(null); });
  document.getElementById("contractCancelBtn").addEventListener("click", closeContractModal);
  contractBackdrop.addEventListener("click", function (e) { if (e.target === contractBackdrop) closeContractModal(); });

  contractForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!isAdmin()) return;
    var name = f_name.value.trim();
    if (!name) { contractFormError.textContent = "Employee name is required."; contractFormError.style.display = "block"; return; }
    if (!f_startDate.value) { contractFormError.textContent = "Start date is required."; contractFormError.style.display = "block"; return; }

    var start = new Date(f_startDate.value + "T00:00:00");
    var startDate = start.toISOString();
    var periodVal = f_period.value;
    var endDate = null;
    var durationMonths = null;

    if (periodVal === "custom") {
      if (!f_endDate.value) {
        contractFormError.textContent = "Pick an end date, or choose a preset period instead.";
        contractFormError.style.display = "block";
        return;
      }
      var end = new Date(f_endDate.value + "T00:00:00");
      if (end < start) {
        contractFormError.textContent = "End date can't be before the start date.";
        contractFormError.style.display = "block";
        return;
      }
      endDate = end.toISOString();
    } else if (periodVal) {
      durationMonths = parseInt(periodVal, 10);
      endDate = addMonths(start, durationMonths).toISOString();
    }
    // else: no period chosen and no custom date — contract has no end date yet (pending)

    var doc = f_docUrl.value.trim();
    if (doc && !safeUrl(doc)) {
      contractFormError.textContent = "The contract link must start with http:// or https://";
      contractFormError.style.display = "block";
      return;
    }

    var entry = {
      docUrl: doc ? safeUrl(doc) : "",
      payrollNo: f_payrollNo.value.trim(),
      name: name,
      department: f_department.value.trim(),
      designation: f_designation.value.trim(),
      startDate: startDate,
      endDate: endDate,
      durationMonths: durationMonths
    };
    var r = upsertContract(entry, "manual");
    if (r.added) {
      var periodText = fmtDate(entry.startDate) + " \u2192 " + fmtDate(entry.endDate);
      logAction(r.created ? "add-employee" : (r.restored ? "restore-contract" : "add-contract"), r.emp, periodText);
      saveState();
      showToast(r.created ? "Employee added." : (r.restored ? "That period had been deleted \u2014 it has been restored." : "Contract period added for " + r.emp.name + "."), "info");
    } else {
      showToast("That exact period already exists for " + r.emp.name + " \u2014 nothing was added.", "info");
    }
    closeContractModal();
    refresh();
  });

  // ---------- history modal ----------

  var historyBackdrop = document.getElementById("historyModalBackdrop");
  var historyList = document.getElementById("historyList");
  var historyTargetEmp = null;
  var reopenHistoryAfterSubmit = false;

  function safeUrl(u) {
    try {
      var x = new URL(String(u).trim());
      return (x.protocol === "http:" || x.protocol === "https:") ? x.href : "";
    } catch (e) { return ""; }
  }

  function historyMeta(emp) {
    return [emp.payrollNo ? "Payroll No. " + emp.payrollNo : null, emp.department, emp.designation].filter(Boolean).join(" \u00b7 ") +
      (emp.active ? "" : " \u00b7 Resigned" + (emp.resignedAt ? " " + fmtDate(emp.resignedAt) : "") + (emp.resignReason ? " \u2014 " + emp.resignReason : ""));
  }

  function byStartDesc(a, b) {
    var ta = a.startDate ? new Date(a.startDate).getTime() : -Infinity;
    var tb = b.startDate ? new Date(b.startDate).getTime() : -Infinity;
    return tb - ta;
  }

  function historyItemHtml(c, current, deleted) {
    var status = statusForContract(c);
    var isCurrent = !deleted && current && c === current;
    var id = escapeHtml(c.id);
    var doc = c.docUrl && safeUrl(c.docUrl)
      ? ' \u00b7 <a href="' + escapeHtml(safeUrl(c.docUrl)) + '" target="_blank" rel="noopener noreferrer">Document</a>' : "";
    var trail = deleted
      ? "Deleted" + (c.deletedAt ? " " + fmtDate(c.deletedAt) : "") + (c.deletedBy ? " by " + escapeHtml(c.deletedBy) : "")
      : escapeHtml(periodLabel(c)) + " \u00b7 " + (c.source === "manual" ? "Added manually" : "From import") +
        (c.addedAt ? " \u00b7 " + fmtDate(c.addedAt) : "") + (c.addedBy ? " by " + escapeHtml(c.addedBy) : "") +
        (c.editedAt ? " \u00b7 edited " + fmtDate(c.editedAt) : "");
    var buttons = "";
    if (isAdmin()) {
      buttons = deleted
        ? '<button type="button" class="link-btn" data-action="restore-contract" data-contract-id="' + id + '" style="margin-left:0.6rem;">Restore</button>'
        : '<button type="button" class="link-btn" data-action="edit-contract" data-contract-id="' + id + '" style="margin-left:0.6rem;">Edit</button>' +
          '<button type="button" class="link-btn warn" data-action="remove-contract" data-contract-id="' + id + '" style="margin-left:0.6rem;">Delete</button>';
    }
    return '<li data-contract-id="' + id + '"' + (deleted ? ' class="hist-deleted"' : "") + ">" +
      "<div>" +
        '<div class="hrange">' + fmtDate(c.startDate) + " &rarr; " + fmtDate(c.endDate) + "</div>" +
        '<div class="hsource">' + trail + doc + "</div>" +
      "</div>" +
      '<div class="htag">' +
        (isCurrent ? '<span class="current-tag">Current</span>' : "") +
        (deleted ? "" : '<span class="pill ' + status + '">' + statusLabel(status) + "</span>") +
        buttons +
      "</div>" +
    "</li>";
  }

  function openHistory(emp) {
    historyTargetEmp = emp;
    if (ensureContractIds(emp)) saveState();
    document.getElementById("historyName").textContent = emp.name;
    document.getElementById("historyMeta").textContent = historyMeta(emp);

    var current = getCurrentContract(emp);
    var live = liveContracts(emp).slice().sort(byStartDesc);
    var deleted = (emp.contracts || []).filter(function (c) { return c.deleted; }).sort(byStartDesc);

    var html = live.length
      ? live.map(function (c) { return historyItemHtml(c, current, false); }).join("")
      : "<li>No contract periods on file.</li>";
    if (deleted.length && isAdmin()) {
      html += '<li class="hist-sep">Deleted periods (' + deleted.length + ")</li>" +
        deleted.map(function (c) { return historyItemHtml(c, current, true); }).join("");
    }
    historyList.innerHTML = html;
    historyBackdrop.classList.add("open");
  }

  function printHistory(emp) {
    if (!emp) return;
    var current = getCurrentContract(emp);
    var sorted = liveContracts(emp).slice().sort(byStartDesc);
    var rowsHtml = sorted.map(function (c) {
      var status = statusForContract(c);
      var isCurrent = current && c === current;
      return "<tr>" +
        "<td>" + fmtDate(c.startDate) + "</td>" +
        "<td>" + fmtDate(c.endDate) + "</td>" +
        "<td>" + escapeHtml(periodLabel(c)) + "</td>" +
        "<td>" + escapeHtml(statusLabel(status)) + (isCurrent ? " (Current)" : "") + "</td>" +
        "<td>" + (c.source === "manual" ? "Added manually" : "From import") + "</td>" +
      "</tr>";
    }).join("");

    document.getElementById("printArea").innerHTML =
      "<h1>" + escapeHtml(REPORT_TITLE) + "</h1>" +
      "<h2>Contract history \u2014 " + escapeHtml(emp.name) + "<br>" + escapeHtml(historyMeta(emp)) + "</h2>" +
      "<table><thead><tr><th>Start Date</th><th>End Date</th><th>Period</th><th>Status</th><th>Source</th></tr></thead>" +
      "<tbody>" + (rowsHtml || "<tr><td colspan='5'>No contract periods on file.</td></tr>") + "</tbody></table>" +
      "<div class='print-footer'>Printed " + new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) + "</div>";
    window.print();
  }

  // Delete is soft: the period is hidden and ignored everywhere, but can be restored from "Deleted periods".
  // Two-step button (no browser pop-up): the first click arms it, the second one deletes.
  historyList.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-action]");
    if (!btn || !isAdmin() || !historyTargetEmp) return;
    var action = btn.getAttribute("data-action");
    var emp = historyTargetEmp;
    var cid = btn.getAttribute("data-contract-id");
    var c = (emp.contracts || []).filter(function (x) { return x.id === cid; })[0];
    if (!c) return;

    if (action === "remove-contract") {
      if (btn.getAttribute("data-armed") !== "1") {
        btn.setAttribute("data-armed", "1");
        btn.textContent = "Click again to confirm";
        setTimeout(function () {
          if (btn.isConnected) { btn.removeAttribute("data-armed"); btn.textContent = "Delete"; }
        }, 4000);
        return;
      }
      c.deleted = true;
      c.deletedAt = new Date().toISOString();
      c.deletedBy = currentUserLabel();
      logAction("delete-contract", emp, fmtDate(c.startDate) + " \u2192 " + fmtDate(c.endDate));
      saveState();
      openHistory(emp);
      render();
      showToast("Contract period deleted. You can restore it from \u201cDeleted periods\u201d below.", "info");
    } else if (action === "restore-contract") {
      delete c.deleted; delete c.deletedAt; delete c.deletedBy;
      logAction("restore-contract", emp, fmtDate(c.startDate) + " \u2192 " + fmtDate(c.endDate));
      saveState();
      openHistory(emp);
      render();
      showToast("Contract period restored.", "info");
    } else if (action === "edit-contract") {
      openEditModal(emp, c);
    }
  });

  document.getElementById("historyAddBtn").addEventListener("click", function () {
    if (!isAdmin() || !historyTargetEmp) return;
    reopenHistoryAfterSubmit = true;
    historyBackdrop.classList.remove("open");
    openContractModal(historyTargetEmp);
  });
  document.getElementById("historyPrintBtn").addEventListener("click", function () { printHistory(historyTargetEmp); });
  document.getElementById("historyCloseBtn").addEventListener("click", function () { historyBackdrop.classList.remove("open"); });
  historyBackdrop.addEventListener("click", function (e) { if (e.target === historyBackdrop) historyBackdrop.classList.remove("open"); });

  // ---------- edit employee details (name, department, designation) ----------

  var detailsBackdrop = document.getElementById("detailsModalBackdrop");
  var detailsForm = document.getElementById("detailsForm");
  var detailsError = document.getElementById("detailsError");
  var d_name = document.getElementById("d_name");
  var d_department = document.getElementById("d_department");
  var d_designation = document.getElementById("d_designation");
  var detailsTargetId = null;

  function fillDatalist(id, key) {
    var seen = {};
    var vals = state.employees.map(function (e) { return (e[key] || "").trim(); }).filter(function (v) { if (!v || seen[v.toLowerCase()]) return false; seen[v.toLowerCase()] = 1; return true; }).sort();
    document.getElementById(id).innerHTML = vals.map(function (v) { return '<option value="' + escapeHtml(v) + '"></option>'; }).join("");
  }

  function openDetailsModal(emp) {
    detailsTargetId = emp.id;
    detailsError.style.display = "none";
    document.getElementById("detailsSub").textContent = (emp.payrollNo ? "Payroll No. " + emp.payrollNo : "No payroll number") + " \u00b7 contract history stays attached to this employee.";
    d_name.value = emp.name || "";
    d_department.value = emp.department || "";
    d_designation.value = emp.designation || "";
    fillDatalist("d_deptList", "department");
    fillDatalist("d_desList", "designation");
    historyBackdrop.classList.remove("open");
    detailsBackdrop.classList.add("open");
    d_name.focus();
  }
  function closeDetailsModal(reopen) {
    detailsBackdrop.classList.remove("open");
    var emp = state.employees.filter(function (x) { return x.id === detailsTargetId; })[0];
    detailsTargetId = null;
    if (reopen && emp) openHistory(emp);
  }
  document.getElementById("historyEditBtn").addEventListener("click", function () {
    if (!isAdmin() || !historyTargetEmp) return;
    openDetailsModal(historyTargetEmp);
  });
  document.getElementById("detailsCancelBtn").addEventListener("click", function () { closeDetailsModal(true); });
  detailsBackdrop.addEventListener("click", function (e) { if (e.target === detailsBackdrop) closeDetailsModal(true); });

  detailsForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!isAdmin() || !detailsTargetId) return;
    function fail(msg) { detailsError.textContent = msg; detailsError.style.display = "block"; }
    var emp = state.employees.filter(function (x) { return x.id === detailsTargetId; })[0];
    if (!emp) { closeDetailsModal(false); return; }
    var name = d_name.value.replace(/\s+/g, " ").trim();
    var dept = d_department.value.trim();
    var des = d_designation.value.trim();
    if (!name) { fail("Employee name is required."); return; }
    var nk = nameKey(name);
    var clash = state.employees.filter(function (x) {
      return x.id !== emp.id && nameKey(x.name) === nk && (!x.payrollNo || !emp.payrollNo || x.payrollNo === emp.payrollNo);
    })[0];
    if (clash) { fail("Another employee is already named \u201c" + clash.name + "\u201d. Use a different spelling or fix that record first."); return; }

    var changes = [];
    if (name !== emp.name) changes.push("Name: " + emp.name + " \u2192 " + name);
    if (dept !== (emp.department || "")) changes.push("Department: " + (emp.department || "\u2014") + " \u2192 " + (dept || "\u2014"));
    if (des !== (emp.designation || "")) changes.push("Designation: " + (emp.designation || "\u2014") + " \u2192 " + (des || "\u2014"));
    if (!changes.length) { closeDetailsModal(true); showToast("No changes to save.", "info"); return; }

    emp.manualFields = emp.manualFields || {};
    if (dept !== (emp.department || "")) emp.manualFields.department = true;
    if (des !== (emp.designation || "")) emp.manualFields.designation = true;
    emp.name = name;
    emp.department = dept;
    emp.designation = des;
    emp.detailsEditedAt = new Date().toISOString();
    emp.detailsEditedBy = currentUserLabel();
    logAction("edit-employee", emp, changes.join("; "));
    saveState();
    closeDetailsModal(true);
    refresh();
    showToast("Employee details updated.", "info");
  });

  // ---------- edit one contract period ----------

  var editBackdrop = document.getElementById("editModalBackdrop");
  var editForm = document.getElementById("editForm");
  var editError = document.getElementById("editError");
  var e_startDate = document.getElementById("e_startDate");
  var e_period = document.getElementById("e_period");
  var e_endDateWrap = document.getElementById("e_endDateWrap");
  var e_endDate = document.getElementById("e_endDate");
  var e_docUrl = document.getElementById("e_docUrl");
  var e_preview = document.getElementById("e_preview");
  var editTarget = null;

  function toDateInput(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    var m = String(d.getMonth() + 1), day = String(d.getDate());
    return d.getFullYear() + "-" + (m.length < 2 ? "0" + m : m) + "-" + (day.length < 2 ? "0" + day : day);
  }

  function updateEditPreview() {
    var val = e_period.value;
    if (val === "custom") { e_endDateWrap.style.display = "block"; e_preview.textContent = ""; return; }
    e_endDateWrap.style.display = "none";
    if (!val) { e_preview.textContent = "No end date will be set \u2014 this shows as pending until you add one."; return; }
    if (!e_startDate.value) { e_preview.textContent = "Pick a start date to see the calculated end date."; return; }
    var end = addMonths(new Date(e_startDate.value + "T00:00:00"), parseInt(val, 10));
    e_preview.textContent = "Ends " + end.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  e_period.addEventListener("change", updateEditPreview);
  e_startDate.addEventListener("change", updateEditPreview);

  function openEditModal(emp, c) {
    editTarget = { empId: emp.id, contractId: c.id };
    editError.style.display = "none";
    document.getElementById("editSub").textContent = "Editing a contract period for " + emp.name + ".";
    e_startDate.value = toDateInput(c.startDate);
    var presets = [1, 3, 6, 12, 24];
    if (c.durationMonths != null && presets.indexOf(Number(c.durationMonths)) !== -1) {
      e_period.value = String(c.durationMonths);
      e_endDate.value = "";
    } else if (c.endDate) {
      e_period.value = "custom";
      e_endDate.value = toDateInput(c.endDate);
    } else {
      e_period.value = "";
      e_endDate.value = "";
    }
    e_docUrl.value = c.docUrl || "";
    updateEditPreview();
    historyBackdrop.classList.remove("open");
    editBackdrop.classList.add("open");
  }

  function closeEditModal(reopen) {
    editBackdrop.classList.remove("open");
    if (reopen && historyTargetEmp) openHistory(historyTargetEmp);
    editTarget = null;
  }
  document.getElementById("editCancelBtn").addEventListener("click", function () { closeEditModal(true); });
  editBackdrop.addEventListener("click", function (e) { if (e.target === editBackdrop) closeEditModal(true); });

  editForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!isAdmin() || !editTarget) return;
    function fail(msg) { editError.textContent = msg; editError.style.display = "block"; }
    var emp = state.employees.filter(function (x) { return x.id === editTarget.empId; })[0];
    var c = emp && emp.contracts.filter(function (x) { return x.id === editTarget.contractId; })[0];
    if (!c) { closeEditModal(false); return; }
    if (!e_startDate.value) { fail("Start date is required."); return; }

    var start = new Date(e_startDate.value + "T00:00:00");
    var periodVal = e_period.value;
    var endDate = null, durationMonths = null;
    if (periodVal === "custom") {
      if (!e_endDate.value) { fail("Pick an end date, or choose a preset period instead."); return; }
      var end = new Date(e_endDate.value + "T00:00:00");
      if (end < start) { fail("End date can't be before the start date."); return; }
      endDate = end.toISOString();
    } else if (periodVal) {
      durationMonths = parseInt(periodVal, 10);
      endDate = addMonths(start, durationMonths).toISOString();
    }
    var doc = e_docUrl.value.trim();
    if (doc && !safeUrl(doc)) { fail("The document link must start with http:// or https://"); return; }

    var before = fmtDate(c.startDate) + " \u2192 " + fmtDate(c.endDate);
    c.startDate = start.toISOString();
    c.endDate = endDate;
    c.durationMonths = durationMonths;
    if (doc) c.docUrl = safeUrl(doc); else delete c.docUrl;
    c.editedAt = new Date().toISOString();
    c.editedBy = currentUserLabel();
    logAction("edit-contract", emp, before + "  became  " + fmtDate(c.startDate) + " \u2192 " + fmtDate(c.endDate));
    saveState();
    closeEditModal(true);
    render();
    showToast("Contract period updated.", "info");
  });

  // ---------- resign / terminate modal ----------

  var resignBackdrop = document.getElementById("resignModalBackdrop");
  var resignModalSub = document.getElementById("resignModalSub");
  var r_date = document.getElementById("r_date");
  var r_reason = document.getElementById("r_reason");
  var resignTargetId = null;

  function openResignModal(emp) {
    resignTargetId = emp.id;
    resignModalSub.textContent = "This marks " + emp.name + " as resigned. They'll be hidden from the active list but their record and contract history stay intact.";
    r_date.value = new Date().toISOString().slice(0, 10);
    r_reason.value = "";
    resignBackdrop.classList.add("open");
    r_date.focus();
  }
  function closeResignModal() { resignBackdrop.classList.remove("open"); resignTargetId = null; }

  document.getElementById("resignCancelBtn").addEventListener("click", closeResignModal);
  resignBackdrop.addEventListener("click", function (e) { if (e.target === resignBackdrop) closeResignModal(); });

  document.getElementById("resignConfirmBtn").addEventListener("click", function () {
    if (!isAdmin()) { closeResignModal(); return; }
    var emp = state.employees.find(function (x) { return x.id === resignTargetId; });
    if (!emp) { closeResignModal(); return; }
    emp.active = false;
    emp.resignedAt = r_date.value ? new Date(r_date.value + "T00:00:00").toISOString() : new Date().toISOString();
    emp.resignReason = r_reason.value.trim();
    logAction("resign", emp, "Resigned " + fmtDate(emp.resignedAt) + (emp.resignReason ? " \u2014 " + emp.resignReason : ""));
    saveState();
    closeResignModal();
    render();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    reopenHistoryAfterSubmit = false;
    document.querySelectorAll(".modal-backdrop.open").forEach(function (el) {
      if (el.id !== "loginGate") el.classList.remove("open");
    });
  });

  // ---------- renewal stage (table and the needs-attention panel share this) ----------

  function onRenewalChange(e) {
    var sel = e.target.closest ? e.target.closest(".renewal-select") : null;
    if (!sel || !isAdmin()) return;
    var emp = state.employees.filter(function (x) { return x.id === sel.getAttribute("data-id"); })[0];
    if (!emp) return;
    var c = getCurrentContract(emp);
    if (!c) return;
    ensureContractIds(emp);
    var stage = sel.value;
    if (stage === "none") delete emp.renewal;
    else emp.renewal = { contractId: c.id, stage: stage, updatedAt: new Date().toISOString(), updatedBy: currentUserLabel() };
    logAction("renewal", emp, "Renewal: " + renewalLabel(stage));
    saveState();
    render();
  }
  tableBody.addEventListener("change", onRenewalChange);

  // ---------- needs attention (admin only) ----------

  var attentionShowAll = false;
  var attentionList = document.getElementById("attentionList");

  function attentionThresholds() {
    var t = (state.settings.notify.thresholds || []).slice().sort(function (a, b) { return b - a; });
    return t.length ? t : [60, 30, 14];
  }

  function attentionData() {
    var thresholds = attentionThresholds();
    var asc = thresholds.slice().sort(function (a, b) { return a - b; });
    var maxT = thresholds[0];
    var items = [], stale = 0;
    state.employees.forEach(function (emp) {
      if (!emp.active) return;
      var c = getCurrentContract(emp);
      if (!c || !c.endDate) return;
      var days = daysForContract(c);
      var stage = renewalStageFor(emp, c);
      if (stage === "renewed" || stage === "notrenewing") return;       // already dealt with
      if (days < -30) { stale++; return; }                              // long expired: summarised below
      if (days > maxT) return;
      items.push({ emp: emp, contract: c, days: days, stage: stage });
    });
    items.sort(function (a, b) { return a.days - b.days; });
    return { items: items, stale: stale, thresholds: thresholds };
  }

  function whenLabel(days) {
    if (days < 0) return Math.abs(days) + " day" + (Math.abs(days) === 1 ? "" : "s") + " ago";
    if (days === 0) return "today";
    return "in " + days + " day" + (days === 1 ? "" : "s");
  }

  function renderAttention() {
    if (!attentionList || !isAdmin()) return;
    var d = attentionData();
    var urgent = d.items.filter(function (i) { return i.days <= 14; }).length;
    document.getElementById("attentionSummary").textContent = d.items.length
      ? d.items.length + " need action" + (urgent ? " \u00b7 " + urgent + " expired or within 14 days" : "") : "";

    var html = "";
    if (!d.items.length) {
      html += '<li class="attn-clear">Nothing is expiring in the next ' + d.thresholds[0] + ' days.</li>';
    }
    var shown = attentionShowAll ? d.items : d.items.slice(0, 8);
    html += shown.map(function (i) {
      var emp = i.emp;
      var cls = i.days < 0 ? "late" : (i.days <= 14 ? "soon" : "");
      return '<li class="attn-item"><div class="attn-main"><strong>' + escapeHtml(emp.name) + "</strong>" +
        '<span class="attn-meta">' + escapeHtml([emp.department, emp.designation].filter(Boolean).join(" \u00b7 ")) + "</span></div>" +
        '<div class="attn-when ' + cls + '">' + whenLabel(i.days) + ' <span class="attn-date">(' + fmtDate(i.contract.endDate) + ")</span></div>" +
        '<div class="attn-actions"><select class="renewal-select" data-id="' + escapeHtml(emp.id) + '" aria-label="Renewal stage for ' + escapeHtml(emp.name) + '">' +
          RENEWAL_STAGES.map(function (s) { return '<option value="' + s.value + '"' + (s.value === i.stage ? " selected" : "") + ">" + s.label + "</option>"; }).join("") +
        '</select><button type="button" class="link-btn" data-attn="renew" data-id="' + escapeHtml(emp.id) + '">Renew</button></div></li>';
    }).join("");
    if (d.items.length > 8) {
      html += '<li class="attn-more"><button type="button" class="link-btn" data-attn="' + (attentionShowAll ? "less" : "more") + '">' +
        (attentionShowAll ? "Show fewer" : "Show all " + d.items.length) + "</button></li>";
    }
    if (d.stale) {
      html += '<li class="attn-stale">' + d.stale + " older expired contract" + (d.stale === 1 ? " is" : "s are") + " still open \u2014 " +
        '<button type="button" class="link-btn" data-attn="stale">review them</button> and mark people who left as resigned, or add their new contract.</li>';
    }
    attentionList.innerHTML = html;
  }

  attentionList.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-attn]");
    if (!btn || !isAdmin()) return;
    var kind = btn.getAttribute("data-attn");
    if (kind === "more") { attentionShowAll = true; renderAttention(); }
    else if (kind === "less") { attentionShowAll = false; renderAttention(); }
    else if (kind === "stale") { state.statusFilter = "expired"; render(); document.getElementById("resultCount").scrollIntoView && document.getElementById("resultCount").scrollIntoView({ behavior: "smooth" }); }
    else if (kind === "renew") {
      var emp = state.employees.filter(function (x) { return x.id === btn.getAttribute("data-id"); })[0];
      if (emp) openContractModal(emp);
    }
  });
  attentionList.addEventListener("change", onRenewalChange);

  // ---------- admin tools ----------

  var adminBackdrop = document.getElementById("adminModalBackdrop");
  var adminMsg = document.getElementById("adminMsg");
  var n_enabled = document.getElementById("n_enabled");
  var n_emails = document.getElementById("n_emails");
  var n_thresholds = document.getElementById("n_thresholds");
  var n_weekly = document.getElementById("n_weekly");
  var n_appUrl = document.getElementById("n_appUrl");

  function setAdminMsg(text, bad) {
    adminMsg.textContent = text;
    adminMsg.className = "admin-msg" + (bad ? " bad" : "");
    adminMsg.style.display = text ? "block" : "none";
  }

  function openAdminTools() {
    if (!isAdmin()) return;
    var n = state.settings.notify;
    n_enabled.checked = n.enabled;
    n_emails.value = n.emails.join(", ");
    n_thresholds.value = n.thresholds.slice().sort(function (a, b) { return b - a; }).join(", ");
    n_weekly.checked = n.weekly;
    n_appUrl.value = n.appUrl || "";
    setAdminMsg("");
    document.getElementById("rulesAdmins").value = ADMIN_EMAILS.join(", ");
    document.getElementById("rulesViewers").value = "";
    document.getElementById("rulesNotifier").value = "";
    refreshRules();

    var lastRun = document.getElementById("n_lastRun");
    if (!FIREBASE_DB_URL) {
      lastRun.textContent = "Reminder emails need the Firebase database and the scheduled reminder job (see the README).";
    } else {
      lastRun.textContent = "Checking when the reminder job last ran\u2026";
      cloudRequest("GET", "notify_state/_lastRun").then(function (r) { return r.ok ? r.json() : null; }).then(function (info) {
        lastRun.textContent = info && info.at
          ? "Reminder job last ran " + new Date(info.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) +
            (info.sent ? " and emailed " + info.sent + " contract" + (info.sent === 1 ? "" : "s") : " \u2014 nothing new to report") + "."
          : "The reminder job hasn't reported in yet. Run it once from GitHub \u2192 Actions to check it works.";
      }).catch(function () { lastRun.textContent = "Couldn't check the reminder job."; });
    }
    adminBackdrop.classList.add("open");
  }

  document.getElementById("adminToolsBtn").addEventListener("click", openAdminTools);
  document.getElementById("adminCloseBtn").addEventListener("click", function () { adminBackdrop.classList.remove("open"); });
  adminBackdrop.addEventListener("click", function (e) { if (e.target === adminBackdrop) adminBackdrop.classList.remove("open"); });

  function parseEmails(text) {
    return String(text || "").split(/[,;\s]+/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  document.getElementById("n_save").addEventListener("click", function () {
    if (!isAdmin()) return;
    var emails = parseEmails(n_emails.value);
    var bad = emails.filter(function (x) { return !EMAIL_RE.test(x); });
    if (bad.length) { setAdminMsg("These don't look like email addresses: " + bad.join(", "), true); return; }
    var thresholds = parseEmails(n_thresholds.value).map(Number);
    if (thresholds.some(function (x) { return !(x >= 1 && x <= 365) || Math.floor(x) !== x; })) {
      setAdminMsg("Reminder days must be whole numbers between 1 and 365, for example 60, 30, 14.", true);
      return;
    }
    var uniq = thresholds.filter(function (x, i) { return thresholds.indexOf(x) === i; }).sort(function (a, b) { return b - a; });
    if (n_enabled.checked && !emails.length) { setAdminMsg("Add at least one email address to send reminders to, or switch reminders off.", true); return; }
    var appUrl = n_appUrl.value.trim();
    if (appUrl && !safeUrl(appUrl)) { setAdminMsg("The app address must start with http:// or https://", true); return; }

    state.settings = normalizeSettings({ notify: { enabled: n_enabled.checked, emails: emails, thresholds: uniq.length ? uniq : [60, 30, 14], weekly: n_weekly.checked, appUrl: appUrl } });
    logAction("settings", null, "Reminder settings: " + (n_enabled.checked ? "on" : "off") + ", " + emails.length + " recipient(s), days " + state.settings.notify.thresholds.join("/"));
    saveState();
    renderAttention();
    setAdminMsg(FIREBASE_DB_URL ? "Saved. The daily reminder job will use these settings." : "Saved on this device. Reminders only go out when the cloud database and reminder job are set up.");
  });

  // ----- backup and restore -----
  function slug() { return COMPANY.replace(/\s+/g, "-"); }

  function downloadBackup(quiet) {
    var payload = {
      format: "contract-tracker-backup", version: 2,
      exportedAt: new Date().toISOString(), exportedBy: currentUserLabel(), company: COMPANY,
      employees: state.employees, lastImport: state.lastImport, settings: state.settings
    };
    var blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = slug() + "-contract-tracker-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    if (!quiet) {
      logAction("backup", null, "Downloaded a backup of " + state.employees.length + " employees");
      saveState();
      showToast("Backup downloaded \u2014 keep it somewhere safe.");
    }
  }
  document.getElementById("backupBtn").addEventListener("click", function () { if (isAdmin()) downloadBackup(false); });

  var restoreBackdrop = document.getElementById("restoreModalBackdrop");
  var pendingRestore = null;
  document.getElementById("restoreBtn").addEventListener("click", function () { if (isAdmin()) document.getElementById("restoreFile").click(); });
  document.getElementById("restoreFile").addEventListener("change", function () {
    var input = document.getElementById("restoreFile");
    var file = input.files && input.files[0];
    input.value = "";
    if (!file || !isAdmin()) return;
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var b = JSON.parse(ev.target.result);
        var list = b && b.format === "contract-tracker-backup" ? arrayFrom(b.employees) : [];
        if (!list.length || !list.every(function (x) { return x && x.id && x.name; })) throw new Error("not a backup");
        pendingRestore = { backup: b, list: list, fileName: file.name };
        var periods = list.reduce(function (n, x) { return n + arrayFrom(x.contracts).length; }, 0);
        document.getElementById("restoreSummary").textContent =
          "\u201c" + file.name + "\u201d holds " + list.length + " employees and " + periods + " contract periods" +
          (b.exportedAt ? ", saved " + new Date(b.exportedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "") +
          ". Restoring replaces everything currently in the tracker (" + state.employees.length + " employees). A backup of the current data is downloaded first.";
        restoreBackdrop.classList.add("open");
      } catch (err) {
        setAdminMsg("That file isn't a backup made by this tracker.", true);
      }
    };
    reader.readAsText(file);
  });
  document.getElementById("restoreCancelBtn").addEventListener("click", function () { restoreBackdrop.classList.remove("open"); pendingRestore = null; });
  document.getElementById("restoreConfirmBtn").addEventListener("click", function () {
    if (!isAdmin() || !pendingRestore) return;
    downloadBackup(true);
    var b = pendingRestore.backup;
    state.employees = pendingRestore.list.map(normalizeEmployee);
    state.employees.forEach(ensureContractIds);
    state.lastImport = b.lastImport || null;
    if (b.settings) state.settings = normalizeSettings(b.settings);
    logAction("restore", null, "Restored " + state.employees.length + " employees from " + pendingRestore.fileName);
    pendingRestore = null;
    restoreBackdrop.classList.remove("open");
    adminBackdrop.classList.remove("open");
    saveState({ replaceAll: true });
    refresh();
    showToast("Backup restored.");
  });

  // ----- activity log -----
  var logBackdrop = document.getElementById("logModalBackdrop");
  var LOG_LABELS = {
    "import": "Import", "add-contract": "Contract added", "add-employee": "Employee added", "edit-contract": "Contract edited", "edit-employee": "Details edited",
    "delete-contract": "Contract deleted", "restore-contract": "Contract restored", "resign": "Resigned", "reactivate": "Reactivated",
    "renewal": "Renewal stage", "settings": "Settings", "backup": "Backup", "restore": "Restore"
  };
  document.getElementById("logBtn").addEventListener("click", function () {
    if (!isAdmin()) return;
    var list = document.getElementById("logList");
    list.innerHTML = "<li>Loading\u2026</li>";
    logBackdrop.classList.add("open");
    loadLog().then(function (entries) {
      list.innerHTML = entries.length ? entries.map(function (x) {
        return "<li><div class='log-top'><span class='log-action'>" + escapeHtml(LOG_LABELS[x.action] || x.action || "") + "</span>" +
          "<span class='log-when'>" + escapeHtml(x.at ? new Date(x.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "") + "</span></div>" +
          "<div class='log-body'>" + (x.name ? "<strong>" + escapeHtml(x.name) + "</strong> \u2014 " : "") + escapeHtml(x.detail || "") + "</div>" +
          "<div class='log-by'>" + escapeHtml(x.by || "") + "</div></li>";
      }).join("") : "<li>No activity recorded yet.</li>";
    }).catch(function () { list.innerHTML = "<li>Couldn't load the activity log.</li>"; });
  });
  document.getElementById("logCloseBtn").addEventListener("click", function () { logBackdrop.classList.remove("open"); });
  logBackdrop.addEventListener("click", function (e) { if (e.target === logBackdrop) logBackdrop.classList.remove("open"); });

  // ----- database rules helper -----
  function buildRules(admins, viewers, notifier) {
    function expr(list) {
      return list.length ? list.map(function (x) { return "auth.token.email == '" + String(x).toLowerCase().replace(/[^a-z0-9@._+\-]/g, "") + "'"; }).join(" || ") : "false";
    }
    var A = expr(admins), V = expr(viewers), N = expr(notifier ? [notifier] : []);
    var isAdminRule = "auth != null && (" + A + ")";
    var readAll = "auth != null && (" + [A].concat(viewers.length ? [V] : []).concat(notifier ? [N] : []).join(" || ") + ")";
    var adminOrNotifier = "auth != null && (" + [A].concat(notifier ? [N] : []).join(" || ") + ")";
    var notifierRule = notifier ? "auth != null && (" + N + ")" : "false";
    return {
      rules: {
        ".read": false,
        ".write": false,
        "employees": { ".read": readAll, ".write": isAdminRule },
        "meta": { ".read": readAll, ".write": isAdminRule },
        "settings": { ".read": adminOrNotifier, ".write": isAdminRule },
        "log": { ".read": isAdminRule, "$id": { ".write": isAdminRule + " && !data.exists()" } },
        "notify_state": { ".read": adminOrNotifier, ".write": notifierRule },
        "data": { ".read": isAdminRule, ".write": false }
      }
    };
  }
  function refreshRules() {
    var admins = parseEmails(document.getElementById("rulesAdmins").value);
    var viewers = parseEmails(document.getElementById("rulesViewers").value);
    var notifier = parseEmails(document.getElementById("rulesNotifier").value)[0] || "";
    document.getElementById("rulesOut").value = admins.length
      ? JSON.stringify(buildRules(admins, viewers, notifier), null, 2)
      : "Enter at least one admin email above.";
  }
  ["rulesAdmins", "rulesViewers", "rulesNotifier"].forEach(function (id) {
    document.getElementById(id).addEventListener("input", refreshRules);
  });
  document.getElementById("rulesCopyBtn").addEventListener("click", function () {
    var out = document.getElementById("rulesOut");
    out.select();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(out.value);
      else document.execCommand("copy");
      showToast("Rules copied \u2014 paste them in Firebase \u2192 Realtime Database \u2192 Rules.", "info");
    } catch (e) { /* the text is selected, so Ctrl+C works */ }
  });
  window.__contractTracker.buildRules = buildRules;

  // ---------- small-screen sort ----------
  document.getElementById("mobileSort").addEventListener("change", function (e) {
    var parts = e.target.value.split("|");
    state.sortKey = parts[0];
    state.sortDir = parts[1] === "desc" ? -1 : 1;
    render();
  });

  // ---------- init ----------
  document.getElementById("loginTitle").textContent = COMPANY;
  document.title = COMPANY + " Contract Tracker";
  if (AUTH_ENABLED) {
    // Nothing is loaded until someone signs in. A returning visitor is signed back in
    // silently from the saved refresh token.
    var saved = null;
    try { saved = JSON.parse(window.localStorage.getItem(AUTH_KEY) || "null"); } catch (e) { /* ignore */ }
    if (saved && saved.refreshToken) {
      authState.refreshToken = saved.refreshToken;
      refreshIdToken().then(function () {
        setRole(roleForEmail(authState.email));
      }).catch(function (err) {
        if (err && err.kind === "network" && saved.email) {
          // offline: open with the copy stored on this device; changes sync once back online
          authState.email = saved.email;
          setRole(roleForEmail(saved.email));
        } else {
          try { window.localStorage.removeItem(AUTH_KEY); } catch (e) { /* ignore */ }
        }
      });
    }
  } else {
    // Local-only mode: start loading right away, in parallel with the gate.
    startLoad();
    var savedRole = null;
    try { savedRole = window.localStorage.getItem(ROLE_KEY); } catch (e) { /* ignore */ }
    if (savedRole === "admin" || savedRole === "viewer") {
      setRole(savedRole);
    }
  }
})();