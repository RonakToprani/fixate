// history.js — the verified-history / portfolio view. Shows accumulated evidence of
// effort (verified hours, streaks, bests), one surfaced pattern insight, the full session
// log, and the "export my stats" actions.

import {
  getSessions,
  getPortfolio,
  surfaceInsight,
  exportStatsText,
  fmtHrs,
} from "../lib/storage.js";
import { renderShareCard, downloadCard } from "../lib/sharecard.js";

const el = (id) => document.getElementById(id);

async function init() {
  const [sessions, portfolio, insight] = await Promise.all([
    getSessions(),
    getPortfolio(),
    surfaceInsight(),
  ]);

  renderPortfolio(portfolio);
  if (insight) {
    el("insight").textContent = insight;
    el("insight").hidden = false;
  }
  renderRows(sessions);
  wire(sessions, portfolio);
}

function renderPortfolio(p) {
  const cards = [
    { num: fmtHrs(p.verifiedMinutes || 0), lbl: "verified focus" },
    { num: p.totalSessions || 0, lbl: "sessions" },
    { num: p.currentCleanStreak || 0, lbl: "clean streak" },
    { num: p.bestCleanStreak || 0, lbl: "best streak" },
    { num: (p.bestFocusPct || 0) + "%", lbl: "best focus" },
  ];
  el("portfolio").innerHTML = cards
    .map((c) => `<div class="card"><div class="num">${c.num}</div><div class="lbl">${c.lbl}</div></div>`)
    .join("");
}

function focusClass(pct) {
  return pct >= 90 ? "focus-good" : pct >= 70 ? "focus-mid" : "focus-bad";
}

function renderRows(sessions) {
  const rows = el("rows");
  if (!sessions.length) {
    el("empty").hidden = false;
    return;
  }
  const sorted = [...sessions].sort((a, b) => b.startedAt - a.startedAt);
  rows.innerHTML = sorted
    .map((s) => {
      const drifts = s.gazeDriftEvents?.length || 0;
      const losses = s.chromeLossEvents?.length || 0;
      const blocked = s.blockedAttempts?.length || 0;
      const clean = s.completed && drifts + losses + blocked === 0;
      const when = new Date(s.startedAt);
      const dateStr = when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const timeStr = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      const note = s.cancelReason
        ? escapeHtml(s.cancelReason)
        : clean
        ? '<span class="badge clean">clean</span>'
        : s.endedEarly
        ? '<span class="badge early">ended early</span>'
        : "";
      return `<tr>
        <td>${dateStr} <span class="note">${timeStr}</span></td>
        <td>${fmtHrs(s.actualMin || 0)}${s.endedEarly ? ` <span class="badge early">early</span>` : ""}</td>
        <td class="${focusClass(s.focusPct || 0)}">${Math.round(s.focusPct || 0)}%</td>
        <td>${drifts}</td>
        <td>${losses}</td>
        <td>${blocked}</td>
        <td class="note">${note}</td>
      </tr>`;
    })
    .join("");
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function wire(sessions, portfolio) {
  el("exportTxt").addEventListener("click", async () => {
    const text = await exportStatsText(30);
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "fixate-stats-30d.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });

  el("exportImg").addEventListener("click", () => {
    // Render a card from the best session (or most recent) so there's always something.
    if (!sessions.length) return;
    const best =
      sessions.find((s) => s.id === portfolio.bestSessionId) ||
      [...sessions].sort((a, b) => b.startedAt - a.startedAt)[0];
    const canvas = el("exportCanvas");
    renderShareCard(canvas, best, portfolio);
    downloadCard(canvas, "fixate-best.png");
  });
}

init();
