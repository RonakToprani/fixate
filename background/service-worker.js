// service-worker.js — the coordinator. It owns everything that must outlive the popup
// and has no camera of its own:
//   • the session lifecycle (calibrate → run → end) and its timer (chrome.alarms)
//   • the offscreen document that actually holds the camera + gaze detection
//   • site blocking (declarativeNetRequest) and leaving-Chrome detection (windows API)
//   • desktop notifications (how you hear about drifts while working with no tab open)
//   • assembling and saving the final verified record
//
// MV3 workers are ephemeral, so durable session state lives in chrome.storage.session
// (cleared when the browser closes — exactly right for "the current session"), and the
// windows.onFocusChanged listener is registered at top level so it survives respawns.
// The one exception is the live preview frame: it's kept in a module variable because it's
// large and churny; the offscreen document re-pushes it every ~160ms, so if the worker is
// respawned it simply repopulates within a frame.

import { saveSession, getPortfolio } from "../lib/storage.js";
import {
  GAZE_CATCH_LINES,
  CHROME_LOSS_LINES,
  seededLine,
} from "../lib/copy.js";

const RULE_BASE_ID = 1000;
const FOCUS_LOSS_MS = 5000;
const GAZE_NOTIFY_THROTTLE_MS = 18000; // don't fire a drift toast more than ~once / 18s
const ICON = "icons/icon128.png";

let latestFrame = null; // preview JPEG dataURL, re-pushed constantly by the offscreen doc

// ---- session state (chrome.storage.session) ---------------------------------

function sget(keys) {
  return new Promise((r) => chrome.storage.session.get(keys, r));
}
function sset(obj) {
  return new Promise((r) => chrome.storage.session.set(obj, r));
}

async function getState() {
  const s = await sget([
    "active", "phase", "startedAt", "endsAt", "durationMin",
    "awaySince", "blockedAttempts", "chromeLossEvents",
    "liveStats", "lastGazeNotifyAt", "calibWindowId", "weakCalib",
  ]);
  return {
    active: !!s.active,
    phase: s.phase || "idle",
    startedAt: s.startedAt || 0,
    endsAt: s.endsAt || 0,
    durationMin: s.durationMin || 0,
    awaySince: s.awaySince || 0,
    blockedAttempts: s.blockedAttempts || [],
    chromeLossEvents: s.chromeLossEvents || [],
    liveStats: s.liveStats || null,
    lastGazeNotifyAt: s.lastGazeNotifyAt || 0,
    calibWindowId: s.calibWindowId ?? null,
    weakCalib: !!s.weakCalib,
  };
}

// ---- offscreen document ------------------------------------------------------

const OFFSCREEN_URL = "offscreen/offscreen.html";

async function hasOffscreen() {
  if (chrome.offscreen?.hasDocument) return chrome.offscreen.hasDocument();
  // Fallback for older builds: inspect existing clients.
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  return !!(contexts && contexts.length);
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Runs local gaze detection on the webcam and plays focus cues while a session runs in the background.",
  });
}

async function closeOffscreen() {
  try {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  } catch (_) {}
}

// ---- DNR site blocking -------------------------------------------------------

function normHost(raw) {
  let h = String(raw).trim().toLowerCase();
  h = h.replace(/^https?:\/\//, "").replace(/^www\./, "");
  h = h.split("/")[0].split("?")[0];
  return h;
}

function buildRules(blocklist) {
  const rules = [];
  blocklist.forEach((raw, i) => {
    const host = normHost(raw);
    if (!host) return;
    const redirect = chrome.runtime.getURL("blocked/blocked.html") + "?site=" + encodeURIComponent(host);
    rules.push({
      id: RULE_BASE_ID + i,
      priority: 1,
      action: { type: "redirect", redirect: { url: redirect } },
      condition: { urlFilter: `||${host}`, resourceTypes: ["main_frame"] },
    });
  });
  return rules;
}

async function clearAllDynamicRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const ids = existing.map((r) => r.id).filter((id) => id >= RULE_BASE_ID);
  if (ids.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
}

async function installRules(blocklist) {
  await clearAllDynamicRules();
  const rules = buildRules(blocklist || []);
  if (rules.length) await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules });
  return rules.length;
}

// ---- notifications -----------------------------------------------------------

function notify(id, title, message, priority = 0) {
  try {
    chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL(ICON),
      title,
      message,
      priority,
      silent: false,
    });
  } catch (_) {}
}

// ---- session lifecycle -------------------------------------------------------

