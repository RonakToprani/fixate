// popup.js — the dropdown, now a three-in-one surface:
//   • IDLE   → configure blocklist / length / settings and start a session
//   • ACTIVE → live dashboard (timer, focus %, camera preview, counters) for the session
//              running in the background; end it here (with friction) or pop it out
//   • END    → the report + share card, shown once after a session finishes
//
// The heavy lifting (camera, detection, blocking, timer) all lives in the background
// (service worker + offscreen document). The popup just reads a live "view" from the
// service worker and sends commands. It can be closed anytime without stopping anything.

import {
  getSettings,
  saveSettings,
  getPortfolio,
  surfaceInsight,
  DEFAULT_BLOCKLIST,
  fmtHrs,
} from "../lib/storage.js";
import { attributionCallout, GAZE_CATCH_LINES, CHROME_LOSS_LINES, rotatingLine } from "../lib/copy.js";
import { renderShareCard, downloadCard } from "../lib/sharecard.js";
import { GazeTracker, TUNING } from "../lib/gaze.js";

const el = (id) => document.getElementById(id);
const sw = (msg) => chrome.runtime.sendMessage(msg);

let settings = null;
let blocklist = []; // { host, enabled }
let durationMin = 25;
let pollTimer = 0;

async function init() {
  settings = await getSettings();
  durationMin = settings.durationMin || 25;

  const res = await sw({ type: "GET_VIEW" }).catch(() => null);
  const view = res?.view;
  if (view?.active) {
    startActive(view);
    return;
  }

  // Show the end report once, right after a session finishes.
  const rep = (await sw({ type: "GET_LAST_REPORT" }).catch(() => null))?.report;
  const seen = (await chrome.storage.local.get("fx_lastReportSeen")).fx_lastReportSeen;
  if (rep && rep.at && rep.at !== seen) {
    await chrome.storage.local.set({ fx_lastReportSeen: rep.at });
    showEnd(rep);
    return;
  }
  showIdle();
}

function show(viewId) {
  for (const v of document.querySelectorAll(".view")) v.hidden = true;
  el(viewId).hidden = false;
}

// ============ IDLE ============

function showIdle() {
  show("viewIdle");

  const enabledSet = new Set((settings.blocklist || []).map((h) => h.toLowerCase()));
  const knownArr = settings.knownSites && settings.knownSites.length ? settings.knownSites : DEFAULT_BLOCKLIST;
  const known = new Set([...knownArr, ...(settings.blocklist || [])].map((h) => h.toLowerCase()));
  blocklist = [...known].map((host) => ({ host, enabled: enabledSet.has(host) }));

  el("setSound").checked = settings.sound;
  el("setHold").checked = settings.holdToCancel;
  el("setDebug").checked = settings.debugGaze;
  for (const r of document.querySelectorAll('input[name="cancelStyle"]')) r.checked = r.value === settings.cancelStyle;
  updateCancelStyleVisibility();
  renderDuration();
  renderSites();
  renderPortfolio();
  wireIdle();
}

function renderDuration() {
  const preset = [15, 25, 50].includes(durationMin);
  for (const b of document.querySelectorAll(".dur-btn")) b.classList.toggle("active", Number(b.dataset.min) === durationMin);
  el("durCustom").value = preset ? "" : durationMin;
}

function renderSites() {
  const ul = el("sites");
  ul.innerHTML = "";
  for (const item of blocklist) {
    const li = document.createElement("li");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.enabled;
    cb.addEventListener("change", () => {
      item.enabled = cb.checked;
      updateBlockCount();
    });
    const span = document.createElement("span");
    span.className = "host";
    span.textContent = item.host;
    const rm = document.createElement("button");
    rm.className = "rm";
    rm.textContent = "×";
    rm.addEventListener("click", () => {
      blocklist = blocklist.filter((b) => b !== item);
      renderSites();
    });
    li.append(cb, span, rm);
    ul.append(li);
  }
  updateBlockCount();
}
function updateBlockCount() {
  el("blockCount").textContent = `${blocklist.filter((b) => b.enabled).length} blocked`;
}

async function renderPortfolio() {
  const p = await getPortfolio();
  el("pfVerified").textContent = fmtHrs(p.verifiedMinutes || 0);
  el("pfStreak").textContent = p.currentCleanStreak || 0;
  el("pfBest").textContent = (p.bestFocusPct || 0) + "%";
  const insight = await surfaceInsight();
  if (insight) {
    el("insight").textContent = insight;
    el("insight").hidden = false;
  }
}

