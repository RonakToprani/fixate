# Fixate — verified focus

A Chrome extension (MV3) that verifies you actually stayed focused during a work
session — instead of just trusting you to. It watches your gaze locally with the camera,
hard-blocks distracting sites, notices when you leave Chrome entirely, and turns the whole
thing into a shareable, accumulating record of real focus time.

Everything runs **locally**. No camera frames, blendshapes, or session data ever leave the
machine — there's no backend.

---

## What it does

- **Trustworthy gaze detection.** Calibrates a personal baseline before every session, then
  measures drift as deviation from *your* "looking at the screen," combines eye-blendshapes
  with head pose, applies hysteresis so it doesn't flicker, and skips frames it isn't sure
  about (no face / mid-blink) instead of falsely flagging them.
- **Site blocking.** Redirects a user-chosen blocklist to an on-brand "nice try" page for the
  duration of the session, using `declarativeNetRequest`.
- **Leaving-Chrome detection.** Uses `windows.onFocusChanged` to catch when you alt-tab out of
  Chrome for more than 5 seconds — tracked separately from gaze drift.
- **Friction to quit.** Ending early takes a press-and-hold or a typed reason (on by default,
  configurable), so a moment of weakness isn't one click away.
- **Specific attribution.** The end report says what actually happened — e.g. *"2 gaze drifts,
  left Chrome once, tried instagram.com twice"* — and feeds it into a share card.
- **Verified history & portfolio.** Persists every session's full event log, accumulates
  verified hours / clean streaks / bests, surfaces one pattern insight ("you drift most in the
  first few minutes"), and exports a 30-day stats summary.

### Honest about its limits

Fixate can tell when you look away from the screen or leave Chrome. It **cannot** see *what*
you switched to, and it **cannot** stop you closing the lid or quitting Chrome. The UI says so
plainly — that honesty is the point.

---

## Install (unpacked, for development)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`fixate/`).
4. Pin the extension and click it to configure and start a session.

The first session will ask for camera permission (used locally, never uploaded).

## Project layout

```
manifest.json              MV3 manifest
background/
  service-worker.js        DNR site-blocking, windows.onFocusChanged, session coordination
popup/                     configure blocklist / length / settings, launch a session
session/                   the session tab: camera, calibration, gaze loop, end report
blocked/                   the redirect landing page for blocked sites
history/                   verified history, portfolio, insight, export
lib/
  gaze.js                  GazeTracker: calibration + baseline drift + head pose + hysteresis
  storage.js               sessions, portfolio, settings, insight, export (chrome.storage.local)
  copy.js                  all personality/roast copy + attribution formatting
  sound.js                 synthesized Web Audio cues (no audio files)
  sharecard.js             canvas share card
vendor/mediapipe/          bundled MediaPipe Tasks Vision (wasm + FaceLandmarker model)
icons/                     generated target-mark icons
```

## Architecture notes

- **Who owns what.** The **session tab** owns the camera, gaze detection, the timer, and the
  final saved record. The **service worker** owns things only it can see — network blocking and
  OS-level Chrome focus. At session end the tab asks the worker for its counts and merges them.
- **Ephemeral service worker.** No durable state lives in worker module variables. Active-session
  state is kept in `chrome.storage.session`, and `windows.onFocusChanged` is registered at the top
  level so it survives worker respawns.
- **Messaging.** `SESSION_START` / `SESSION_END` / `SESSION_STATE` between tab and worker;
  `LIVE_CATCH` from worker → tab for Chrome-loss and blocked-site events; `LIVE_STATS` tab →
  worker so the blocked page can show the live timer and focus %; `BLOCKED_HIT` from the blocked
  page → worker to count attempts.

## Tuning the gaze detector

All thresholds live in `TUNING` at the top of [`lib/gaze.js`](lib/gaze.js). To tune against real
numbers, start a session with the **gaze debug overlay** enabled (a checkbox in the popup, or
add `?debug=1` to the session URL). The overlay shows live eye-drift, head yaw/pitch deviation,
the combined drift score, and the calibrated baseline, plus a drift-score bar. Watch the numbers
while you look around and adjust `EYE_DRIFT_DELTA`, `HEAD_YAW_DEG`, `HEAD_PITCH_DEG`, and the
`ENTER_MS` / `EXIT_MS` hysteresis windows.

## Notes for a future Web Store build

- `host_permissions` is currently broad (`*://*/*`) for a simple MVP blocklist. To publish,
  narrow it to the configured sites (or move blocking to a declarative ruleset scoped to them).
- `declarativeNetRequestFeedback` is only needed for match-debugging on unpacked builds; it can
  be dropped for release.

## Third-party

MediaPipe Tasks Vision and the FaceLandmarker model are bundled under `vendor/mediapipe/`
(Apache-2.0, © Google). They're vendored locally because MV3's CSP forbids loading remote code.
