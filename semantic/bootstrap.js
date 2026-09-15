/* eslint-disable no-undef */
// Zotero Semantic - bootstrapped plugin entry point.

var ZoteroSemantic;

const SCRIPTS = [
  "src/index.js",
  "src/utils.js",
  "src/providers.js",
  "src/extractor.js",
  "src/similarity.js",
  "src/tagger.js",
  "src/graph.js"
];

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  for (const script of SCRIPTS) {
    Services.scriptloader.loadSubScript(rootURI + script);
  }
  ZoteroSemantic.init({ id, version, rootURI });
  ZoteroSemantic.addToAllWindows();
}

function shutdown() {
  if (typeof ZoteroSemantic === "undefined") return;
  ZoteroSemantic.removeFromAllWindows();
  ZoteroSemantic.shutdown();
  ZoteroSemantic = undefined;
}

function onMainWindowLoad({ window }) {
  if (typeof ZoteroSemantic !== "undefined") ZoteroSemantic.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  if (typeof ZoteroSemantic !== "undefined") ZoteroSemantic.removeFromWindow(window);
}

function install() {}
function uninstall() {}