function updateCancelStyleVisibility() {
  el("cancelStyleRow").style.opacity = el("setHold").checked ? "1" : "0.4";
  for (const r of document.querySelectorAll('input[name="cancelStyle"]')) r.disabled = !el("setHold").checked;
}
function currentCancelStyle() {
  const r = document.querySelector('input[name="cancelStyle"]:checked');
  return r ? r.value : "hold";
}

function wireIdle() {
  for (const b of document.querySelectorAll(".dur-btn")) {
    b.addEventListener("click", () => {
      durationMin = Number(b.dataset.min);
      renderDuration();
    });
  }
  el("durCustom").addEventListener("input", (e) => {
    const v = parseInt(e.target.value, 10);
    if (v >= 1 && v <= 240) {
      durationMin = v;
      for (const b of document.querySelectorAll(".dur-btn")) b.classList.remove("active");
    }
  });
  el("addForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = el("addInput").value.trim().toLowerCase();
    if (!raw) return;
    const host = raw.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    if (host && !blocklist.some((b) => b.host === host)) {
      blocklist.push({ host, enabled: true });
      renderSites();
    }
    el("addInput").value = "";
  });
  el("setHold").addEventListener("change", updateCancelStyleVisibility);
  el("historyBtn").addEventListener("click", openStats);
  el("startBtn").addEventListener("click", startSession);
}

async function startSession() {
  const enabled = blocklist.filter((b) => b.enabled).map((b) => b.host);
  await saveSettings({
    blocklist: enabled,
    knownSites: blocklist.map((b) => b.host),
    durationMin,
    sound: el("setSound").checked,
    holdToCancel: el("setHold").checked,
    cancelStyle: currentCancelStyle(),
    debugGaze: el("setDebug").checked,
  });
  const config = { blocklist: enabled, durationMin, sound: el("setSound").checked, debug: el("setDebug").checked };
  runCalibration(config);
}

// ============ CALIBRATE (in-dropdown) ============
// Everything happens right here in the dropdown: open the camera + model, capture a
// personal baseline over ~5s while the user looks at the dot, then hand the baseline to
// the service worker (which starts the background session) and slide into the dashboard.
// The camera stream opened here is REUSED as the live preview — no second open, no lag.

let calibTracker = null;

async function runCalibration(config) {
  show("viewCalib");
  el("calibErr").hidden = true;
  el("calibRetry").hidden = true;
  const camEl = el("calibCam");

  try {
    // Open the camera ONCE; keep the stream for the live preview after calibration.
    previewStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 400 }, facingMode: "user" },
      audio: false,
    });
    camEl.srcObject = previewStream;
    await camEl.play().catch(() => {});

    el("calibTitle").textContent = "loading…";
    calibTracker = new GazeTracker();
    await calibTracker.init(); // GPU is fine — the popup is a visible page
    calibTracker.resetCalibration();

    el("calibTitle").textContent = "look at the dot 👁️";
    const startTs = performance.now();

    const loop = () => {
      if (!calibTracker) return; // aborted (popup closing)
      const now = performance.now();
      const elapsed = now - startTs;
      const r = calibTracker.calibrateFrame(camEl, now);
      if (r.count != null) el("calibCount").textContent = `${r.count} frames`;
      el("calibTimer").textContent = Math.max(0, (TUNING.CALIB_MS - elapsed) / 1000).toFixed(1) + "s";
      if (elapsed < TUNING.CALIB_MS) {
        requestAnimationFrame(loop);
      } else {
        finishCalibration(config);
      }
    };
    requestAnimationFrame(loop);
  } catch (e) {
    calibError(e?.name === "NotAllowedError"
      ? "Camera permission is required. Allow it, then try again — nothing is recorded or uploaded."
      : "Couldn't start the camera: " + (e?.message || e), config);
  }
}

async function finishCalibration(config) {
  const res = calibTracker.finishCalibration();
  const baseline = calibTracker.baseline;
  try { calibTracker.close(); } catch (_) {}
  calibTracker = null;
  el("calibCam").srcObject = null; // stream lives on via #preview; free the calib video

  if (!res || res.frames === 0) {
    calibError("Couldn't see your face clearly. Check your lighting and centering, then try again.", config);
    return;
  }
  el("calibTitle").textContent = res.ok ? "calibrated ✓" : "calibrated (a little weak)";

  // Start the background session; the offscreen doc self-starts with this baseline.
  await sw({ type: "BEGIN_SESSION", config, baseline, weak: !res.ok });

  // Slide straight into the live dashboard in this same dropdown.
  const view = (await sw({ type: "GET_VIEW" }).catch(() => null))?.view;
  active.ended = false;
  if (view?.active) {
    startActiveReusingStream(view);
  } else {
    showIdle();
  }
}

