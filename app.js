"use strict";

/* =========================================================
   DIGITAL DEAD MAN'S SWITCH - FRONT-END PROTOTYPE
   - State is kept in localStorage (no backend)
   - Content is encrypted in the browser with AES-GCM (Web Crypto)
   - Notifications are simulated, nothing is actually sent
   - DEMO LIMITATION: the encryption key is stored next to the
     ciphertext. A production version would wrap the key per
     recipient and never store it in plain form.
   ========================================================= */

const STORAGE_KEY = "dms_state_v1";
const MAX_FILE_BYTES = 1024 * 1024; // 1 MB, keeps localStorage usable

const STAGES = [
  "ACTIVE",
  "CHECK-IN MISSED",
  "GRACE PERIOD",
  "PRIMARY TRUSTEE",
  "SECONDARY TRUSTEE",
  "FINAL RELEASE",
];

let state = loadState();
let modalSwitchId = null;
let ticker = null;

/* ---------------------------------------------------------
   Helpers
   --------------------------------------------------------- */

function emptyState() {
  return { loggedIn: false, switches: [], audit: [], notifications: [], vault: [] };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved ? Object.assign(emptyState(), saved) : emptyState();
  } catch (e) {
    return emptyState();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    alert("Storage is full. Use a smaller file or reset the demo data in Settings.");
  }
}

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTime(ms) {
  return new Date(ms).toLocaleString();
}

function fmtCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return (d ? d + "d " : "") + (d || h ? pad(h) + ":" : "") + pad(m) + ":" + pad(s);
}

function logAudit(text) {
  state.audit.unshift({ time: Date.now(), text });
  state.audit = state.audit.slice(0, 200);
}

function notify(to, subject, body) {
  state.notifications.unshift({ time: Date.now(), to, subject, body });
  state.notifications = state.notifications.slice(0, 100);
}

function activeSwitches() {
  return state.switches.filter((s) => s.status === "active");
}

function currentSwitch() {
  return activeSwitches()[0] || null;
}

function findSwitch(id) {
  return state.switches.find((s) => s.id === id) || null;
}

/* ---------------------------------------------------------
   Encryption (AES-GCM via Web Crypto)
   --------------------------------------------------------- */

function bytesToB64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function encryptBytes(bytes) {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return { iv: bytesToB64(iv), data: bytesToB64(cipher), key: jwk };
}

async function decryptBytes(blob) {
  const key = await crypto.subtle.importKey("jwk", blob.key, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(blob.iv) }, key, b64ToBytes(blob.data));
  return new Uint8Array(plain);
}

/* ---------------------------------------------------------
   Login / navigation
   --------------------------------------------------------- */

function login() {
  state.loggedIn = true;
  logAudit("Signed in (demo mode)");
  saveState();
  showApp();
}

function logout() {
  state.loggedIn = false;
  saveState();
  $("app").classList.add("hidden");
  $("loginPage").classList.remove("hidden");
}

function showApp() {
  $("loginPage").classList.add("hidden");
  $("app").classList.remove("hidden");
  showPage("dashboard");
  if (!ticker) ticker = setInterval(tick, 1000);
}

function showPage(id) {
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  $(id).classList.add("active");

  const titles = {
    dashboard: "Dashboard", create: "Create Switch", vault: "Legacy Vault",
    trustees: "Trustees", checkin: "Check-In", lifecycle: "Lifecycle",
    notifications: "Notifications", audit: "Audit History", settings: "Settings",
  };
  $("pageTitle").textContent = titles[id] || id;

  document.querySelectorAll(".sidebar nav button").forEach((b) => {
    b.classList.toggle("current", (b.getAttribute("onclick") || "").includes("'" + id + "'"));
  });
  document.querySelector(".sidebar").classList.remove("open");
  renderAll();
}

function toggleSidebar() {
  document.querySelector(".sidebar").classList.toggle("open");
}

