/* eslint-disable no-undef */
// Preference-pane logic for the custom palette editor.
// (The remaining controls auto-bind through their `preference` attributes.)

(function () {
  const PREF = "extensions.zotero.markup-enhancer.customPalette";

  // Zotero's standard annotation colours (must match src/palettes.js).
  const STANDARD = [
    ["Yellow", "#ffd400"],
    ["Red", "#ff6666"],
    ["Green", "#5fb236"],
    ["Blue", "#2ea8e5"],
    ["Purple", "#a28ae5"],
    ["Magenta", "#e56eee"],
    ["Orange", "#f19837"],
    ["Gray", "#aaaaaa"]
  ];

  function readMap() {
    try {
      return JSON.parse(Zotero.Prefs.get(PREF) || "{}") || {};
    } catch (e) {
      return {};
    }
  }

  function writeMap(map) {
    Zotero.Prefs.set(PREF, JSON.stringify(map));
  }

  function build() {
    const container = document.getElementById("zmue-custom-rows");
    if (!container) return;
    container.textContent = "";
    const map = readMap();
    const HTML = "http://www.w3.org/1999/xhtml";

    for (const [name, std] of STANDARD) {
      const row = document.createElementNS(HTML, "div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;margin:3px 0;";

      const swatch = document.createElementNS(HTML, "span");
      swatch.style.cssText =
        "width:14px;height:14px;border-radius:3px;border:1px solid #0003;display:inline-block;background:" +
        std;

      const label = document.createElementNS(HTML, "span");
      label.textContent = name;
      label.style.cssText = "flex:1;";

      const input = document.createElementNS(HTML, "input");
      input.type = "color";
      input.value = (map[std] || std).toLowerCase();
      input.addEventListener("change", () => {
        const m = readMap();
        m[std] = input.value.toLowerCase();
        writeMap(m);
      });

      row.appendChild(swatch);
      row.appendChild(label);
      row.appendChild(input);
      container.appendChild(row);
    }
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    build();
  } else {
    document.addEventListener("DOMContentLoaded", build, { once: true });
  }
})();
