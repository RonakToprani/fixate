// sharecard.js — renders the end-of-session stat card to a canvas so it can be
// downloaded or copied. The whole point is that it feels SPECIFIC (real attribution
// line) rather than a generic app screenshot, which is what makes it shareable.

import { shareCallout } from "./copy.js";
import { fmtHrs } from "./storage.js";

// record = the saved session record; portfolio = current rolling aggregates.
export function renderShareCard(canvas, record, portfolio) {
  const W = 1080;
  const H = 1080;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // Background: deep indigo gradient.
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#0b1020");
  bg.addColorStop(1, "#181433");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Subtle grid glow.
  ctx.strokeStyle = "rgba(120,110,255,0.06)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 60) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = 0; y <= H; y += 60) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  const pad = 90;

  // Wordmark.
  ctx.fillStyle = "#8f86ff";
  ctx.font = "700 40px -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.textBaseline = "top";
  ctx.fillText("FIXATE", pad, pad);

  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "500 30px -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.fillText("verified focus", pad + 190, pad + 8);

  // Big focus %.
  const focus = Math.round(record.focusPct || 0);
  ctx.fillStyle = "#ffffff";
  ctx.font = "800 340px -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.fillText(`${focus}`, pad - 8, 250);
  // percent sign smaller
  const pctWidth = ctx.measureText(`${focus}`).width;
  ctx.font = "800 120px -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.fillStyle = "#8f86ff";
  ctx.fillText("%", pad + pctWidth - 4, 470);

  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.font = "600 44px -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.fillText("focused", pad, 620);

  // Duration + completed badge.
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "600 46px -apple-system, Segoe UI, Roboto, sans-serif";
  const durLine = `${fmtHrs(record.actualMin || 0)} locked in${record.completed ? "" : " (ended early)"}`;
  ctx.fillText(durLine, pad, 700);

  // The specific, slightly-funny callout — this is the shareable bit.
  const callout = shareCallout(
    {
      gazeDrifts: record.gazeDriftEvents?.length || 0,
      chromeLosses: record.chromeLossEvents?.length || 0,
      blockedAttempts: aggBlocked(record.blockedAttempts),
    },
    focus
  );
  ctx.fillStyle = "#c9c4ff";
  ctx.font = "italic 600 50px -apple-system, Segoe UI, Roboto, sans-serif";
  wrapText(ctx, `“${callout}”`, pad, 800, W - pad * 2, 62);

  // Footer: verified streak / total.
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = "500 34px -apple-system, Segoe UI, Roboto, sans-serif";
  const streak = portfolio?.currentCleanStreak || 0;
  const total = fmtHrs(portfolio?.verifiedMinutes || 0);
  ctx.fillText(`${total} verified · ${streak} clean streak`, pad, H - pad - 20);

  return canvas;
}

function aggBlocked(attempts) {
  const byHost = {};
  for (const a of attempts || []) byHost[a.host] = (byHost[a.host] || 0) + 1;
  return Object.entries(byHost).map(([host, count]) => ({ host, count }));
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(" ");
  let line = "";
  let yy = y;
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, yy);
      line = w;
      yy += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, yy);
  return yy;
}

// Trigger a download of the current card.
export function downloadCard(canvas, filename = "fixate-session.png") {
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, "image/png");
}
