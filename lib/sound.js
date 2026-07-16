// sound.js — small Web Audio cue engine. No audio files needed; everything is
// synthesized so it stays crisp at any volume and adds nothing to the bundle.
//
// Design goal: short, distinct, non-annoying. The "catch" cue should register
// without making the user jump. Sounds are intentionally < 250ms.

let ctx = null;

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
  }
  // Autoplay policy: context may start suspended until a user gesture resumes it.
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

// One shaped tone. gain envelope avoids clicks.
function tone(c, { freq, start, dur, type = "sine", peak = 0.18 }) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g).connect(c.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

// A quick downward two-note "tsk" — the gaze-drift catch. Attention, not alarm.
export function playGazeCatch() {
  const c = ac();
  const t = c.currentTime;
  tone(c, { freq: 660, start: t, dur: 0.09, type: "triangle", peak: 0.16 });
  tone(c, { freq: 440, start: t + 0.08, dur: 0.12, type: "triangle", peak: 0.16 });
}

// A hollow low double-thud — you left Chrome entirely. Distinct from gaze catch.
export function playChromeLoss() {
  const c = ac();
  const t = c.currentTime;
  tone(c, { freq: 200, start: t, dur: 0.14, type: "sine", peak: 0.2 });
  tone(c, { freq: 150, start: t + 0.13, dur: 0.18, type: "sine", peak: 0.2 });
}

// Bright rising triad — session complete.
export function playComplete() {
  const c = ac();
  const t = c.currentTime;
  [523.25, 659.25, 783.99].forEach((f, i) =>
    tone(c, { freq: f, start: t + i * 0.11, dur: 0.22, type: "sine", peak: 0.17 })
  );
}

// Soft single blip — calibration captured / session armed.
export function playArm() {
  const c = ac();
  const t = c.currentTime;
  tone(c, { freq: 880, start: t, dur: 0.1, type: "sine", peak: 0.12 });
}

// Warm shimmer — a personal-best / streak-on-the-line moment. Gentle, brief.
export function playMilestone() {
  const c = ac();
  const t = c.currentTime;
  [659.25, 987.77, 1318.51].forEach((f, i) =>
    tone(c, { freq: f, start: t + i * 0.08, dur: 0.3, type: "triangle", peak: 0.13 })
  );
}

// Master mute honored by callers via a passed flag; kept here for convenience.
export function withSound(enabled, fn) {
  if (enabled) fn();
}