function calibError(message, config) {
  stopPreview();
  if (calibTracker) { try { calibTracker.close(); } catch (_) {} calibTracker = null; }
  el("calibErr").textContent = message;
  el("calibErr").hidden = false;
  el("calibRetry").hidden = false;
  el("calibRetry").onclick = () => runCalibration(config);
}

// ============ ACTIVE ============

let active = { settings: null, ended: false };
let previewStream = null;

async function startActive(view, reuse = false) {
  show("viewActive");
  active.settings = settings;
  active.lastGaze = null;
  active.lastChrome = null;
  el("weakNote").hidden = !view.weakCalib;
  wireActive();
  renderActive(view);
  if (reuse && previewStream) attachPreview(previewStream);
  else openPreview();
  pollTimer = setInterval(pollActive, 500);
}
function startActiveReusingStream(view) {
  return startActive(view, true);
}

// Live camera preview is a LOCAL video stream owned by the popup — smooth and real-time,
// unlike the old polled-JPEG path that looked laggy. It's separate from the detection
// stream in the offscreen doc (Chrome shares one physical camera across both), and it's
// torn down the moment the popup closes.
function attachPreview(stream) {
  const v = el("preview");
  v.srcObject = stream;
  v.onplaying = () => { el("noPreview").hidden = true; };
  v.play().catch(() => {});
}
async function openPreview() {
  try {
    previewStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 400 }, facingMode: "user" },
      audio: false,
    });
    attachPreview(previewStream);
  } catch (_) {
    el("noPreview").textContent = "preview unavailable — session still running";
    el("noPreview").hidden = false;
  }
}
function stopPreview() {
  if (previewStream) { for (const t of previewStream.getTracks()) t.stop(); previewStream = null; }
  const v = el("preview");
  if (v) v.srcObject = null;
}
// If the dropdown closes (mid-calibration or mid-session) free the camera + model.
window.addEventListener("pagehide", () => {
  if (calibTracker) { try { calibTracker.close(); } catch (_) {} calibTracker = null; }
  stopPreview();
});

async function pollActive() {
  const res = await sw({ type: "GET_VIEW" }).catch(() => null);
  const view = res?.view;
  if (!view || !view.active) {
    // Session ended (timer or elsewhere) — flip to the report.
    clearInterval(pollTimer);
    stopPreview();
    const rep = (await sw({ type: "GET_LAST_REPORT" }).catch(() => null))?.report;
    if (rep) {
      await chrome.storage.local.set({ fx_lastReportSeen: rep.at });
      showEnd(rep);
    } else {
      showIdle();
    }
    return;
  }
  renderActive(view);
}

function renderActive(view) {
  const msLeft = Math.max(0, (view.endsAt || 0) - Date.now());
  el("timer").textContent = fmtClock(msLeft);

  // Focus %: don't show a confident number until detection has actually accumulated
  // some evaluated time. Before that, "…" is honest — a flat 100% out of the gate was
  // the misleading symptom when the detection loop wasn't even running.
  const warming = (view.evaluatedMs ?? 0) < 1500;
  if (warming) {
    el("focusPct").textContent = view.faceOk ? "··" : "—";
    el("focusPct").style.color = "var(--muted)";
    el("focusPct").title = view.faceOk ? "reading…" : "no face detected";
  } else {
    const pct = Math.round(view.focusPct ?? 100);
    el("focusPct").textContent = pct + "%";
    el("focusPct").title = "";
    el("focusPct").style.color = pct >= 90 ? "var(--good)" : pct >= 70 ? "var(--warn)" : "var(--danger)";
  }
  // Flash the dashboard when a new catch lands, so it's visibly confirmed even with the
  // dropdown open (the big on-page flash/confetti only draw on real website tabs).
  const g = view.gazeCount ?? 0, c = view.chromeLossCount ?? 0;
  if (active.lastGaze != null && g > active.lastGaze) camFlash(rotatingLine(GAZE_CATCH_LINES, g));
  else if (active.lastChrome != null && c > active.lastChrome) camFlash(rotatingLine(CHROME_LOSS_LINES, c));
  active.lastGaze = g;
  active.lastChrome = c;

  el("cGaze").textContent = g;
  el("cChrome").textContent = c;
  el("cBlocked").textContent = view.blockedCount ?? 0;
  // preview is a live local <video> now — nothing to poll for it here.
}

function camFlash(line) {
  const f = el("camFlash");
  el("camFlashLine").textContent = line;
  f.hidden = false;
  clearTimeout(active._flashT);
  // restart the animation
  f.style.animation = "none";
  void f.offsetWidth;
  f.style.animation = "";
  active._flashT = setTimeout(() => { f.hidden = true; }, 1100);
}

