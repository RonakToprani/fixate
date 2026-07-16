// service-worker.js — the coordination hub between the session tab, the
// declarativeNetRequest blocking rules, and the tabs/windows APIs.
//
// MV3 service workers are ephemeral: they can be killed and respawned at any time.
// So NO durable state lives in module variables — active-session state is kept in
// chrome.storage.session (cleared when the browser closes, which is exactly right for
// a "current session"), and the windows.onFocusChanged listener is registered at the
// top level so it survives respawns.
//
// Responsibilities:
//   • install/remove dynamic DNR rules that redirect blocked sites to our blocked page
//   • count blocked-site attempts (reported by the blocked page when it loads)
//   • detect leaving Chrome entirely via windows.onFocusChanged (>5s = one catch)
//   • hand the session tab an aggregated catch report at session end
//
// It intentionally does NOT do gaze detection — that lives in the session tab where the
// camera and MediaPipe run. The session tab is authoritative for the final saved record;
// the worker just owns what only it can see (network + OS focus).

const RULE_BASE_ID = 1000; // dynamic rule ids live in [RULE_BASE_ID, RULE_BASE_ID + N)
const FOCUS_LOSS_MS = 5000; // sustained loss of Chrome focus that counts as a catch

// ---- session state in chrome.storage.session --------------------------------

function sget(keys) {
  return new Promise((r) => chrome.storage.session.get(keys, r));
}
function sset(obj) {
  return new Promise((r) => chrome.storage.session.set(obj, r));
}

async function getState() {
  const s = await sget(["active", "startedAt", "durationMin", "awaySince", "blockedAttempts", "chromeLossEvents", "sessionTabId"]);
  return {
    active: !!s.active,
    startedAt: s.startedAt || 0,
    durationMin: s.durationMin || 0,
    awaySince: s.awaySince || 0,
    blockedAttempts: s.blockedAttempts || [],
    chromeLossEvents: s.chromeLossEvents || [],
    sessionTabId: s.sessionTabId ?? null,
  };
}

// ---- DNR rules ---------------------------------------------------------------

// Normalize a user-entered site to a bare registrable host (drop scheme/path/www).
function normHost(raw) {
  let h = String(raw).trim().toLowerCase();
  h = h.replace(/^https?:\/\//, "").replace(/^www\./, "");
  h = h.split("/")[0].split("?")[0];
  return h;
}

// Build DNR rules that redirect main-frame navigations to the blocked page. One rule per
// host keeps the redirect URL simple and lets the blocked page name the exact site.
function buildRules(blocklist) {
  const rules = [];
  blocklist.forEach((raw, i) => {
    const host = normHost(raw);
    if (!host) return;
    const redirect =
      chrome.runtime.getURL("blocked/blocked.html") + "?site=" + encodeURIComponent(host);
    rules.push({
      id: RULE_BASE_ID + i,
      priority: 1,
      action: { type: "redirect", redirect: { url: redirect } },
      condition: {
        // ||host matches host and any subdomain, any scheme.
        urlFilter: `||${host}`,
        resourceTypes: ["main_frame"],
      },
    });
  });
  return rules;
}

async function clearAllDynamicRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const ids = existing.map((r) => r.id).filter((id) => id >= RULE_BASE_ID);
  if (ids.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
  }
}

async function installRules(blocklist) {
  await clearAllDynamicRules();
  const rules = buildRules(blocklist);
  if (rules.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules });
  }
  return rules.length;
}

// ---- session lifecycle -------------------------------------------------------

async function startSession({ blocklist, durationMin, startedAt, sessionTabId }) {
  await installRules(blocklist || []);
  await sset({
    active: true,
    startedAt: startedAt || Date.now(),
    durationMin: durationMin || 0,
    awaySince: 0,
    blockedAttempts: [],
    chromeLossEvents: [],
    sessionTabId: sessionTabId ?? null,
  });
}

async function endSession() {
  const state = await getState();
  // If Chrome is still unfocused as the session ends, close out that pending loss.
  const events = [...state.chromeLossEvents];
  if (state.awaySince) {
    const dur = Date.now() - state.awaySince;
    if (dur >= FOCUS_LOSS_MS) events.push({ t: state.awaySince, durMs: dur });
  }
  await clearAllDynamicRules();
  await sset({ active: false, awaySince: 0, sessionTabId: null });
  return {
    chromeLossEvents: events,
    blockedAttempts: state.blockedAttempts,
  };
}

// ---- Chrome-focus-loss detection (leaving Chrome entirely) -------------------

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const state = await getState();
  if (!state.active) return;

  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // Chrome lost OS focus — user switched to another app (or their phone). Mark the
    // moment; we only count it if it lasts > FOCUS_LOSS_MS.
    if (!state.awaySince) await sset({ awaySince: Date.now() });
  } else {
    // Focus returned to some Chrome window.
    if (state.awaySince) {
      const dur = Date.now() - state.awaySince;
      await sset({ awaySince: 0 });
      if (dur >= FOCUS_LOSS_MS) {
        const events = [...state.chromeLossEvents, { t: state.awaySince, durMs: dur }];
        await sset({ chromeLossEvents: events });
        notifySessionTab(state.sessionTabId, {
          type: "LIVE_CATCH",
          category: "chrome-loss",
          durMs: dur,
          total: events.length,
        });
      }
    }
  }
});

// ---- messaging ---------------------------------------------------------------

function notifySessionTab(tabId, msg) {
  if (tabId == null) {
    // Best effort broadcast if we don't know the tab.
    chrome.runtime.sendMessage(msg).catch(() => {});
    return;
  }
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "SESSION_START": {
        await startSession({
          blocklist: msg.blocklist,
          durationMin: msg.durationMin,
          startedAt: msg.startedAt,
          sessionTabId: sender.tab?.id ?? msg.sessionTabId ?? null,
        });
        sendResponse({ ok: true });
        break;
      }
      case "SESSION_END": {
        const report = await endSession();
        sendResponse({ ok: true, report });
        break;
      }
      case "SESSION_STATE": {
        const state = await getState();
        const liveStats = (await sget(["liveStats"])).liveStats || null;
        sendResponse({
          ok: true,
          active: state.active,
          startedAt: state.startedAt,
          durationMin: state.durationMin,
          blockedAttempts: state.blockedAttempts,
          chromeLossEvents: state.chromeLossEvents,
          liveStats,
        });
        break;
      }
      case "LIVE_STATS": {
        // Session tab pushes lightweight live stats (focus%, msLeft) for the blocked page.
        await sset({ liveStats: msg.stats });
        sendResponse({ ok: true });
        break;
      }
      case "BLOCKED_HIT": {
        const state = await getState();
        if (state.active) {
          const attempts = [...state.blockedAttempts, { host: msg.host, t: Date.now() }];
          await sset({ blockedAttempts: attempts });
          notifySessionTab(state.sessionTabId, {
            type: "LIVE_CATCH",
            category: "blocked",
            host: msg.host,
            total: attempts.length,
          });
          const liveStats = (await sget(["liveStats"])).liveStats || null;
          sendResponse({
            ok: true,
            active: true,
            startedAt: state.startedAt,
            durationMin: state.durationMin,
            attemptCount: attempts.length,
            liveStats,
          });
        } else {
          sendResponse({ ok: true, active: false });
        }
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // keep the message channel open for the async response
});

// Safety net: if the extension is reloaded/updated mid-session, don't leave stale
// blocking rules stranded.
chrome.runtime.onInstalled.addListener(() => clearAllDynamicRules());
chrome.runtime.onStartup.addListener(() => clearAllDynamicRules());