async function startCalibration(config) {
  // Abort any half-open prior calibration window.
  const prev = await getState();
  if (prev.calibWindowId != null) {
    try { await chrome.windows.remove(prev.calibWindowId); } catch (_) {}
  }
  await sset({ pendingConfig: config, phase: "calibrating" });

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("calib/calib.html"),
    type: "popup",
    width: 300,
    height: 320,
    focused: true,
  });
  await sset({ calibWindowId: win.id });
}

async function onCalibrated(baseline, weak) {
  const cfg = (await sget("pendingConfig")).pendingConfig || {};
  const startedAt = Date.now();
  const durationMin = cfg.durationMin || 25;
  const endsAt = startedAt + durationMin * 60000;

  await installRules(cfg.blocklist || []);
  await sset({
    active: true,
    phase: "active",
    startedAt,
    endsAt,
    durationMin,
    awaySince: 0,
    blockedAttempts: [],
    chromeLossEvents: [],
    liveStats: { focusPct: 100, gazeCount: 0 },
    weakCalib: !!weak,
    calibWindowId: null,
  });

  // Persist the start params BEFORE creating the offscreen doc so it can self-start on load
  // (no message race). The message below is a redundant backup; start() is idempotent.
  await sset({ ofxStart: { baseline, soundOn: cfg.sound !== false } });
  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: "OFX_START", baseline, soundOn: cfg.sound !== false }).catch(() => {});

  // End-of-session alarm. Alarms survive worker respawns; the popup/float compute the
  // live countdown themselves from endsAt.
  chrome.alarms.create("sessionEnd", { when: endsAt });
}

async function onCalibFailed(message) {
  await sset({ phase: "idle", active: false, calibWindowId: null });
  await chrome.storage.session.remove("pendingConfig");
  if (message === "camera-denied") {
    notify("fx-cam", "Fixate needs the camera", "Focus can't be verified without it. Nothing is recorded or uploaded.", 2);
  } else {
    notify("fx-calib", "Calibration didn't take", "Check your lighting and try starting again.", 1);
  }
}

async function endSession(completed, reason) {
  const st = await getState();
  if (!st.active && st.phase !== "active") return null;

  // Stop the offscreen detector and collect its final tally (events + focus %).
  let tally = null;
  try {
    const res = await chrome.runtime.sendMessage({ type: "OFX_STOP" });
    tally = res?.tally || null;
  } catch (_) {}

  const saved = await assembleAndSave(tally, { completed, reason });

  await closeOffscreen();
  await clearAllDynamicRules();
  try { await chrome.alarms.clear("sessionEnd"); } catch (_) {}
  await sset({ active: false, phase: "idle", awaySince: 0 });
  await chrome.storage.session.remove("ofxStart");
  latestFrame = null;

  if (completed) {
    const pct = saved.record.focusPct;
    notify("fx-done", "Session complete", `${pct}% focused · ${saved.record.actualMin}m verified.`, 2);
  }
  return saved;
}

async function assembleAndSave(tally, endContext) {
  const st = await getState();
  const chromeLoss = [...st.chromeLossEvents];
  if (st.awaySince) {
    const d = Date.now() - st.awaySince;
    if (d >= FOCUS_LOSS_MS) chromeLoss.push({ t: st.awaySince, durMs: d });
  }
  const startedAt = st.startedAt || Date.now();
  const endedAt = Date.now();
  const actualMin = Math.round(((endedAt - startedAt) / 60000) * 10) / 10;

  const record = {
    id: String(startedAt),
    startedAt,
    endedAt,
    plannedMin: st.durationMin,
    actualMin,
    completed: endContext.completed,
    endedEarly: !endContext.completed,
    cancelReason: endContext.reason || null,
    focusPct: tally?.focusPct ?? st.liveStats?.focusPct ?? 100,
    gazeDriftEvents: tally?.gazeDriftEvents || [],
    chromeLossEvents: chromeLoss,
    blockedAttempts: st.blockedAttempts || [],
  };

  await saveSession(record);
  const portfolio = await getPortfolio();
  await chrome.storage.local.set({ fx_lastReport: { record, portfolio, at: endedAt } });
  return { record, portfolio };
}

// ---- live view for the dashboard(s) -----------------------------------------

async function buildView() {
  const st = await getState();
  return {
    active: st.active,
    phase: st.phase,
    startedAt: st.startedAt,
    endsAt: st.endsAt,
    durationMin: st.durationMin,
    weakCalib: st.weakCalib,
    focusPct: st.liveStats?.focusPct ?? 100,
    gazeCount: st.liveStats?.gazeCount ?? 0,
    chromeLossCount: st.chromeLossEvents.length,
    blockedCount: st.blockedAttempts.length,
    blockedAttempts: st.blockedAttempts,
    frame: latestFrame,
  };
}

