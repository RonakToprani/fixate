// session.js — orchestrates a focus session in its own tab:
//   permission → calibration → active tracking → end report + share card.
//
// The session tab owns the camera, MediaPipe gaze detection, the timer, and the final
// saved record. The service worker owns site blocking + Chrome-focus-loss; this tab asks
// it for those counts and merges them into the record. See background/service-worker.js.

import { GazeTracker, TUNING } from "../lib/gaze.js";
import {
  getSettings,
  saveSession,
  getPortfolio,
  fmtHrs,
} from "../lib/storage.js";
import {
  GAZE_CATCH_LINES,
  CHROME_LOSS_LINES,
  rotatingLine,
  attributionCallout,
} from "../lib/copy.js";
import {
  playGazeCatch,
  playChromeLoss,
  playComplete,
  playArm,
  playMilestone,
} from "../lib/sound.js";
import { renderShareCard, downloadCard } from "../lib/sharecard.js";

const el = (id) => document.getElementById(id);
const DEBUG = new URLSearchParams(location.search).get("debug") === "1";

const state = {
  settings: null,
  tracker: null,
  stream: null,
  startedAt: 0,
  durationMin: 25,
  endsAt: 0,
  raf: 0,

  // live counters
  gazeDriftEvents: [], // { t }
  chromeLossEvents: [], // { t, durMs } (mirrored from SW at end; live count via messages)
  blockedAttempts: [], // { host, t } (from SW at end)
  liveChromeLoss: 0,
  liveBlocked: 0,

  // focus accounting (time-based)
  focusedMs: 0,
  evaluatedMs: 0,
  lastEvalTs: 0,

  flashUntil: 0,
  flashIdx: 0,
  ended: false,
  milestoneShown: false,
  portfolio: null,
};

// ---- boot --------------------------------------------------------------------

async function boot() {
  state.settings = await getSettings();
  state.durationMin = state.settings.durationMin || 25;
  state.portfolio = await getPortfolio();

  wireEndUI();
  listenForServiceWorker();

  try {
    setLoad("Requesting camera…");
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    el("cam").srcObject = state.stream;
    el("previewMirror").srcObject = state.stream;
    await el("cam").play();
    await el("previewMirror").play().catch(() => {});

    setLoad("Loading the focus model…");
    state.tracker = new GazeTracker();
    await state.tracker.init();

    startCalibration();
  } catch (e) {
    showLoadError(e);
  }
}

function setLoad(msg) {
  el("loadMsg").textContent = msg;
}
function showLoadError(e) {
  const m =
    e && e.name === "NotAllowedError"
      ? "Camera permission denied. Fixate needs the camera to verify focus — nothing is recorded or uploaded."
      : "Couldn't start the camera or model: " + (e?.message || e);
  el("loadErr").textContent = m;
  el("loadErr").hidden = false;
  el("retryBtn").hidden = false;
  el("retryBtn").onclick = () => location.reload();
}

function showPhase(id) {
  for (const p of document.querySelectorAll(".phase")) p.hidden = true;
  el(id).hidden = false;
}

// ---- calibration -------------------------------------------------------------

function startCalibration() {
  showPhase("phaseCalib");
  state.tracker.resetCalibration();
  const cam = el("cam");
  const startTs = performance.now();
  el("calibWarn").hidden = true;
  el("recalibBtn").hidden = true;

  const loop = () => {
    const now = performance.now();
    const elapsed = now - startTs;
    const r = state.tracker.calibrateFrame(cam, now);
    if (r.count != null) el("calibCount").textContent = `${r.count} frames`;
    el("calibTimer").textContent = Math.max(0, (TUNING.CALIB_MS - elapsed) / 1000).toFixed(1) + "s";

    if (elapsed < TUNING.CALIB_MS) {
      requestAnimationFrame(loop);
    } else {
      const res = state.tracker.finishCalibration();
      if (!res.ok) {
        el("calibWarn").textContent =
          res.frames === 0
            ? "Couldn't see your face clearly. Check lighting and that you're centered, then re-calibrate."
            : "Calibration was a bit weak (low light or movement). It'll still work, but re-calibrating helps.";
        el("calibWarn").hidden = false;
        el("recalibBtn").hidden = false;
        el("recalibBtn").onclick = startCalibration;
        // Auto-continue after a short beat unless the user re-calibrates.
        if (res.frames > 0) setTimeout(() => { if (!el("phaseCalib").hidden) beginSession(); }, 2600);
      } else {
        if (state.settings.sound) playArm();
        beginSession();
      }
    }
  };
  requestAnimationFrame(loop);
}

