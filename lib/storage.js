// storage.js — the single source of truth for persisted state in chrome.storage.local.
// Everything here is local-only (no backend yet). Two big ideas live here:
//   1. A per-session record with the full event log (not just aggregates), so we can
//      compute pattern insights later ("you drift most in the first 10 minutes").
//   2. A rolling portfolio (verified hours, streaks, bests) that accumulates as evidence
//      of effort over weeks — the retention lever.

const K_SESSIONS = "fx_sessions"; // array of session records
const K_SETTINGS = "fx_settings"; // user settings
const K_PORTFOLIO = "fx_portfolio"; // rolling aggregates

export const DEFAULT_BLOCKLIST = [
  "instagram.com",
  "tiktok.com",
  "youtube.com",
  "reddit.com",
  "x.com",
  "twitter.com",
  "netflix.com",
];

export const DEFAULT_SETTINGS = {
  blocklist: [...DEFAULT_BLOCKLIST],
  durationMin: 25,
  sound: true,
  holdToCancel: true, // friction on by default — targets the "too easy to quit" complaint
  cancelStyle: "hold", // "hold" | "reason"
  debugGaze: false,
};

function get(key, fallback) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (r) => resolve(r[key] === undefined ? fallback : r[key]));
  });
}

function set(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

// ---- settings ----------------------------------------------------------------

export async function getSettings() {
  const s = await get(K_SETTINGS, {});
  return { ...DEFAULT_SETTINGS, ...s };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await set(K_SETTINGS, next);
  return next;
}

// ---- sessions ----------------------------------------------------------------

export async function getSessions() {
  return get(K_SESSIONS, []);
}

// record = {
//   id, startedAt, endedAt, plannedMin, actualMin, completed (bool),
//   focusPct, gazeDriftEvents: [{ t }], chromeLossEvents: [{ t, durMs }],
//   blockedAttempts: [{ host, t }], endedEarly (bool), cancelReason (string|null)
// }
export async function saveSession(record) {
  const sessions = await getSessions();
  sessions.push(record);
  // Cap stored history to keep storage bounded; keep the most recent 500.
  const trimmed = sessions.slice(-500);
  await set(K_SESSIONS, trimmed);
  await recomputePortfolio(trimmed);
  return record;
}

// ---- portfolio ---------------------------------------------------------------

export async function getPortfolio() {
  return get(K_PORTFOLIO, emptyPortfolio());
}

function emptyPortfolio() {
  return {
    totalSessions: 0,
    verifiedMinutes: 0, // only completed sessions count as "verified"
    cleanSessions: 0, // zero catches of any kind
    currentCleanStreak: 0, // consecutive completed sessions with zero catches
    bestCleanStreak: 0,
    bestFocusPct: 0,
    bestSessionId: null,
  };
}

// Derive the portfolio deterministically from the session list. Idempotent — safe to
// recompute at any time (e.g. after import or a bad write).
export async function recomputePortfolio(sessions) {
  const s = sessions || (await getSessions());
  const p = emptyPortfolio();
  let streak = 0;

  for (const rec of s) {
    p.totalSessions += 1;
    if (rec.completed) p.verifiedMinutes += rec.actualMin || 0;

    const catches =
      (rec.gazeDriftEvents?.length || 0) +
      (rec.chromeLossEvents?.length || 0) +
      (rec.blockedAttempts?.length || 0);

    const clean = rec.completed && catches === 0;
    if (clean) {
      p.cleanSessions += 1;
      streak += 1;
      if (streak > p.bestCleanStreak) p.bestCleanStreak = streak;
    } else if (rec.completed) {
      // Only a completed-but-not-clean session breaks a streak; abandoned ones don't count either way.
      streak = 0;
    }

    if ((rec.focusPct || 0) > p.bestFocusPct) {
      p.bestFocusPct = rec.focusPct || 0;
      p.bestSessionId = rec.id;
    }
  }
  p.currentCleanStreak = streak;
  await set(K_PORTFOLIO, p);
  return p;
}

// ---- insights ----------------------------------------------------------------

// Surface exactly ONE pattern insight once there's enough data, or null.
// Kept deliberately conservative so we never assert a pattern from noise.
export async function surfaceInsight() {
  const sessions = await getSessions();
  const withData = sessions.filter((s) => s.actualMin >= 5);
  if (withData.length < 4) return null;

  // 1) When in the session do drifts cluster? Bucket every gaze drift by the fraction
  //    of the session elapsed when it happened.
  const buckets = [0, 0, 0, 0, 0]; // 5 equal buckets across the session length
  let totalDrifts = 0;
  for (const s of withData) {
    const durMs = (s.actualMin || 1) * 60000;
    for (const e of s.gazeDriftEvents || []) {
      const frac = Math.min(0.999, Math.max(0, (e.t - s.startedAt) / durMs));
      buckets[Math.floor(frac * 5)] += 1;
      totalDrifts += 1;
    }
  }
  if (totalDrifts >= 8) {
    const maxIdx = buckets.indexOf(Math.max(...buckets));
    const share = buckets[maxIdx] / totalDrifts;
    if (share >= 0.34) {
      const labels = [
        "the first few minutes",
        "the early-middle",
        "the middle stretch",
        "the late-middle",
        "the final minutes",
      ];
      return `You drift most in ${labels[maxIdx]} of a session.`;
    }
  }

  // 2) Best day of week by average focus %.
  const byDay = {}; // 0..6 -> {sum,count}
  for (const s of withData) {
    const d = new Date(s.startedAt).getDay();
    byDay[d] = byDay[d] || { sum: 0, count: 0 };
    byDay[d].sum += s.focusPct || 0;
    byDay[d].count += 1;
  }
  const days = Object.entries(byDay).filter(([, v]) => v.count >= 2);
  if (days.length >= 3) {
    days.sort((a, b) => b[1].sum / b[1].count - a[1].sum / a[1].count);
    const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const [dayIdx] = days[0];
    return `${names[dayIdx]} sessions are your most focused.`;
  }

  return null;
}

// ---- export ------------------------------------------------------------------

// Build a plain-text summary of the last N days for the "export my stats" feature.
export async function exportStatsText(days = 30, now = Date.now()) {
  const sessions = await getSessions();
  const cutoff = now - days * 86400000;
  const recent = sessions.filter((s) => s.startedAt >= cutoff);
  const p = await getPortfolio();

  const verifiedMin = recent.filter((s) => s.completed).reduce((sum, s) => sum + (s.actualMin || 0), 0);
  const totalDrifts = recent.reduce((n, s) => n + (s.gazeDriftEvents?.length || 0), 0);
  const totalLosses = recent.reduce((n, s) => n + (s.chromeLossEvents?.length || 0), 0);
  const totalBlocked = recent.reduce((n, s) => n + (s.blockedAttempts?.length || 0), 0);
  const avgFocus = recent.length
    ? Math.round(recent.reduce((n, s) => n + (s.focusPct || 0), 0) / recent.length)
    : 0;

  const lines = [
    `FIXATE — verified focus, last ${days} days`,
    `================================`,
    `Sessions:          ${recent.length}`,
    `Verified focus:    ${fmtHrs(verifiedMin)}  (completed sessions only)`,
    `Avg focus:         ${avgFocus}%`,
    `Gaze drifts:       ${totalDrifts}`,
    `Left Chrome:       ${totalLosses}`,
    `Blocked attempts:  ${totalBlocked}`,
    ``,
    `All-time`,
    `--------`,
    `Verified total:    ${fmtHrs(p.verifiedMinutes)}`,
    `Clean sessions:    ${p.cleanSessions}`,
    `Best clean streak: ${p.bestCleanStreak}`,
    `Best focus:        ${p.bestFocusPct}%`,
    ``,
    `Verified locally by Fixate — no self-reporting.`,
  ];
  return lines.join("\n");
}

export function fmtHrs(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}
