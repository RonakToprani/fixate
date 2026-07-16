// calib.js — the "look at the dot" calibration window. It self-centers on screen (so the
// baseline is captured while looking at screen-center, where work happens — not at the
// top-right dropdown), opens the camera, captures a personal baseline over ~5s, hands the
// baseline to the service worker, and closes. The background session takes over from there.

import { GazeTracker, TUNING } from "../lib/gaze.js";

const $ = (id) => document.getElementById(id);
let tracker = null;
let stream = null;
let done = false;

// Center this little window on the display.
function selfCenter() {
  try {
    const w = 300, h = 320;
    const x = Math.max(0, Math.round((screen.availWidth - w) / 2));
    const y = Math.max(0, Math.round((screen.availHeight - h) / 2));
    window.resizeTo(w, h);
    window.moveTo(x, y);
  } catch (_) {}
}

function fail(message) {
  if (done) return;
  done = true;
  $("title").textContent = "Calibration failed";
  $("err").textContent =
    message === "camera-denied"
      ? "Camera permission is required to verify focus. Allow it and try again — nothing is recorded or uploaded."
      : "Couldn't start calibration: " + message;
  $("err").hidden = false;
  $("closeBtn").hidden = false;
  $("closeBtn").onclick = () => window.close();
  cleanup();
  try {
    chrome.runtime.sendMessage({ type: "CALIB_FAILED", message });
  } catch (_) {}
}

function cleanup() {
  try {
    tracker?.close();
  } catch (_) {}
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null;
}

async function boot() {
  selfCenter();
  const cfg = await getPending();
  const cam = $("cam");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    cam.srcObject = stream;
    await cam.play();

    tracker = new GazeTracker();
    await tracker.init();

    // Give the camera a beat to settle exposure, then capture.
    $("title").textContent = "Look at the dot";
    tracker.resetCalibration();
    const startTs = performance.now();

    const loop = () => {
      if (done) return;
      const now = performance.now();
      const elapsed = now - startTs;
      const r = tracker.calibrateFrame(cam, now);
      if (r.count != null) $("count").textContent = `${r.count} frames`;
      $("timer").textContent = Math.max(0, (TUNING.CALIB_MS - elapsed) / 1000).toFixed(1) + "s";

      if (elapsed < TUNING.CALIB_MS) {
        requestAnimationFrame(loop);
      } else {
        finish();
      }
    };
    requestAnimationFrame(loop);
  } catch (e) {
    fail(e?.name === "NotAllowedError" ? "camera-denied" : String(e?.message || e));
  }
}

function finish() {
  if (done) return;
  const res = tracker.finishCalibration();
  const baseline = tracker.baseline;
  cleanup();
  done = true;

  if (res.frames === 0) {
    // No usable frames — treat as a soft failure so we don't run with a bad baseline.
    fail("no-face");
    return;
  }
  $("title").textContent = "Calibrated";
  $("sub").textContent = res.ok ? "Locking in…" : "Calibrated (a little weak) — locking in…";
  try {
    chrome.runtime.sendMessage({ type: "CALIB_DONE", baseline, weak: !res.ok });
  } catch (_) {}
  // Close shortly after so the "Calibrated" state is visible for a beat.
  setTimeout(() => window.close(), 650);
}

function getPending() {
  return new Promise((resolve) => {
    try {
      chrome.storage.session.get("pendingConfig", (r) => resolve(r.pendingConfig || {}));
    } catch (_) {
      resolve({});
    }
  });
}

boot();
