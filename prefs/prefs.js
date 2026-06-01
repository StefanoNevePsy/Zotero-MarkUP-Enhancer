/* eslint-disable no-undef */
// Turns the shortcut text field into a "press to record" capture field.
// (All other preference controls bind directly via their `preference` attribute.)

(function () {
  const PREF = "extensions.zotero.markup-enhancer.tagShortcut";

  function plog(m) {
    try {
      if (typeof Zotero !== "undefined" && Zotero.MarkupEnhancer) Zotero.MarkupEnhancer.log("prefs: " + m);
      else if (typeof Zotero !== "undefined") Zotero.debug("[Markup Enhancer] prefs: " + m);
    } catch (e) { /* ignore */ }
  }
  plog("prefs.js loaded");

  function format(e) {
    const mods = [];
    if (e.metaKey) mods.push("cmd");
    if (e.ctrlKey) mods.push("ctrl");
    if (e.altKey) mods.push("alt");
    if (e.shiftKey) mods.push("shift");
    let key = null;
    if (e.code && e.code.startsWith("Key")) key = e.code.slice(3).toLowerCase();
    else if (e.code && e.code.startsWith("Digit")) key = e.code.slice(5);
    else if (e.key && e.key.length === 1) key = e.key.toLowerCase();
    if (!key) return null;
    mods.push(key);
    return mods.join("+");
  }

  function wire(input) {
    if (input.__zmueWired) return;
    input.__zmueWired = true;

    // Seed the default when empty so the field and the runtime fall-back agree.
    let cur = "";
    try { cur = Zotero.Prefs.get(PREF) || ""; } catch (e) { /* ignore */ }
    if (!cur) {
      cur = "alt+t";
      try { Zotero.Prefs.set(PREF, cur); } catch (e) { /* ignore */ }
      input.value = cur;
    }
    plog("shortcut field wired (value=" + (input.value || cur) + ")");

    // Press-to-record: only intercept real shortcut combos (a non-shift modifier
    // held). Plain typing is left alone, so the combo can also be entered as text
    // and saved by the field's `preference` binding.
    input.addEventListener("keydown", (e) => {
      if (!(e.altKey || e.ctrlKey || e.metaKey)) return;
      if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const spec = format(e);
      if (spec) {
        input.value = spec;
        try { Zotero.Prefs.set(PREF, spec); plog("shortcut recorded: " + spec); } catch (ex) { /* ignore */ }
      }
    }, true);
  }

  function findAndWire() {
    const input = document.getElementById("zmue-shortcut-input");
    if (input) { wire(input); return true; }
    return false;
  }

  if (!findAndWire()) {
    // The pane renders lazily; wire the field as soon as it appears.
    const obs = new MutationObserver(() => {
      if (findAndWire()) obs.disconnect();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
