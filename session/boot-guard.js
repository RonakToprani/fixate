// boot-guard.js — a tiny CLASSIC script (not a module) loaded before session.js.
//
// Module scripts are deferred, so this runs first and can install global error
// handlers that catch failures in the module itself — including import/load errors
// that happen before any of session.js's own code runs. Without this, such a failure
// leaves the page frozen on the default "Warming up the camera…" screen with no clue why.

(function () {
  function surface(label, detail) {
    var box = document.getElementById("loadErr");
    var msg = document.getElementById("loadMsg");
    if (msg) msg.textContent = "Startup failed.";
    if (box) {
      box.textContent = label + "\n" + detail;
      box.style.whiteSpace = "pre-wrap";
      box.hidden = false;
    }
    var retry = document.getElementById("retryBtn");
    if (retry) {
      retry.hidden = false;
      retry.onclick = function () {
        location.reload();
      };
    }
    // Also log so it's copyable from DevTools.
    console.error("[Fixate boot-guard]", label, detail);
  }

  window.addEventListener("error", function (e) {
    // Distinguish a resource/script load failure from a thrown runtime error.
    if (e && e.message) {
      var where = e.filename ? " (" + String(e.filename).split("/").pop() + ":" + e.lineno + ")" : "";
      surface("Startup error:", e.message + where);
    } else if (e && e.target && e.target.src) {
      surface("Failed to load script:", String(e.target.src).split("/").pop());
    }
  }, true); // capture phase so <script> load errors are caught too

  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    var text = r && (r.stack || r.message) ? r.stack || r.message : String(r);
    surface("Startup rejected:", text);
  });
})();
