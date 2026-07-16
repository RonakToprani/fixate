// gaze.js — trustworthy "are you looking at the screen?" detection.
//
// This is a full rework of the v0.1 approach, which used a single hardcoded blendshape
// threshold (DRIFT_BLENDSHAPE_THRESHOLD = 0.35) against zero. That was wrong for most
// people because blendshape magnitudes vary a lot by face/camera/lighting. Here we:
//
//   1. CALIBRATE a personal baseline for "looking at the screen" before every session.
//   2. Measure drift as DEVIATION FROM THAT BASELINE, not from zero.
//   3. Combine TWO signals: eye blendshapes AND head pose (from the facial transformation
//      matrix). A turned head is a stronger, more reliable "looked away" than eyes alone.
//   4. Apply HYSTERESIS: drift must be sustained to fire, and focus must be sustained to
//      clear — so borderline frames don't flicker.
//   5. CONFIDENCE-GATE: if no face is detected, or the eyes are mid-blink, we return
//      "unknown" and skip the frame rather than flashing a false catch.
//
// All tunables are in TUNING below and are visible live via the ?debug=1 overlay.

import {
  FaceLandmarker,
  FilesetResolver,
} from "../vendor/mediapipe/vision_bundle.js";

export const TUNING = {
  // Calibration
  CALIB_MS: 5000, // length of the calibration capture window
  CALIB_MIN_FRAMES: 45, // require at least this many good frames or we warn

  // Eye drift: how far the directional eye blendshapes may deviate above baseline
  // before we consider the eyes "off screen". Deviation is unitless blendshape delta.
  EYE_DRIFT_DELTA: 0.19,

  // Head pose: degrees of yaw/pitch deviation from baseline before "head turned away".
  HEAD_YAW_DEG: 16,
  HEAD_PITCH_DEG: 14,

  // Hysteresis windows
  ENTER_MS: 480, // drift must persist this long before it counts as a catch
  EXIT_MS: 320, // focus must persist this long before we clear the drift state

  // Confidence gating
  BLINK_SKIP: 0.55, // if avg eye-blink blendshape exceeds this, treat frame as unknown
  MIN_FRAME_GAP_MS: 33, // ~30fps cap; we don't need to run faster
};

// The directional eye blendshape channels we care about, grouped by axis.
const EYE_CHANNELS = {
  horiz: ["eyeLookOutLeft", "eyeLookOutRight", "eyeLookInLeft", "eyeLookInRight"],
  vert: ["eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight"],
};
const BLINK_CHANNELS = ["eyeBlinkLeft", "eyeBlinkRight"];