// ---- active session ----------------------------------------------------------

async function beginSession() {
  showPhase("phaseActive");
  state.startedAt = Date.now();
  state.endsAt = state.startedAt + state.durationMin * 60000;
  state.lastEvalTs = performance.now();
  el("timerSub").textContent = "focus session";

  if (DEBUG) {
    el("debugPanel").hidden = false;
    el("debugCanvas").hidden = false;
    sizeDebugCanvas();
  }

  // Tell the service worker to arm site blocking + Chrome-focus-loss tracking.
  const blocklist = state.settings.blocklist || [];
  chrome.runtime.sendMessage({
    type: "SESSION_START",
    blocklist,
    durationMin: state.durationMin,
    startedAt: state.startedAt,
  });

  // 1-second housekeeping tick: timer, live-stats push, milestone check.
  state.tick = setInterval(onSecond, 1000);
  onSecond();

  // per-frame gaze loop
  const cam = el("cam");
  const frame = () => {
    if (state.ended) return;
    const now = performance.now();
    const r = state.tracker.process(cam, now);
    accountFocus(r, now);
    if (r.justCaught) onGazeDrift();
    if (DEBUG) drawDebug(r);
    updateFocusPct();
    state.raf = requestAnimationFrame(frame);
  };
  state.raf = requestAnimationFrame(frame);
}

// Time-based focus accounting: only frames the model could actually judge count toward
// the denominator. "unknown"/"skip" frames (no face, blink) are excluded, not penalized.
function accountFocus(r, now) {
  const dt = now - state.lastEvalTs;
  state.lastEvalTs = now;
  if (!r || r.state === "skip" || r.state === "unknown") return;
  if (dt <= 0 || dt > 500) return; // ignore huge gaps (tab was backgrounded)
  state.evaluatedMs += dt;
  if (r.state === "focused") state.focusedMs += dt;
}

function currentFocusPct() {
  if (state.evaluatedMs < 500) return 100;
  return Math.max(0, Math.min(100, (state.focusedMs / state.evaluatedMs) * 100));
}

function updateFocusPct() {
  const pct = Math.round(currentFocusPct());
  el("focusPct").textContent = pct + "%";
  el("focusPct").style.color = pct >= 90 ? "var(--good)" : pct >= 70 ? "var(--warn)" : "var(--danger)";
}

function onGazeDrift() {
  state.gazeDriftEvents.push({ t: Date.now() });
  el("cGaze").textContent = state.gazeDriftEvents.length;
  flash(rotatingLine(GAZE_CATCH_LINES, state.flashIdx++));
  if (state.settings.sound) playGazeCatch();
}

function flash(line) {
  el("flashLine").textContent = line;
  el("flash").hidden = false;
  state.flashUntil = performance.now() + 1400;
  clearTimeout(state._flashT);
  state._flashT = setTimeout(() => {
    if (performance.now() >= state.flashUntil) el("flash").hidden = true;
  }, 1450);
}

function onSecond() {
  const now = Date.now();
  const msLeft = Math.max(0, state.endsAt - now);
  el("timer").textContent = fmtClock(msLeft);

  // Push lightweight live stats so the blocked page can show timer + focus%.
  chrome.runtime.sendMessage({
    type: "LIVE_STATS",
    stats: { focusPct: Math.round(currentFocusPct()), msLeft, endsAt: state.endsAt },
  });

  maybeMilestone(msLeft);

  if (msLeft <= 0) completeSession();
}

