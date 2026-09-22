/* eslint-disable no-undef */
// Zotero Semantic - bootstrapped plugin entry point.

var ZoteroSemantic;
var chromeHandle = null;

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
  "src/graph.js",
  "src/search.js"
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

    // Register chrome:// URLs for our own windows.
    //
    // window.openDialog() CANNOT open a document addressed through rootURI: for
    // a packed plugin that is a jar:file:/// URL, and the call then does nothing
    // at all -- no window content, no error, no exception. That is exactly how
    // the relationship graph came up as an empty window. Registering a chrome
    // package makes our documents addressable the same way Zotero's own are.
    //
    // Non-fatal: the plugin stays usable for everything that is not a window,
    // and Graph/Search report the problem instead of opening a blank frame.
    try {
      const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
        .getService(Components.interfaces.amIAddonManagerStartup);
      const manifestURI = Services.io.newURI(rootURI + "manifest.json");
      chromeHandle = aomStartup.registerChrome(manifestURI, [
        ["content", "zotero-semantic", "content/"]
      ]);
      stage("chrome registered");
    } catch (e) {
      chromeHandle = null;
      Zotero.debug("[Zotero Semantic] chrome registration failed: " +
        (e && e.stack ? e.stack : e));
      stage("chrome registration FAILED (windows unavailable)");
    }

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

    ZoteroSemantic.chromeRegistered = !!chromeHandle;
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
  if (chromeHandle) {
    try { chromeHandle.destruct(); } catch (e) { /* ignore */ }
    chromeHandle = null;
  }
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
