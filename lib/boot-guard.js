// boot-guard.js — a generic CLASSIC (non-module) script. Load it in the <head> of any
// extension page BEFORE the page's module script. Module scripts are deferred, so this
// runs first and can catch import/load/eval errors from the module — the failures that
// otherwise leave a page frozen with no explanation. On error it drops a red banner at
// the top of the page (works regardless of that page's DOM) and logs to the console.

(function () {
  function banner(label, detail) {
    try {
      var id = "fx-boot-error";
      var box = document.getElementById(id);
      if (!box) {
        box = document.createElement("div");
        box.id = id;
        box.style.cssText =
          "position:fixed;left:0;right:0;top:0;z-index:99999;padding:10px 14px;" +
          "background:#2a0e14;color:#ff9aa8;border-bottom:1px solid #ff6b7d;" +
          "font:12px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;";
        (document.body || document.documentElement).appendChild(box);
      }
      box.textContent = "[Fixate] " + label + "\n" + detail;
    } catch (_) {}
    try {
      console.error("[Fixate boot-guard]", label, detail);
    } catch (_) {}
  }

  window.addEventListener(
    "error",
    function (e) {
      if (e && e.message) {
        var where = e.filename ? " (" + String(e.filename).split("/").pop() + ":" + e.lineno + ")" : "";
        banner("Startup error:", e.message + where);
      } else if (e && e.target && (e.target.src || e.target.href)) {
        banner("Failed to load:", String(e.target.src || e.target.href).split("/").pop());
      }
    },
    true
  );

  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    var text = r && (r.stack || r.message) ? r.stack || r.message : String(r);
    banner("Startup rejected:", text);
  });
})();