// Subtle "streak on the line" acknowledgment near the end of a clean personal-best run.
function maybeMilestone(msLeft) {
  if (state.milestoneShown) return;
  if (msLeft > 60000 || msLeft <= 3000) return;
  const catchesSoFar =
    state.gazeDriftEvents.length + state.liveChromeLoss + state.liveBlocked;
  if (catchesSoFar > 0) return;
  const p = state.portfolio;
  const wouldBeStreak = (p?.currentCleanStreak || 0) + 1;
  const beatsStreak = p?.bestCleanStreak > 0 && wouldBeStreak > p.bestCleanStreak;
  const beatsFocus = currentFocusPct() >= Math.max(95, p?.bestFocusPct || 0);
  if (beatsStreak || beatsFocus) {
    const msg = beatsStreak
      ? `longest clean streak ever on the line — ${wouldBeStreak}. don't blink.`
      : "personal-best focus in reach. hold it.";
    const m = el("milestone");
    m.textContent = msg;
    m.hidden = false;
    if (state.settings.sound) playMilestone();
    state.milestoneShown = true;
    setTimeout(() => (m.hidden = true), 6000);
  }
}

// ---- messages from the service worker ---------------------------------------

function listenForServiceWorker() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "LIVE_CATCH") return;
    if (msg.category === "chrome-loss") {
      state.liveChromeLoss = msg.total;
      el("cChrome").textContent = msg.total;
      flash(rotatingLine(CHROME_LOSS_LINES, state.flashIdx++));
      if (state.settings.sound) playChromeLoss();
    } else if (msg.category === "blocked") {
      state.liveBlocked = msg.total;
      el("cBlocked").textContent = msg.total;
    }
  });
}

// ---- ending ------------------------------------------------------------------

function wireEndUI() {
  el("endBtn").addEventListener("click", openCancelModal);
  el("cancelDismiss").addEventListener("click", closeCancelModal);
  el("downloadBtn").addEventListener("click", () =>
    downloadCard(el("shareCanvas"), "fixate-session.png")
  );
  el("againBtn").addEventListener("click", () => location.reload());
  el("statsBtn").addEventListener("click", () =>
    chrome.tabs.create({ url: chrome.runtime.getURL("history/history.html") })
  );
  wireHoldButton();
  el("reasonSubmit").addEventListener("click", () => {
    const reason = el("reasonInput").value.trim();
    endSession(false, reason || "(no reason given)");
  });
}

function openCancelModal() {
  if (!state.settings.holdToCancel) {
    endSession(false, null); // friction disabled — one click ends it
    return;
  }
  el("cancelModal").hidden = false;
  const useReason = state.settings.cancelStyle === "reason";
  el("reasonVariant").hidden = !useReason;
  el("holdVariant").hidden = useReason;
  if (useReason) setTimeout(() => el("reasonInput").focus(), 50);
}
function closeCancelModal() {
  el("cancelModal").hidden = true;
  resetHold();
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
      endSession(false, "(held to quit)");
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
  btn.addEventListener("touchstart", begin, { passive: false });
  btn.addEventListener("mouseup", cancel);
  btn.addEventListener("mouseleave", cancel);
  btn.addEventListener("touchend", cancel);
  state._resetHold = cancel;
}
function resetHold() {
  if (state._resetHold) state._resetHold();
}

function completeSession() {
  if (state.ended) return;
  if (state.settings.sound) playComplete();
  endSession(true, null);
}

async function endSession(completed, cancelReason) {
  if (state.ended) return;
  state.ended = true;
  cancelAnimationFrame(state.raf);
  clearInterval(state.tick);
  closeCancelModal();

  // Ask the service worker to tear down blocking and hand back what only it saw.
  let report = { chromeLossEvents: [], blockedAttempts: [] };
  try {
    const res = await chrome.runtime.sendMessage({ type: "SESSION_END" });
    if (res?.report) report = res.report;
  } catch (_) {}
  state.chromeLossEvents = report.chromeLossEvents || [];
  state.blockedAttempts = report.blockedAttempts || [];

  const endedAt = Date.now();
  const actualMin = Math.round(((endedAt - state.startedAt) / 60000) * 10) / 10;
  const focusPct = Math.round(currentFocusPct());

  const record = {
    id: `${state.startedAt}`,
    startedAt: state.startedAt,
    endedAt,
    plannedMin: state.durationMin,
    actualMin,
    completed,
    endedEarly: !completed,
    cancelReason: cancelReason || null,
    focusPct,
    gazeDriftEvents: state.gazeDriftEvents,
    chromeLossEvents: state.chromeLossEvents,
    blockedAttempts: state.blockedAttempts,
  };

  await saveSession(record);
  stopCamera();
  showEndReport(record);
}