/* ---------------------------------------------------------
   Create switch
   --------------------------------------------------------- */

let contentType = "file";

function selectContentType(type) {
  contentType = type;
  $("fileChoice").classList.toggle("active-choice", type === "file");
  $("messageChoice").classList.toggle("active-choice", type === "message");
  $("fileArea").classList.toggle("hidden", type !== "file");
  $("messageArea").classList.toggle("hidden", type !== "message");
}

function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

async function createSwitch() {
  const name = $("switchName").value.trim();
  const primaryName = $("primaryName").value.trim();
  const primaryEmail = $("primaryEmail").value.trim();
  const secondaryName = $("secondaryName").value.trim();
  const secondaryEmail = $("secondaryEmail").value.trim();

  if (!name) return alert("Enter a switch name.");
  if (!primaryName || !isEmail(primaryEmail)) return alert("Enter the primary trustee's name and a valid email.");
  if (!secondaryName || !isEmail(secondaryEmail)) return alert("Enter the secondary trustee's name and a valid email.");

  let encrypted = null;
  let fileMeta = null;
  const enc = new TextEncoder();

  if (contentType === "file") {
    const file = $("legacyFile").files[0];
    if (!file) return alert("Choose a file to protect.");
    if (file.size > MAX_FILE_BYTES) return alert("File is too large for the demo. Maximum size is 1 MB.");
    encrypted = await encryptBytes(new Uint8Array(await file.arrayBuffer()));
    fileMeta = { name: file.name, type: file.type || "application/octet-stream", size: file.size };
  } else {
    const msg = $("legacyMessage").value.trim();
    if (!msg) return alert("Write the message to protect.");
    encrypted = await encryptBytes(enc.encode(msg));
  }

  const frequency = parseInt($("frequency").value, 10);
  const grace = parseInt($("gracePeriod").value, 10);
  const now = Date.now();

  const sw = {
    id: "sw_" + now,
    name,
    description: $("switchDescription").value.trim(),
    contentType,
    file: fileMeta,
    encrypted,
    frequency,
    grace,
    primary: { name: primaryName, email: primaryEmail },
    secondary: { name: secondaryName, email: secondaryEmail },
    additionalEmail: $("additionalEmail").value.trim(),
    whatsapp: $("whatsapp").value.trim(),
    finalAction: document.querySelector("input[name='finalAction']:checked").value,
    stage: 1,
    status: "active",
    createdAt: now,
    lastCheckIn: now,
    deadline: now + frequency * 1000,
    stageEnd: null,
  };

  state.switches.unshift(sw);
  logAudit('Switch "' + name + '" created. Content encrypted in the browser.');
  saveState();

  ["switchName", "switchDescription", "primaryName", "primaryEmail", "secondaryName",
    "secondaryEmail", "additionalEmail", "whatsapp", "legacyMessage"].forEach((id) => ($(id).value = ""));
  $("legacyFile").value = "";
  $("filePreview").classList.add("hidden");

  alert("Switch created. Check in before the deadline to keep it active.");
  showPage("dashboard");
}

/* ---------------------------------------------------------
   Check-in and lifecycle
   --------------------------------------------------------- */

function checkIn() {
  const list = activeSwitches().filter((s) => s.stage < 6);
  if (!list.length) return alert("No active switch to check in for.");
  const now = Date.now();
  list.forEach((s) => {
    s.stage = 1;
    s.lastCheckIn = now;
    s.deadline = now + s.frequency * 1000;
    s.stageEnd = null;
    logAudit('Check-in received for "' + s.name + '". Timer reset.');
  });
  saveState();
  renderAll();
}