// ---- Chrome-focus-loss detection --------------------------------------------

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const st = await getState();
  if (!st.active) return;

  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    if (!st.awaySince) await sset({ awaySince: Date.now() });
  } else {
    if (st.awaySince) {
      const dur = Date.now() - st.awaySince;
      await sset({ awaySince: 0 });
      if (dur >= FOCUS_LOSS_MS) {
        const events = [...st.chromeLossEvents, { t: st.awaySince, durMs: dur }];
        await sset({ chromeLossEvents: events });
        notify("fx-chrome-" + events.length, "Fixate", seededLine(CHROME_LOSS_LINES, st.awaySince), 1);
      }
    }
  }
});

// ---- alarms ------------------------------------------------------------------

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sessionEnd") endSession(true, null);
});

// ---- messaging ---------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      // ---- from popup / float ----
      case "START_SESSION":
        await startCalibration(msg.config || {});
        sendResponse({ ok: true });
        break;
      case "END_SESSION": {
        const saved = await endSession(false, msg.reason || null);
        sendResponse({ ok: true, saved });
        break;
      }
      case "GET_VIEW":
        sendResponse({ ok: true, view: await buildView() });
        break;
      case "GET_LAST_REPORT": {
        const r = (await chrome.storage.local.get("fx_lastReport")).fx_lastReport || null;
        sendResponse({ ok: true, report: r });
        break;
      }
      case "OPEN_FLOAT": {
        try {
          await chrome.windows.create({
            url: chrome.runtime.getURL("float/float.html"),
            type: "popup",
            width: 340,
            height: 540,
            focused: true,
          });
        } catch (_) {}
        sendResponse({ ok: true });
        break;
      }
      case "CANCEL_CALIB": {
        const st = await getState();
        if (st.calibWindowId != null) {
          try { await chrome.windows.remove(st.calibWindowId); } catch (_) {}
        }
        await onCalibFailed("cancelled");
        sendResponse({ ok: true });
        break;
      }

      // ---- from calibration window ----
      case "CALIB_DONE":
        await onCalibrated(msg.baseline, msg.weak);
        sendResponse({ ok: true });
        break;
      case "CALIB_FAILED":
        await onCalibFailed(msg.message);
        sendResponse({ ok: true });
        break;

      // ---- from offscreen document ----
      case "OFX_LOADED":
        sendResponse({ ok: true });
        break;
      case "OFX_READY":
        sendResponse({ ok: true });
        break;
      case "OFX_FRAME":
        latestFrame = msg.frame;
        sendResponse?.({ ok: true });
        break;
      case "OFX_LIVE":
        await sset({ liveStats: msg.stats });
        sendResponse?.({ ok: true });
        break;
      case "OFX_CATCH": {
        // gaze drift caught in the background; toast it (throttled — the sound already fired).
        const st = await getState();
        await sset({ liveStats: { ...(st.liveStats || {}), gazeCount: msg.total } });
        const now = Date.now();
        if (now - st.lastGazeNotifyAt > GAZE_NOTIFY_THROTTLE_MS) {
          await sset({ lastGazeNotifyAt: now });
          notify("fx-gaze-" + msg.total, "Fixate", seededLine(GAZE_CATCH_LINES, msg.t), 1);
        }
        sendResponse?.({ ok: true });
        break;
      }
      case "OFX_ERROR":
        // camera failed inside the background doc — tear the session down cleanly.
        await closeOffscreen();
        await clearAllDynamicRules();
        try { await chrome.alarms.clear("sessionEnd"); } catch (_) {}
        await sset({ active: false, phase: "idle" });
        await chrome.storage.session.remove("ofxStart");
        latestFrame = null;
        notify(
          "fx-ofx-err",
          "Fixate stopped",
          msg.message === "camera-denied"
            ? "Camera permission was denied. Focus can't be verified."
            : "Background detection hit an error: " + msg.message,
          2
        );
        sendResponse?.({ ok: true });
        break;

      // ---- from blocked page ----
      case "BLOCKED_HIT": {
        const st = await getState();
        if (st.active) {
          const attempts = [...st.blockedAttempts, { host: msg.host, t: Date.now() }];
          await sset({ blockedAttempts: attempts });
          sendResponse({ ok: true, active: true, view: await buildView(), attemptCount: attempts.length });
        } else {
          sendResponse({ ok: true, active: false });
        }
        break;
      }

      default:
        sendResponse?.({ ok: false, error: "unknown message" });
    }
  })();
  return true; // async response
});

// Safety nets: never leave blocking rules or a stranded offscreen doc across reloads.
chrome.runtime.onInstalled.addListener(async () => {
  await clearAllDynamicRules();
  await closeOffscreen();
});
chrome.runtime.onStartup.addListener(async () => {
  await clearAllDynamicRules();
  await closeOffscreen();
});