function stopCamera() {
  state.tracker?.close();
  if (state.stream) for (const t of state.stream.getTracks()) t.stop();
}

async function showEndReport(record) {
  showPhase("phaseEnd");
  el("endTitle").textContent = record.completed ? "Session complete" : "Ended early";
  el("endFocus").textContent = record.focusPct + "%";
  el("endDur").textContent = `${fmtHrs(record.actualMin)} ${record.completed ? "locked in" : "before you stopped"}`;

  const counts = {
    gazeDrifts: record.gazeDriftEvents.length,
    chromeLosses: record.chromeLossEvents.length,
    blockedAttempts: aggBlocked(record.blockedAttempts),
  };
  el("endCallout").textContent = attributionCallout(counts);

  const portfolio = await getPortfolio(); // freshly recomputed inside saveSession
  renderShareCard(el("shareCanvas"), record, portfolio);
}

function aggBlocked(attempts) {
  const byHost = {};
  for (const a of attempts || []) byHost[a.host] = (byHost[a.host] || 0) + 1;
  return Object.entries(byHost).map(([host, count]) => ({ host, count }));
}

// ---- debug overlay -----------------------------------------------------------

function sizeDebugCanvas() {
  const c = el("debugCanvas");
  const wrap = c.parentElement.getBoundingClientRect();
  c.width = wrap.width;
  c.height = wrap.height;
}

function drawDebug(r) {
  el("debugPanel").textContent = formatDebug(r);
  const c = el("debugCanvas");
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  if (!r || !r.raw) return;
  // Draw a drift-score bar at the bottom.
  const score = Math.min(2, r.driftScore || 0);
  const w = (score / 2) * c.width;
  ctx.fillStyle = r.state === "drifting" ? "rgba(255,107,125,0.85)" : "rgba(87,214,160,0.7)";
  ctx.fillRect(0, c.height - 8, w, 8);
  // threshold marker at score = 1
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.fillRect(c.width / 2 - 1, c.height - 12, 2, 12);
}

function formatDebug(r) {
  if (!r) return "…";
  if (r.state === "skip") return "…";
  const b = state.tracker.baseline || {};
  const lines = [
    `state:      ${r.state}${r.reason ? "  (" + r.reason + ")" : ""}`,
    `eyeDrift:   ${fmt(r.eyeDrift)}  / thr ${TUNING.EYE_DRIFT_DELTA}`,
    `yawDev:     ${fmt(r.headYawDev)}°  / thr ${TUNING.HEAD_YAW_DEG}°`,
    `pitchDev:   ${fmt(r.headPitchDev)}° / thr ${TUNING.HEAD_PITCH_DEG}°`,
    `driftScore: ${fmt(r.driftScore)}  (fires > 1.0, sustained ${TUNING.ENTER_MS}ms)`,
    `eyesAway:   ${r.eyesAway}   headAway: ${r.headAway}`,
    `baseline:   h=${fmt(b.horiz)} v=${fmt(b.vert)} yaw=${fmt(b.yaw)} pitch=${fmt(b.pitch)}`,
    `focus:      ${Math.round(currentFocusPct())}%  (evaluated ${(state.evaluatedMs / 1000) | 0}s)`,
  ];
  return lines.join("\n");
}
const fmt = (n) => (n == null ? "—" : Number(n).toFixed(3));

function fmtClock(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

// Guard: if the tab is closed mid-session, try to tear down blocking rules.
window.addEventListener("beforeunload", () => {
  if (!state.ended) {
    try {
      chrome.runtime.sendMessage({ type: "SESSION_END" });
    } catch (_) {}
  }
});

boot().catch(showLoadError);
