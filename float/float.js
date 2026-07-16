// float.js — the optional tiny floating window. Same live dashboard as the popup's
// active view, but as a standalone always-visible mini-window you can park in a corner.
// It reads the same "view" from the service worker and can end the session (with friction).

import { getSettings } from "../lib/storage.js";

const el = (id) => document.getElementById(id);
const sw = (msg) => chrome.runtime.sendMessage(msg);

let settings = null;
let ended = false;
let pollTimer = 0;
let resetHold = null;

async function init() {
  settings = await getSettings();
  wire();
  poll();
  pollTimer = setInterval(poll, 400);
}

async function poll() {
  const res = await sw({ type: "GET_VIEW" }).catch(() => null);
  const view = res?.view;
  if (!view || !view.active) {
    if (!ended) showIdle();
    return;
  }
  render(view);
}

function render(view) {
  el("idleMsg").hidden = true;
  el("endBtn").hidden = false;
  const msLeft = Math.max(0, (view.endsAt || 0) - Date.now());
  el("timer").textContent = fmtClock(msLeft);
  const warming = (view.evaluatedMs ?? 0) < 1500;
  if (warming) {
    el("focusPct").textContent = view.faceOk ? "…" : "no face";
    el("focusPct").style.color = "var(--muted)";
  } else {
    const pct = Math.round(view.focusPct ?? 100);
    el("focusPct").textContent = pct + "%";
    el("focusPct").style.color = pct >= 90 ? "var(--good)" : pct >= 70 ? "var(--warn)" : "var(--danger)";
  }
  el("cGaze").textContent = view.gazeCount ?? 0;
  el("cChrome").textContent = view.chromeLossCount ?? 0;
  el("cBlocked").textContent = view.blockedCount ?? 0;
  if (view.frame) {
    el("preview").src = view.frame;
    el("noPreview").hidden = true;
  } else {
    el("noPreview").hidden = false;
  }
}

function showIdle() {
  el("timer").textContent = "--:--";
  el("idleMsg").hidden = false;
  el("endBtn").hidden = true;
  el("noPreview").hidden = false;
  el("noPreview").textContent = "no session";
}

function wire() {
  el("endBtn").addEventListener("click", openCancelModal);
  el("cancelDismiss").addEventListener("click", closeCancelModal);
  wireHoldButton();
  el("reasonSubmit").addEventListener("click", () => end(el("reasonInput").value.trim() || "(no reason given)"));
}

function openCancelModal() {
  if (!settings.holdToCancel) {
    end(null);
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
  if (resetHold) resetHold();
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
      end("(held to quit)");
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
  resetHold = cancel;
}

async function end(reason) {
  if (ended) return;
  ended = true;
  clearInterval(pollTimer);
  closeCancelModal();
  await sw({ type: "END_SESSION", reason }).catch(() => {});
  el("idleMsg").textContent = "Session ended — open the Fixate dropdown for your report.";
  el("idleMsg").hidden = false;
  el("endBtn").hidden = true;
  el("noPreview").hidden = false;
  el("noPreview").textContent = "done";
  setTimeout(() => window.close(), 2500);
}

function fmtClock(ms) {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

init();
