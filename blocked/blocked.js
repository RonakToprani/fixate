// blocked.js — the redirect landing page for a blocked site. It does two jobs:
//   1. Report the attempt to the service worker (which counts it toward the session).
//   2. Show the live session timer + focus %, turning a dead-end into an on-brand nudge.

import { BLOCKED_LINES, seededLine } from "../lib/copy.js";
import { fmtHrs } from "../lib/storage.js";

const params = new URLSearchParams(location.search);
const site = params.get("site") || "a distraction";
document.getElementById("site").textContent = site;

// Pick a line seeded by the site name so the same site is playful but not identical each time.
const seed = [...site].reduce((a, c) => a + c.charCodeAt(0), 0) + Date.now() / 1e7;
document.getElementById("line").textContent = seededLine(BLOCKED_LINES, seed);

function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function paint(resp) {
  if (!resp || !resp.active) {
    document.getElementById("foot").textContent = "No active session — you can close this tab.";
    return;
  }
  const live = resp.liveStats || {};
  const msLeft =
    live.endsAt != null
      ? Math.max(0, live.endsAt - Date.now())
      : Math.max(0, resp.startedAt + resp.durationMin * 60000 - Date.now());
  document.getElementById("timeLeft").textContent = fmtClock(msLeft);
  document.getElementById("focus").textContent =
    live.focusPct != null ? live.focusPct + "%" : "—";

  const n = resp.attemptCount || 1;
  document.getElementById("foot").textContent =
    `attempt ${n} this session · ${fmtHrs(Math.round(msLeft / 60000))} to go`;
}

// Register the hit (increments the session's blocked-attempt count) and get live stats back.
chrome.runtime.sendMessage({ type: "BLOCKED_HIT", host: site }, (resp) => {
  paint(resp);
});

// Keep the timer ticking while the page is open.
setInterval(() => {
  chrome.runtime.sendMessage({ type: "SESSION_STATE" }, (resp) => paint(resp));
}, 1000);