function setStage(s, stage) {
  const now = Date.now();
  s.stage = stage;

  if (stage === 2) {
    s.stageEnd = now + 2000;
    logAudit('"' + s.name + '": check-in missed.');
  } else if (stage === 3) {
    s.stageEnd = now + s.grace * 1000;
    logAudit('"' + s.name + '": grace period started.');
  } else if (stage === 4) {
    s.stageEnd = now + s.grace * 1000;
    sendToTrustee(s, s.primary, "Primary");
  } else if (stage === 5) {
    s.stageEnd = now + s.grace * 1000;
    sendToTrustee(s, s.secondary, "Secondary");
  } else if (stage === 6) {
    s.stageEnd = null;
    logAudit('"' + s.name + '": reached final stage. Chosen action: ' + s.finalAction + ".");
    openModal(s.id);
  }
}

function advance(s) {
  if (s.stage < 6) setStage(s, s.stage + 1);
  saveState();
  renderAll();
}

function tick() {
  if (!state.loggedIn) return;
  const now = Date.now();
  let changed = false;

  activeSwitches().forEach((s) => {
    if (s.stage === 1 && now >= s.deadline) {
      setStage(s, 2);
      changed = true;
    } else if (s.stage > 1 && s.stage < 6 && s.stageEnd && now >= s.stageEnd) {
      setStage(s, s.stage + 1);
      changed = true;
    }
  });

  if (changed) saveState();
  renderLive();
  if (changed) renderAll();
}

async function sendToTrustee(s, trustee, role) {
  let body = "Hello " + trustee.name + ",\n\n" +
    s.primary.name + " and " + s.secondary.name + " are listed as trustees for \"" + s.name + "\".\n" +
    "The owner missed their check-in. You are the " + role.toLowerCase() + " trustee.\n\n";

  if (s.contentType === "file") {
    body += "Protected file: " + s.file.name + " (" + s.file.type + ")\n";
  } else {
    try {
      const text = new TextDecoder().decode(await decryptBytes(s.encrypted));
      body += "Message:\n" + text + "\n";
    } catch (e) {
      body += "The message could not be decrypted.\n";
    }
  }
  body += "\nConfirm receipt using the simulated link: https://example.invalid/confirm/" + s.id + "\n" +
    "If you do not confirm within " + s.grace + " seconds (demo time), it moves to the next trustee.";

  notify(trustee.email, role + " trustee notified: " + s.name, body);
  logAudit('"' + s.name + '": ' + role.toLowerCase() + " trustee notified (simulated).");
  saveState();
  renderAll();
}

function confirmReceipt(id) {
  const s = findSwitch(id);
  if (!s || s.status !== "active") return;
  const role = s.stage === 4 ? "Primary" : "Secondary";
  s.status = "completed";
  s.stageEnd = null;
  notify("owner", role + " trustee confirmed receipt", role + " trustee confirmed receipt for \"" + s.name + "\". The switch is complete.");
  logAudit('"' + s.name + '": ' + role.toLowerCase() + " trustee confirmed. Switch completed.");
  saveState();
  renderAll();
}

function simulateMissedCheckIn(id) {
  const s = findSwitch(id);
  if (s && s.stage === 1) {
    s.deadline = Date.now();
    tick();
  }
}

function skipStage(id) {
  const s = findSwitch(id);
  if (s && s.status === "active") advance(s);
}

/* ---------------------------------------------------------
   Final release modal
   --------------------------------------------------------- */

function openModal(id) {
  const s = findSwitch(id);
  if (!s) return;
  modalSwitchId = id;
  const action = s.finalAction === "delete" ? "Delete Legacy" : "Release Legacy";
  $("releaseContent").textContent =
    'Switch: "' + s.name + '"\nChosen final action: ' + action +
    "\n\nNo trustee confirmed in time. Select an action below to complete the demo.";
  $("releaseModal").classList.remove("hidden");
}

function closeModal() {
  $("releaseModal").classList.add("hidden");
}

