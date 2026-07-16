// popup.js — configure the session, show the running portfolio, launch the session tab.

import {
  getSettings,
  saveSettings,
  getPortfolio,
  surfaceInsight,
  DEFAULT_BLOCKLIST,
  fmtHrs,
} from "../lib/storage.js";

const el = (id) => document.getElementById(id);

// Local working copy of the blocklist: { host, enabled }. "enabled" = block this session.
let blocklist = [];
let durationMin = 25;

async function init() {
  const s = await getSettings();
  durationMin = s.durationMin;

  // The full set of sites shown (knownSites) is remembered separately from which of them
  // are enabled for the next session (blocklist). First run falls back to the defaults.
  const enabledSet = new Set((s.blocklist || []).map((h) => h.toLowerCase()));
  const knownArr = s.knownSites && s.knownSites.length ? s.knownSites : DEFAULT_BLOCKLIST;
  const known = new Set([...knownArr, ...(s.blocklist || [])].map((h) => h.toLowerCase()));
  blocklist = [...known].map((host) => ({ host, enabled: enabledSet.has(host) }));

  el("setSound").checked = s.sound;
  el("setHold").checked = s.holdToCancel;
  el("setDebug").checked = s.debugGaze;
  for (const r of document.querySelectorAll('input[name="cancelStyle"]')) {
    r.checked = r.value === s.cancelStyle;
  }
  updateCancelStyleVisibility();
  renderDuration();
  renderSites();
  renderPortfolio();
  wire();
}

function renderDuration() {
  const preset = [15, 25, 50].includes(durationMin);
  for (const b of document.querySelectorAll(".dur-btn")) {
    b.classList.toggle("active", Number(b.dataset.min) === durationMin);
  }
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
    rm.title = "remove";
    rm.addEventListener("click", () => {
      blocklist = blocklist.filter((b) => b !== item);
      renderSites();
      updateBlockCount();
    });
    li.append(cb, span, rm);
    ul.append(li);
  }
  updateBlockCount();
}

function updateBlockCount() {
  const n = blocklist.filter((b) => b.enabled).length;
  el("blockCount").textContent = `${n} blocked`;
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
  for (const r of document.querySelectorAll('input[name="cancelStyle"]')) {
    r.disabled = !el("setHold").checked;
  }
}

function currentCancelStyle() {
  const r = document.querySelector('input[name="cancelStyle"]:checked');
  return r ? r.value : "hold";
}

function wire() {
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
  el("historyBtn").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("history/history.html") });
  });

  el("startBtn").addEventListener("click", startSession);
}

async function startSession() {
  const enabled = blocklist.filter((b) => b.enabled).map((b) => b.host);
  // Persist the full working list (so custom sites survive) plus settings.
  await saveSettings({
    blocklist: enabled,
    knownSites: blocklist.map((b) => b.host),
    durationMin,
    sound: el("setSound").checked,
    holdToCancel: el("setHold").checked,
    cancelStyle: currentCancelStyle(),
    debugGaze: el("setDebug").checked,
  });

  const params = new URLSearchParams();
  if (el("setDebug").checked) params.set("debug", "1");
  const url = chrome.runtime.getURL("session/session.html") + (params.toString() ? "?" + params : "");
  chrome.tabs.create({ url });
  window.close();
}

init();