function avg(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
const RAD2DEG = 180 / Math.PI;

// Turn a blendshape category array into a name->score map.
function toMap(categories) {
  const m = {};
  for (const c of categories) m[c.categoryName] = c.score;
  return m;
}

// Extract approximate head Euler angles (degrees) from MediaPipe's 4x4 facial
// transformation matrix (column-major, length 16). We only need these to be *stable
// and monotonic* with head turn, because we always compare against the calibrated
// baseline — the exact axis convention doesn't have to be perfect.
function headAnglesFromMatrix(data) {
  if (!data || data.length < 16) return null;
  // column-major: element(row r, col c) = data[c*4 + r]
  const m00 = data[0], m10 = data[1], m20 = data[2];
  const m01 = data[4], m11 = data[5], m21 = data[6];
  const m02 = data[8], m12 = data[9], m22 = data[10];
  // Tait-Bryan angles. pitch about X, yaw about Y, roll about Z.
  const pitch = Math.asin(clamp(-m12, -1, 1)) * RAD2DEG;
  const yaw = Math.atan2(m02, m22) * RAD2DEG;
  const roll = Math.atan2(m10, m11) * RAD2DEG;
  return { yaw, pitch, roll };
}

export class GazeTracker {
  constructor(opts = {}) {
    this.landmarker = null;
    this.baseline = null; // set by finishCalibration()
    this._calibSamples = []; // { horiz, vert, yaw, pitch }
    this._lastTs = 0;

    // hysteresis state
    this._drifting = false;
    this._driftStart = null;
    this._focusStart = null;

    this.tuning = { ...TUNING, ...(opts.tuning || {}) };
  }

  // opts.delegate: "GPU" (default) or "CPU". Use CPU inside an offscreen document — it's
  // never painted, so a WebGL/GPU context may not initialize there and detection would
  // silently produce nothing. CPU face-landmark inference is plenty fast at our frame rate.
  async init(opts = {}) {
    const delegate = opts.delegate || "GPU";
    // Resolve the WASM fileset from our local vendor copy (MV3 forbids remote code).
    const fileset = await FilesetResolver.forVisionTasks(
      chrome.runtime.getURL("vendor/mediapipe/wasm")
    );
    this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: chrome.runtime.getURL("vendor/mediapipe/face_landmarker.task"),
        delegate,
      },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
    return this;
  }

  // Run the model on one video frame. Returns the raw parsed signal or null if no face.
  _detect(video, tsMs) {
    const res = this.landmarker.detectForVideo(video, tsMs);
    const hasFace =
      res && res.faceBlendshapes && res.faceBlendshapes.length > 0 && res.faceLandmarks.length > 0;
    if (!hasFace) return { face: false };

    const bs = toMap(res.faceBlendshapes[0].categories);
    const blink = avg(BLINK_CHANNELS.map((c) => bs[c] || 0));

    // Per-axis "how far are the eyes pushed in any direction", as raw blendshape energy.
    const horiz = avg(EYE_CHANNELS.horiz.map((c) => bs[c] || 0));
    const vert = avg(EYE_CHANNELS.vert.map((c) => bs[c] || 0));

    const matrix = res.facialTransformationMatrixes?.[0]?.data;
    const head = headAnglesFromMatrix(matrix) || { yaw: 0, pitch: 0, roll: 0 };

    return { face: true, blink, horiz, vert, yaw: head.yaw, pitch: head.pitch, roll: head.roll };
  }

  // ---- calibration ----------------------------------------------------------

  // Call once per frame during the calibration window. Returns { captured, blink }.
  calibrateFrame(video, tsMs) {
    if (tsMs - this._lastTs < this.tuning.MIN_FRAME_GAP_MS) return { captured: false };
    this._lastTs = tsMs;
    const s = this._detect(video, tsMs);
    if (!s.face) return { captured: false, reason: "no-face" };
    if (s.blink > this.tuning.BLINK_SKIP) return { captured: false, reason: "blink" };
    this._calibSamples.push({ horiz: s.horiz, vert: s.vert, yaw: s.yaw, pitch: s.pitch });
    return { captured: true, count: this._calibSamples.length };
  }

  // Average the captured samples into a personal baseline. Returns { ok, frames }.
  finishCalibration() {
    const n = this._calibSamples.length;
    if (n === 0) {
      // No good frames — fall back to a permissive zero baseline so we never hard-fail,
      // but flag it so the UI can warn and the tracker stays conservative.
      this.baseline = { horiz: 0, vert: 0, yaw: 0, pitch: 0, weak: true, frames: 0 };
      return { ok: false, frames: 0 };
    }
    this.baseline = {
      horiz: avg(this._calibSamples.map((s) => s.horiz)),
      vert: avg(this._calibSamples.map((s) => s.vert)),
      yaw: avg(this._calibSamples.map((s) => s.yaw)),
      pitch: avg(this._calibSamples.map((s) => s.pitch)),
      weak: n < this.tuning.CALIB_MIN_FRAMES,
      frames: n,
    };
    this._calibSamples = [];
    return { ok: !this.baseline.weak, frames: n };
  }

  resetCalibration() {
    this._calibSamples = [];
    this.baseline = null;
  }

  // ---- per-frame drift ------------------------------------------------------

  // Evaluate one frame during a live session. Returns a rich object:
  // {
  //   state: "focused" | "drifting" | "unknown",
  //   focused: bool, justCaught: bool,
  //   eyeDrift, headYawDev, headPitchDev, driftScore, // for debug overlay
  //   raw: {...}
  // }
  process(video, tsMs) {
    if (tsMs - this._lastTs < this.tuning.MIN_FRAME_GAP_MS) {
      return { state: "skip" };
    }
    this._lastTs = tsMs;

    if (!this.baseline) return { state: "unknown", reason: "no-baseline" };

    const s = this._detect(video, tsMs);

    // Confidence gate 1: no face -> unknown, and we do NOT let hysteresis progress.
    if (!s.face) {
      this._resetTransitionTimers();
      return { state: "unknown", reason: "no-face", focused: !this._drifting };
    }
    // Confidence gate 2: mid-blink -> unknown. Blinks spike directional channels; skipping
    // them is the single biggest false-positive fix for "normal blinking/typing posture".
    if (s.blink > this.tuning.BLINK_SKIP) {
      return { state: "unknown", reason: "blink", focused: !this._drifting, raw: s };
    }

    // Drift magnitudes, all relative to the personal baseline.
    const eyeH = Math.max(0, s.horiz - this.baseline.horiz);
    const eyeV = Math.max(0, s.vert - this.baseline.vert);
    const eyeDrift = Math.hypot(eyeH, eyeV);
    const yawDev = Math.abs(s.yaw - this.baseline.yaw);
    const pitchDev = Math.abs(s.pitch - this.baseline.pitch);

    const eyesAway = eyeDrift > this.tuning.EYE_DRIFT_DELTA;
    const headAway = yawDev > this.tuning.HEAD_YAW_DEG || pitchDev > this.tuning.HEAD_PITCH_DEG;
    const away = eyesAway || headAway;

    // A single 0..~2 debug score: how far past threshold, summed across signals.
    const driftScore =
      eyeDrift / this.tuning.EYE_DRIFT_DELTA +
      Math.max(yawDev / this.tuning.HEAD_YAW_DEG, pitchDev / this.tuning.HEAD_PITCH_DEG);

    const justCaught = this._applyHysteresis(away, tsMs);

    return {
      state: this._drifting ? "drifting" : "focused",
      focused: !this._drifting,
      justCaught,
      eyeDrift,
      headYawDev: yawDev,
      headPitchDev: pitchDev,
      eyesAway,
      headAway,
      driftScore,
      raw: s,
    };
  }

  _resetTransitionTimers() {
    // Called on "unknown" frames so a gap in detection doesn't accumulate toward a catch.
    this._driftStart = null;
    // Note: we deliberately do NOT reset _focusStart here — a face-detection dropout while
    // already drifting shouldn't instantly clear the flash either. Leaving it null-safe.
  }

  // State machine. Returns true only on the frame we newly enter the "drifting" state.
  _applyHysteresis(away, tsMs) {
    if (away) {
      this._focusStart = null;
      if (!this._drifting) {
        if (this._driftStart == null) this._driftStart = tsMs;
        if (tsMs - this._driftStart >= this.tuning.ENTER_MS) {
          this._drifting = true;
          this._driftStart = null;
          return true; // new catch
        }
      }
    } else {
      this._driftStart = null;
      if (this._drifting) {
        if (this._focusStart == null) this._focusStart = tsMs;
        if (tsMs - this._focusStart >= this.tuning.EXIT_MS) {
          this._drifting = false;
          this._focusStart = null;
        }
      }
    }
    return false;
  }

  close() {
    try {
      this.landmarker?.close();
    } catch (_) {}
    this.landmarker = null;
  }
}
