/* eslint-disable no-undef */
// Zotero Semantic - bootstrapped plugin entry point.

var ZoteroSemantic;

// Marked at parse time, before anything else can go wrong. If this value is
// missing entirely, Zotero never even loaded this file; if it stops at an
// intermediate stage, that stage is where startup died.
try { Zotero.SemanticBootStage = "bootstrap parsed"; } catch (e) { /* ignore */ }

const SCRIPTS = [
  "src/index.js",
  "src/utils.js",
  "src/providers.js",
  "src/extractor.js",
  "src/similarity.js",
  "src/tagger.js",
  "src/graph.js"
];

// A failure anywhere in startup leaves the plugin installed but completely
// inert, with nothing shown in the UI to say why. Record the reason somewhere
// retrievable (Zotero.SemanticBootError) and name the exact file that failed,
// so a dead plugin can be diagnosed instead of guessed at.
async function startup({ id, version, rootURI }) {
  const stage = (s) => {
    try { Zotero.SemanticBootStage = s; } catch (e) { /* ignore */ }
    Zotero.debug("[Zotero Semantic] stage: " + s);
  };

  try {
    stage("startup entered");
    Zotero.SemanticBootError = null;
    await Zotero.initializationPromise;
    stage("zotero ready");

    for (const script of SCRIPTS) {
      try {
        Services.scriptloader.loadSubScript(rootURI + script);
      } catch (e) {
        throw new Error("loadSubScript failed on " + script + ": " +
          (e && e.stack ? e.stack : e));
      }
    }
    stage("scripts loaded");

    if (typeof ZoteroSemantic === "undefined") {
      throw new Error("ZoteroSemantic is undefined after loading all scripts");
    }

    ZoteroSemantic.init({ id, version, rootURI });
    stage("init done");

    ZoteroSemantic.addToAllWindows();
    stage("complete, v" + version);
  } catch (e) {
    const msg = e && e.stack ? e.stack : String(e);
    try { Zotero.SemanticBootError = msg; } catch (ignored) { /* ignore */ }
    stage("FAILED");
    Zotero.debug("[Zotero Semantic] STARTUP FAILED: " + msg);
  }
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