function wireActive() {
  el("popoutBtn").addEventListener("click", async () => {
    await sw({ type: "OPEN_FLOAT" });
    window.close();
  });
  el("endBtn").addEventListener("click", openCancelModal);
  el("cancelDismiss").addEventListener("click", closeCancelModal);
  wireHoldButton();
  el("reasonSubmit").addEventListener("click", () => {
    endSession(el("reasonInput").value.trim() || "(no reason given)");
  });
}

function openCancelModal() {
  if (!settings.holdToCancel) {
    endSession(null);
    return;
  }
  el("cancelModal").hidden = false;
  const useReason = settings.cancelStyle === "reason";
  el("reasonVariant").hidden = !useReason;
  el("holdVariant").hidden = useReason;
  if (useReason) setTimeout(() => el("reasonInput").focus(), 50);
}
function closeCancelModal() {
  el("cancelModal").hidden = true;
  if (active._resetHold) active._resetHold();
}

function wireHoldButton() {
  const btn = el("holdBtn");
  const fill = el("holdFill");
  const HOLD_MS = 2500;
  let raf = 0;
  let start = 0;
  const step = () => {
    const p = Math.min(1, (performance.now() - start) / HOLD_MS);
    fill.style.width = p * 100 + "%";
    if (p >= 1) {
      endSession("(held to quit)");
      return;
    }
    raf = requestAnimationFrame(step);
  };
  const begin = (e) => {
    e.preventDefault();
    start = performance.now();
    raf = requestAnimationFrame(step);
  };
  const cancel = () => {
    cancelAnimationFrame(raf);
    fill.style.width = "0%";
  };
  btn.addEventListener("mousedown", begin);
  btn.addEventListener("mouseup", cancel);
  btn.addEventListener("mouseleave", cancel);
  active._resetHold = cancel;
}

async function endSession(reason) {
  if (active.ended) return;
  active.ended = true;
  clearInterval(pollTimer);
  stopPreview();
  closeCancelModal();
  const res = await sw({ type: "END_SESSION", reason }).catch(() => null);
  const saved = res?.saved;
  if (saved) {
    await chrome.storage.local.set({ fx_lastReportSeen: saved.record ? String(saved.record.endedAt) : Date.now() });
    // saved uses {record, portfolio}; last-report format matches showEnd's expectation.
    showEnd({ record: saved.record, portfolio: saved.portfolio });
  } else {
    showIdle();
  }
}

// ============ END REPORT ============

function showEnd(rep) {
  show("viewEnd");
  const record = rep.record;
  const portfolio = rep.portfolio;
  el("endTitle").textContent = record.completed ? "locked in 🔒" : "ended early";
  el("endFocus").textContent = Math.round(record.focusPct || 0) + "%";
  el("endDur").textContent = `${fmtHrs(record.actualMin || 0)} ${record.completed ? "verified" : "before you stopped"}`;
  if (record.completed) popConfetti();

  const counts = {
    gazeDrifts: record.gazeDriftEvents?.length || 0,
    chromeLosses: record.chromeLossEvents?.length || 0,
    blockedAttempts: aggBlocked(record.blockedAttempts),
  };
  el("endCallout").textContent = attributionCallout(counts);
  try {
    renderShareCard(el("shareCanvas"), record, portfolio);
  } catch (_) {}

  el("downloadBtn").onclick = () => downloadCard(el("shareCanvas"), "fixate-session.png");
  el("againBtn").onclick = () => {
    settings = settings || {};
    showIdle();
  };
  el("statsBtn2").onclick = openStats;
}

function aggBlocked(attempts) {
  const byHost = {};
  for (const a of attempts || []) byHost[a.host] = (byHost[a.host] || 0) + 1;
  return Object.entries(byHost).map(([host, count]) => ({ host, count }));
}

// Little confetti burst inside the end report (the big "over your screen" one is injected
// into the active tab by the service worker on completion).
function popConfetti() {
  const box = el("endConfetti");
  if (!box) return;
  box.innerHTML = "";
  const colors = ["#9d8bff", "#6c5cff", "#5fe3aa", "#ffc06a", "#ff6b86", "#ffffff"];
  for (let i = 0; i < 44; i++) {
    const s = document.createElement("span");
    s.style.left = Math.random() * 100 + "%";
    s.style.background = colors[(Math.random() * colors.length) | 0];
    s.style.animation = `fxfall ${0.9 + Math.random() * 1.3}s ${Math.random() * 0.5}s ease-in forwards`;
    box.appendChild(s);
  }
}

// ============ shared ============

function openStats() {
  chrome.tabs.create({ url: chrome.runtime.getURL("history/history.html") });
}
function fmtClock(ms) {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

init();