async function releaseLegacy() {
  const s = findSwitch(modalSwitchId);
  if (!s) return;

  const box = $("releaseContent");
  box.textContent = "";

  try {
    const plain = await decryptBytes(s.encrypted);
    if (s.contentType === "file") {
      const url = URL.createObjectURL(new Blob([plain], { type: s.file.type }));
      const a = document.createElement("a");
      a.href = url;
      a.download = s.file.name;
      a.textContent = "Download " + s.file.name;
      box.appendChild(document.createTextNode("Decrypted in the browser.\n"));
      box.appendChild(a);
    } else {
      box.textContent = new TextDecoder().decode(plain);
    }
  } catch (e) {
    box.textContent = "Decryption failed.";
    return;
  }

  [s.primary.email, s.secondary.email, s.additionalEmail].filter(Boolean).forEach((to) => {
    notify(to, "Legacy released: " + s.name, "The legacy content for \"" + s.name + "\" has been released (simulated).");
  });
  if (s.whatsapp) notify(s.whatsapp, "WhatsApp alert: " + s.name, "Legacy released (simulated).");

  s.status = "released";
  logAudit('"' + s.name + '": legacy released (simulated).');
  saveState();
  renderAll();
}

function deleteLegacy() {
  const s = findSwitch(modalSwitchId);
  if (!s) return;
  s.encrypted = null;
  s.status = "deleted";
  logAudit('"' + s.name + '": legacy content permanently deleted.');
  notify("owner", "Legacy deleted: " + s.name, "The encrypted content was deleted.");
  saveState();
  closeModal();
  renderAll();
}

/* ---------------------------------------------------------
   Vault
   --------------------------------------------------------- */

function vaultUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  state.vault.unshift({ id: "v_" + Date.now(), name: file.name, size: file.size, time: Date.now() });
  logAudit("File listed in vault: " + file.name);
  saveState();
  event.target.value = "";
  renderVault();
}

function removeVaultItem(id) {
  state.vault = state.vault.filter((v) => v.id !== id);
  saveState();
  renderVault();
}

/* ---------------------------------------------------------
   Rendering
   --------------------------------------------------------- */

function renderAll() {
  renderDashboard();
  renderTrustees();
  renderLifecycle();
  renderNotifications();
  renderAudit();
  renderVault();
  renderLive();
}

function renderDashboard() {
  const active = activeSwitches();
  $("activeCount").textContent = active.length;
  $("inactiveCount").textContent = state.switches.length - active.length;

  const cur = currentSwitch();
  $("dashboardLastCheck").textContent = cur ? new Date(cur.lastCheckIn).toLocaleTimeString() : "—";
  $("dashboardStage").textContent = cur ? STAGES[cur.stage - 1] : "—";

  const list = $("switchList");
  if (!state.switches.length) {
    list.innerHTML = '<div class="empty-state">No switches yet. Create one to start monitoring.</div>';
    return;
  }
  list.innerHTML = state.switches.map((s) =>
    '<div class="switch-item"><div><strong>' + esc(s.name) + "</strong><small>" +
    esc(s.contentType === "file" ? s.file.name : "Message") + " · " + esc(s.status) +
    '</small></div><span class="status-pill ' + (s.status === "active" ? "active-pill" : "") + '">' +
    (s.status === "active" ? esc(STAGES[s.stage - 1]) : esc(s.status)) + "</span></div>"
  ).join("");
}

function renderTrustees() {
  const s = currentSwitch() || state.switches[0];
  $("primaryDisplay").textContent = s ? s.primary.name + " (" + s.primary.email + ")" : "Not configured";
  $("secondaryDisplay").textContent = s ? s.secondary.name + " (" + s.secondary.email + ")" : "Not configured";

  const set = (id, on) => {
    const el = $(id);
    el.textContent = on ? "NOTIFIED" : s ? "STANDBY" : "INACTIVE";
    el.className = "status-pill" + (on ? " warn" : "");
  };
  set("primaryStatus", !!s && s.status === "active" && s.stage === 4);
  set("secondaryStatus", !!s && s.status === "active" && s.stage === 5);
}

