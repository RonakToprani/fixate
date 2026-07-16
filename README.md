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

- **Runs in the background — no tab to keep open.** You start and calibrate from the toolbar
  dropdown; the session itself runs in a hidden background document. Reopen the dropdown anytime
  for a live dashboard (timer, focus %, counters, and a preview of what the camera sees), or
  **pop out a tiny floating window**. Drifts reach you as a desktop notification + sound while
  you work.

### Honest about its limits

Fixate can tell when you look away from the screen or leave Chrome. It **cannot** see *what*
you switched to, and it **cannot** stop you closing the lid or quitting Chrome. And while a
session is running the **webcam stays on in the background** (that's the cost of verifying
focus without a visible window). The UI says all of this plainly — that honesty is the point.

---

## Install (unpacked, for development)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`fixate/`).
4. Pin the extension and click it to configure and start a session.

Starting a session opens a small centered **calibration window** ("look at the dot", ~5s) and
asks for camera permission (used locally, never uploaded). After that it runs in the background
— you can close everything and keep working.

## Project layout

```
manifest.json              MV3 manifest
background/
  service-worker.js        session coordinator: offscreen lifecycle, DNR blocking,
                           windows.onFocusChanged, timer (alarms), notifications, saved record
offscreen/                 invisible background document — owns the camera + gaze detection
calib/                     centered "look at the dot" calibration window (captures baseline)
popup/                     the dropdown: configure + start (idle), live dashboard (active), report (end)
float/                     optional tiny floating window mirroring the live dashboard
blocked/                   the redirect landing page for blocked sites
history/                   verified history, portfolio, insight, export
lib/
  gaze.js                  GazeTracker: calibration + baseline drift + head pose + hysteresis
  storage.js               sessions, portfolio, settings, insight, export (chrome.storage.local)
  copy.js                  all personality/roast copy + attribution formatting
  sound.js                 synthesized Web Audio cues (rotating, playful; no audio files)
  sharecard.js             canvas share card
  boot-guard.js            classic script: surfaces any page's startup error instead of freezing
vendor/mediapipe/          bundled MediaPipe Tasks Vision (wasm + FaceLandmarker model)
icons/                     generated target-mark icons
```

## Architecture notes

- **Why a background document.** A popup is destroyed the instant you click away, and a service
  worker has no DOM/camera — so neither can watch your gaze while you work. The detection lives in
  a Chrome **offscreen document** (reasons `USER_MEDIA` + `AUDIO_PLAYBACK`): a hidden page the
  extension keeps alive for the session. It owns the camera, runs the gaze loop, plays the catch
  sound, and pushes a small preview frame + live stats out for the dashboards.
- **Who owns what.** The **offscreen doc** does detection. The **service worker** coordinates
  everything durable: it starts/stops the offscreen doc, runs the timer (`chrome.alarms`), blocks
  sites (`declarativeNetRequest`), watches OS focus (`windows.onFocusChanged`), fires notifications,
  and assembles + saves the final record. The **popup/float** are thin views that read a live
  `view` from the worker and send commands; they can be closed without stopping anything. The
  **calibration window** owns the "look at the dot" baseline capture, then hands off.
- **Ephemeral service worker.** No durable state lives in worker module variables (except the churny
  preview frame, which the offscreen doc re-pushes ~6×/s). Session state is in `chrome.storage.session`,
  and `windows.onFocusChanged` / `alarms.onAlarm` are registered at top level so they survive respawns.
- **Messaging.** `START_SESSION` → worker opens the calibration window; `CALIB_DONE {baseline}` →
  worker spins up the offscreen doc and arms blocking + timer; `OFX_START` / `OFX_STOP` drive the
  detector (stop returns the final tally); `OFX_FRAME` / `OFX_LIVE` / `OFX_CATCH` flow from detector
  → worker; `GET_VIEW` gives popup/float/blocked the live snapshot; `END_SESSION` tears down and
  returns the saved report; `BLOCKED_HIT` counts a blocked-site attempt.

## Tuning the gaze detector

All thresholds live in `TUNING` at the top of [`lib/gaze.js`](lib/gaze.js): `EYE_DRIFT_DELTA`,
`HEAD_YAW_DEG`, `HEAD_PITCH_DEG`, the `ENTER_MS` / `EXIT_MS` hysteresis windows, and the
`BLINK_SKIP` confidence gate. Drift is always measured relative to the personal baseline captured
during calibration, so these are deltas, not absolutes.

> Note: the old live debug overlay lived in the (now removed) full-screen session tab. With
> detection moved to the invisible offscreen document there's no on-screen surface for it yet;
> re-adding a live tuning panel to the floating window (fed by extra per-frame numbers from the
> offscreen doc) is the natural next step.

## Notes for a future Web Store build

- `host_permissions` is currently broad (`*://*/*`) for a simple MVP blocklist. To publish,
  narrow it to the configured sites (or move blocking to a declarative ruleset scoped to them).
- `declarativeNetRequestFeedback` is only needed for match-debugging on unpacked builds; it can
  be dropped for release.

## Third-party

MediaPipe Tasks Vision and the FaceLandmarker model are bundled under `vendor/mediapipe/`
(Apache-2.0, © Google). They're vendored locally because MV3's CSP forbids loading remote code.
