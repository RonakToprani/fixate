// blocked.js — the redirect landing page for a blocked site. It reports the attempt to
// the service worker (which counts it) and shows the live session timer + focus %, turning
// a dead-end into an on-brand nudge.

import { BLOCKED_LINES, seededLine } from "../lib/copy.js";
import { fmtHrs } from "../lib/storage.js";

const params = new URLSearchParams(location.search);
const site = params.get("site") || "a distraction";
document.getElementById("site").textContent = site;

const seed = [...site].reduce((a, c) => a + c.charCodeAt(0), 0) + Date.now() / 1e7;
document.getElementById("line").textContent = seededLine(BLOCKED_LINES, seed);

function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function paint(resp) {
  const view = resp?.view;
  if (!resp || (!resp.active && !view?.active)) {
    document.getElementById("foot").textContent = "No active session — you can close this tab.";
    return;
  }
  const msLeft = Math.max(0, (view?.endsAt || 0) - Date.now());
  document.getElementById("timeLeft").textContent = fmtClock(msLeft);
  document.getElementById("focus").textContent = view?.focusPct != null ? Math.round(view.focusPct) + "%" : "—";

  const n = resp.attemptCount || view?.blockedCount || 1;
  document.getElementById("foot").textContent =
    `attempt ${n} this session · ${fmtHrs(Math.round(msLeft / 60000))} to go`;
}

// Register the hit and get the live view back.
chrome.runtime.sendMessage({ type: "BLOCKED_HIT", host: site }, (resp) => paint(resp));

// Keep the timer ticking while the page is open.
setInterval(() => {
  chrome.runtime.sendMessage({ type: "GET_VIEW" }, (resp) => paint(resp));
}, 1000);
