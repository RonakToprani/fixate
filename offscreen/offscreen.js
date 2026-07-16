// offscreen.js — the invisible background worker that owns the camera and gaze
// detection while a session runs. Because MV3 popups and the service worker can't hold
// a camera (popups close, workers have no DOM), the detection lives here in a Chrome
// "offscreen document": a hidden page the extension keeps alive for the session.
//
// It receives a calibrated baseline from the calibration window (which owns the
// "look at the dot" step), runs the per-frame gaze loop, plays the catch sound locally,
// pushes live stats (focus %, face-seen) to the service worker, and reports every drift.
// The camera PREVIEW is not produced here — the dashboard/float open their own live
// <video>. It knows nothing about site blocking or Chrome-focus loss — those stay in the
// service worker. See background/service-worker.js.

import { GazeTracker } from "../lib/gaze.js";
import { playGazeCatch } from "../lib/sound.js";

const cam = document.getElementById("cam");

const S = {
  tracker: null,
  stream: null,
  running: false,
  soundOn: true,
  loopTimer: 0,
  liveTimer: 0,
  catchVariant: 0,
  faceOk: false, // is the model currently seeing a face? (for the dashboard's honesty)

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
    // CPU delegate: this document is never painted, so a GPU/WebGL context may not
    // initialize here and detection would silently produce nothing.
    await S.tracker.init({ delegate: "CPU" });
    // Reuse the baseline captured during the centered calibration step.
    S.tracker.baseline = baseline;

    S.running = true;
    S.lastEvalTs = performance.now();
    send({ type: "OFX_READY" });

    // IMPORTANT: drive the detection loop with a timer, NOT requestAnimationFrame.
    // An offscreen document is never rendered, so its rAF callbacks never fire — that's
    // what froze focus at a default 100% before. Timers keep running in the background.
    // 10fps is plenty for gaze/drift and keeps CPU-delegate inference from pegging a core
    // (which is what made the whole UI laggy at 25fps).
    S.loopTimer = setInterval(loopOnce, 100);
    S.liveTimer = setInterval(pushLive, 700);
    // Note: no JPEG preview stream anymore. The dashboard/float show a live local <video>
    // from their own camera track — smooth and real-time instead of a polled image.
    pushLive();
  } catch (e) {
    send({ type: "OFX_ERROR", message: e?.name === "NotAllowedError" ? "camera-denied" : String(e?.message || e) });
  }
}

function loopOnce() {
  if (!S.running) return;
  if (cam.readyState < 2) return; // wait until the video actually has frame data
  const now = performance.now();
  let r;
  try {
    r = S.tracker.process(cam, now);
  } catch (_) {
    return; // a transient decode hiccup shouldn't kill the loop
  }
  accountFocus(r, now);
  if (r && r.justCaught) onDrift();
}

function accountFocus(r, now) {
  const dt = now - S.lastEvalTs;
  S.lastEvalTs = now;
  if (!r || r.state === "skip") return;

  // Track whether the model can currently see a face (for the dashboard's honesty).
  // Check the reason first: a no-face frame can now be reported as "drifting".
  if (r.reason === "no-face") S.faceOk = false;
  else if (r.state === "focused" || r.state === "drifting" || r.reason === "blink") S.faceOk = true;

  if (r.state === "unknown") return;
  if (dt <= 0) return;
  // Clamp the per-frame contribution instead of dropping large gaps: background timer
  // throttling can space frames out, and dropping them would keep evaluatedMs at 0
  // (the old bug's second half). Clamping still credits time without over-counting a stall.
  S.evaluatedMs += Math.min(dt, 500);
  if (r.state === "focused") S.focusedMs += Math.min(dt, 500);
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

function pushLive() {
  if (!S.running) return;
  send({
    type: "OFX_LIVE",
    stats: {
      focusPct: Math.round(currentFocusPct()),
      evaluatedMs: S.evaluatedMs,
      gazeCount: S.gazeDriftEvents.length,
      faceOk: S.faceOk,
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
  clearInterval(S.loopTimer);
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
