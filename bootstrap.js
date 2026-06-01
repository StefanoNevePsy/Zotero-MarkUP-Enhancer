/* eslint-disable no-undef */
// Zotero bootstrapped-plugin entry point.
// Loads the plugin source files into this scope and delegates the lifecycle
// to the ZoteroMarkupEnhancer namespace defined in src/index.js.

var ZoteroMarkupEnhancer;

// Source files are loaded in dependency order. index.js defines the namespace
// object first, the remaining modules attach themselves to it.
const SCRIPTS = [
  "src/index.js",
  "src/utils.js",
  "src/palettes.js",
  "src/tagColors.js",
  "src/readerStyler.js",
  "src/tagGrid.js",
  "src/overlapMerger.js"
];

function log(msg) {
  Zotero.debug("[Markup Enhancer] " + msg);
}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;

  for (const script of SCRIPTS) {
    Services.scriptloader.loadSubScript(rootURI + script);
  }

  ZoteroMarkupEnhancer.init({ id, version, rootURI });
  ZoteroMarkupEnhancer.addToAllWindows();
  log("started v" + version);
}

function shutdown() {
  if (typeof ZoteroMarkupEnhancer === "undefined") {
    return;
  }
  ZoteroMarkupEnhancer.removeFromAllWindows();
  ZoteroMarkupEnhancer.shutdown();
  ZoteroMarkupEnhancer = undefined;
}

function onMainWindowLoad({ window }) {
  if (typeof ZoteroMarkupEnhancer !== "undefined") {
    ZoteroMarkupEnhancer.addToWindow(window);
  }
}

function onMainWindowUnload({ window }) {
  if (typeof ZoteroMarkupEnhancer !== "undefined") {
    ZoteroMarkupEnhancer.removeFromWindow(window);
  }
}

function install() {}
function uninstall() {}
