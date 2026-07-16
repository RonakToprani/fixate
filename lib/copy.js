// copy.js — all user-facing personality lives here so it's easy to tune.
// Keep lines short, varied, and lightly roasting — never mean, never shaming.

// Shown the moment a gaze drift is caught (flash overlay).
export const GAZE_CATCH_LINES = [
  "eyes back here.",
  "the screen missed you.",
  "and where did we go?",
  "nice view over there?",
  "focus lives on this screen.",
  "caught. back to it.",
  "that wall isn't due today.",
  "wandering eyes, wandering grade.",
  "reeling you back in.",
  "the work is this way.",
];

// Shown when Chrome loses OS focus for >5s (you left the browser entirely).
export const CHROME_LOSS_LINES = [
  "left the building, huh?",
  "your phone can wait.",
  "we noticed you leave.",
  "back so soon? good.",
  "whatever that was — this matters more.",
  "the group chat will survive without you.",
];

// Shown on the blocked-site redirect page.
export const BLOCKED_LINES = [
  "nice try.",
  "not today.",
  "that site isn't going anywhere.",
  "we both know why you're here.",
  "the doomscroll can wait.",
  "closed for maintenance (your focus).",
];

// Pull a stable-but-varied line: cycles by index so a single session doesn't repeat
// the same line twice in a row, and different sessions start at different points.
export function rotatingLine(pool, index) {
  if (!pool.length) return "";
  return pool[Math.abs(index) % pool.length];
}

// A random-ish line without needing Math.random at module scope (seed by a number).
export function seededLine(pool, seed) {
  if (!pool.length) return "";
  const i = Math.floor(Math.abs(Math.sin(seed) * 10000)) % pool.length;
  return pool[i];
}

// Build the specific, slightly-funny attribution callout for the end report / share card.
// counts = { gazeDrifts, chromeLosses, blockedAttempts: [{host,count}] }
export function attributionCallout(counts) {
  const parts = [];
  const g = counts.gazeDrifts || 0;
  const c = counts.chromeLosses || 0;
  const blocked = counts.blockedAttempts || [];

  if (g > 0) parts.push(`${g} gaze drift${g === 1 ? "" : "s"}`);
  if (c > 0) parts.push(`left Chrome ${c === 1 ? "once" : c === 2 ? "twice" : `${c} times`}`);

  if (blocked.length) {
    // Name the single most-attempted site for specificity, e.g. "tried instagram.com twice".
    const top = [...blocked].sort((a, b) => b.count - a.count)[0];
    const n = top.count;
    parts.push(`tried ${top.host} ${n === 1 ? "once" : n === 2 ? "twice" : `${n} times`}`);
  }

  if (!parts.length) return "clean run — not a single slip.";
  return parts.join(", ") + ".";
}

// Short, punchy version for the share card (one line, no more than ~2 clauses).
export function shareCallout(counts, focusPct) {
  if (focusPct >= 98 && (counts.gazeDrifts || 0) === 0 && (counts.chromeLosses || 0) === 0) {
    return "locked in the entire time. no notes.";
  }
  const parts = [];
  if (counts.gazeDrifts) parts.push(`${counts.gazeDrifts} drift${counts.gazeDrifts === 1 ? "" : "s"}`);
  if (counts.chromeLosses) parts.push(`bailed ${counts.chromeLosses}x`);
  const blocked = counts.blockedAttempts || [];
  if (blocked.length) {
    const total = blocked.reduce((s, b) => s + b.count, 0);
    parts.push(`${total} blocked`);
  }
  if (!parts.length) return "focused, verified, done.";
  return "survived " + parts.join(" · ");
}
