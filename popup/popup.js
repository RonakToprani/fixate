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
import { attributionCallout } from "../lib/copy.js";
import { renderShareCard, downloadCard } from "../lib/sharecard.js";

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
  el("startBtn").disabled = true;
  el("startBtn").textContent = "Opening calibration…";
  await sw({
    type: "START_SESSION",
    config: { blocklist: enabled, durationMin, sound: el("setSound").checked, debug: el("setDebug").checked },
  });
  // The centered calibration window takes focus, which closes this popup. When the user
  // reopens the dropdown, the session will be active and the dashboard shows.
  window.close();
}

// ============ ACTIVE ============

let active = { settings: null, ended: false };

async function startActive(view) {
  show("viewActive");
  active.settings = settings;
  el("weakNote").hidden = !view.weakCalib;
  wireActive();
  renderActive(view);
  pollTimer = setInterval(pollActive, 400);
}

async function pollActive() {
  const res = await sw({ type: "GET_VIEW" }).catch(() => null);
  const view = res?.view;
  if (!view || !view.active) {
    // Session ended (timer or elsewhere) — flip to the report.
    clearInterval(pollTimer);
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
  const pct = Math.round(view.focusPct ?? 100);
  el("focusPct").textContent = pct + "%";
  el("focusPct").style.color = pct >= 90 ? "var(--good)" : pct >= 70 ? "var(--warn)" : "var(--danger)";
  el("cGaze").textContent = view.gazeCount ?? 0;
  el("cChrome").textContent = view.chromeLossCount ?? 0;
  el("cBlocked").textContent = view.blockedCount ?? 0;

  if (view.frame) {
    el("preview").src = view.frame;
    el("preview").style.opacity = "1";
    el("noPreview").hidden = true;
  } else {
    el("noPreview").hidden = false;
  }
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
  el("endTitle").textContent = record.completed ? "Session complete" : "Ended early";
  el("endFocus").textContent = Math.round(record.focusPct || 0) + "%";
  el("endDur").textContent = `${fmtHrs(record.actualMin || 0)} ${record.completed ? "locked in" : "before you stopped"}`;

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

// ============ shared ============

function openStats() {
  chrome.tabs.create({ url: chrome.runtime.getURL("history/history.html") });
}
function fmtClock(ms) {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

init();
