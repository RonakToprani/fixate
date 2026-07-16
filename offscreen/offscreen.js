// offscreen.js — the invisible background worker that owns the camera and gaze
// detection while a session runs. Because MV3 popups and the service worker can't hold
// a camera (popups close, workers have no DOM), the detection lives here in a Chrome
// "offscreen document": a hidden page the extension keeps alive for the session.
//
// It receives a calibrated baseline from the calibration window (which owns the
// "look at the dot" step), runs the per-frame gaze loop, plays the catch sound locally,
// pushes a small preview frame + live stats to the service worker for the dashboard,
// and reports every drift. It knows nothing about site blocking or Chrome-focus loss —
// those stay in the service worker. See background/service-worker.js.

import { GazeTracker } from "../lib/gaze.js";
import { playGazeCatch } from "../lib/sound.js";

const cam = document.getElementById("cam");
const frameCanvas = document.getElementById("frameCanvas");
const fctx = frameCanvas.getContext("2d");

const S = {
  tracker: null,
  stream: null,
  running: false,
  soundOn: true,
  raf: 0,
  frameTimer: 0,
  liveTimer: 0,
  catchVariant: 0,

  // focus accounting (time-based; unknown/blink frames excluded)
  focusedMs: 0,
  evaluatedMs: 0,
  lastEvalTs: 0,

  gazeDriftEvents: [], // { t }
};

function send(msg) {
  // Fire-and-forget to the service worker. Swallow "no receiver" races.
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch (_) {}
}

// ---- lifecycle ---------------------------------------------------------------

async function start({ baseline, soundOn }) {
  if (S.running) return;
  S.soundOn = soundOn !== false;
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    cam.srcObject = S.stream;
    await cam.play();

    S.tracker = new GazeTracker();
    await S.tracker.init();
    // Reuse the baseline captured during the centered calibration step.
    S.tracker.baseline = baseline;

    S.running = true;
    S.lastEvalTs = performance.now();
    send({ type: "OFX_READY" });

    loop();
    S.frameTimer = setInterval(pushFrame, 160); // ~6fps preview to the dashboard
    S.liveTimer = setInterval(pushLive, 1000);
    pushFrame();
    pushLive();
  } catch (e) {
    send({ type: "OFX_ERROR", message: e?.name === "NotAllowedError" ? "camera-denied" : String(e?.message || e) });
  }
}

function loop() {
  if (!S.running) return;
  const now = performance.now();
  const r = S.tracker.process(cam, now);
  accountFocus(r, now);
  if (r.justCaught) onDrift();
  S.raf = requestAnimationFrame(loop);
}

function accountFocus(r, now) {
  const dt = now - S.lastEvalTs;
  S.lastEvalTs = now;
  if (!r || r.state === "skip" || r.state === "unknown") return;
  if (dt <= 0 || dt > 500) return;
  S.evaluatedMs += dt;
  if (r.state === "focused") S.focusedMs += dt;
}

function currentFocusPct() {
  if (S.evaluatedMs < 500) return 100;
  return Math.max(0, Math.min(100, (S.focusedMs / S.evaluatedMs) * 100));
}

function onDrift() {
  const t = Date.now();
  S.gazeDriftEvents.push({ t });
  if (S.soundOn) {
    try {
      playGazeCatch(S.catchVariant++);
    } catch (_) {}
  }
  send({ type: "OFX_CATCH", category: "gaze", t, total: S.gazeDriftEvents.length });
}

// Push a tiny JPEG of what the camera sees so the dashboard can show a live preview
// without opening its own camera (avoids double-open issues and keeps one source of truth).
function pushFrame() {
  if (!S.running || cam.readyState < 2) return;
  try {
    // mirror horizontally so the preview reads like a mirror
    fctx.save();
    fctx.scale(-1, 1);
    fctx.drawImage(cam, -frameCanvas.width, 0, frameCanvas.width, frameCanvas.height);
    fctx.restore();
    const frame = frameCanvas.toDataURL("image/jpeg", 0.5);
    send({ type: "OFX_FRAME", frame });
  } catch (_) {}
}

function pushLive() {
  if (!S.running) return;
  send({
    type: "OFX_LIVE",
    stats: {
      focusPct: Math.round(currentFocusPct()),
      evaluatedMs: S.evaluatedMs,
      gazeCount: S.gazeDriftEvents.length,
    },
  });
}

// Stop detection and return the final tally synchronously so the service worker can
// await it as the OFX_STOP response and assemble the saved record from it.
function stop() {
  const tally = {
    gazeDriftEvents: S.gazeDriftEvents,
    focusedMs: S.focusedMs,
    evaluatedMs: S.evaluatedMs,
    focusPct: Math.round(currentFocusPct()),
  };
  S.running = false;
  cancelAnimationFrame(S.raf);
  clearInterval(S.frameTimer);
  clearInterval(S.liveTimer);
  try {
    S.tracker?.close();
  } catch (_) {}
  if (S.stream) for (const t of S.stream.getTracks()) t.stop();
  S.stream = null;
  return tally;
}

// ---- messages from the service worker ---------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case "OFX_START":
      start({ baseline: msg.baseline, soundOn: msg.soundOn });
      sendResponse?.({ ok: true });
      break;
    case "OFX_STOP": {
      const tally = stop();
      sendResponse?.({ ok: true, tally });
      break;
    }
    case "OFX_PING":
      sendResponse?.({ ok: true, running: S.running });
      break;
    default:
      // not ours
      break;
  }
  return false;
});

// Startup handoff. The service worker writes the start params (baseline, soundOn) to
// chrome.storage.session BEFORE creating this document, so we can self-start as soon as our
// module finishes loading — avoiding a race where an OFX_START message arrives before this
// listener is registered. The OFX_START message path above still works as a backup, and
// start() is idempotent, so a double-trigger is harmless.
chrome.storage.session.get("ofxStart", (r) => {
  if (r && r.ofxStart) start(r.ofxStart);
});
send({ type: "OFX_LOADED" });