function renderLifecycle() {
  const s = currentSwitch();
  for (let i = 1; i <= 6; i++) {
    const el = $("stage" + i);
    el.classList.toggle("active", !!s && s.stage === i);
    el.classList.toggle("done", !!s && s.stage > i);
  }

  const box = $("stageControls");
  if (!s) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");

  let html = "<p>Demo controls for \"" + esc(s.name) + "\"</p>";
  if (s.stage === 6) {
    html += '<button class="release-btn" onclick="openModal(\'' + s.id + '\')">Open final action</button>';
  } else if (s.stage === 1) {
    html += '<button class="ghost-btn" onclick="simulateMissedCheckIn(\'' + s.id + '\')">Simulate missed check-in</button>';
  } else {
    html += '<button class="ghost-btn" onclick="skipStage(\'' + s.id + '\')">Simulate time: next stage</button>';
  }
  if (s.stage === 4 || s.stage === 5) {
    html += '<button class="release-btn" onclick="confirmReceipt(\'' + s.id + '\')">Trustee confirms receipt</button>';
  }
  html += '<button class="primary-btn" onclick="checkIn()">Check in (reset)</button>';
  box.innerHTML = html;
}

function renderNotifications() {
  const box = $("notificationList");
  if (!state.notifications.length) {
    box.innerHTML = '<div class="empty-state">No notifications yet.</div>';
    return;
  }
  box.innerHTML = state.notifications.map((n) =>
    '<div class="notif-card"><header><span>To: ' + esc(n.to) + "</span><span>" + esc(fmtTime(n.time)) +
    "</span></header><strong>" + esc(n.subject) + "</strong><pre>" + esc(n.body) + "</pre></div>"
  ).join("");
}

function renderAudit() {
  const box = $("auditList");
  if (!state.audit.length) {
    box.innerHTML = '<div class="empty-state">No activity yet.</div>';
    return;
  }
  box.innerHTML = state.audit.map((a) =>
    '<div class="audit-row"><time>' + esc(fmtTime(a.time)) + "</time><span>" + esc(a.text) + "</span></div>"
  ).join("");
}

function renderVault() {
  const box = $("vaultList");
  if (!state.vault.length) {
    box.innerHTML = '<div class="empty-state">Vault is empty. Upload a file to list it here.</div>';
    return;
  }
  box.innerHTML = state.vault.map((v) =>
    '<div class="vault-item"><div><strong>' + esc(v.name) + "</strong><br><small>" +
    Math.round(v.size / 1024) + " KB · " + esc(fmtTime(v.time)) +
    '</small></div><button class="text-btn" onclick="removeVaultItem(\'' + v.id + '\')">Remove</button></div>'
  ).join("");
}

function renderLive() {
  const s = currentSwitch();
  if (!s) {
    $("terminalSwitch").textContent = "No active switch";
    $("terminalStatus").textContent = "IDLE";
    $("countdown").textContent = "--:--";
    $("lastVerified").textContent = "—";
    return;
  }
  $("terminalSwitch").textContent = s.name;
  $("terminalStatus").textContent = STAGES[s.stage - 1];
  $("lastVerified").textContent = fmtTime(s.lastCheckIn);
  const target = s.stage === 1 ? s.deadline : s.stageEnd;
  $("countdown").textContent = target ? fmtCountdown(target - Date.now()) : "--:--";
}

function resetApplication() {
  if (!confirm("Delete all demo data?")) return;
  state = emptyState();
  state.loggedIn = true;
  saveState();
  renderAll();
}

/* ---------------------------------------------------------
   Init
   --------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  $("legacyFile").addEventListener("change", (e) => {
    const f = e.target.files[0];
    const box = $("filePreview");
    if (!f) return box.classList.add("hidden");
    box.textContent = f.name + " · " + Math.round(f.size / 1024) + " KB";
    box.classList.remove("hidden");
  });

  if (state.loggedIn) showApp();
});
