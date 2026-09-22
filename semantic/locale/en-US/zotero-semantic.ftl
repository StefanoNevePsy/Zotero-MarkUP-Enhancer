zsem-prefs-engine = AI engine
zsem-prefs-provider = Provider
zsem-prefs-provider-desc = Gemini works everywhere but sends data to Google. Apple on-device runs entirely on the Mac, offline and free, but needs a Foundation Models CLI.
zsem-prefs-key = API key
zsem-prefs-key-desc = The key is stored in Zotero's preferences in plain text, like every preference: do not use it on a shared computer.
zsem-prefs-model = Tagging model
zsem-prefs-embedmodel = Embedding model
zsem-prefs-apple = Apple on-device
zsem-prefs-apple-desc = macOS 27 ships /usr/bin/fm and the default command is ready to use: it builds a schema and constrains the answer to a list of tags, so the output is always valid JSON. On macOS 26 /usr/bin/fm does not exist: you need a third-party CLI (e.g. fmx) and must point this at it; if it does not support --schema the plugin automatically falls back to a plain command. In the template {cli}, {prompt}, {schema} and {out} are substituted with real paths; output is redirected to a file because Zotero cannot read a process's stdout.
zsem-prefs-applecli = CLI path
zsem-prefs-appletpl = Command template
zsem-prefs-tagging = Tags
zsem-prefs-maxtags = Maximum tags suggested
zsem-prefs-reuse = Reuse tags already in the library where possible
zsem-prefs-graph = Relationship graph
zsem-prefs-embeddings = Use embeddings for semantic distances
zsem-prefs-embeddings-desc = With embeddings two documents come out close even with no tags in common. Gemini only; with Apple, tags, creators and collections are used instead. Vectors are cached on disk, so you pay for them once.
zsem-prefs-maxnodes = Maximum documents in the graph

zsem-menu-root = Zotero Semantic
zsem-menu-tag = Suggest tags with AI…
zsem-menu-graph = Show relationship graph…
zsem-menu-test = Verify AI provider…
zsem-menu-key = Set Gemini API key…

# Item pane section. Zotero reads the header from .label and the side-bar
# button from .tooltiptext; a plain value would leave both blank.
zsem-section-concepts =
    .label = Concepts
zsem-section-concepts-sidenav =
    .tooltiptext = Concepts (Zotero Semantic)
