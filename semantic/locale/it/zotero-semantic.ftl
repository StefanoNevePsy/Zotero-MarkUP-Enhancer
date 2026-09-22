zsem-prefs-engine = Motore AI
zsem-prefs-provider = Provider
zsem-prefs-provider-desc = Gemini funziona su qualsiasi sistema ma invia i dati a Google. Apple on-device elabora tutto sul Mac, senza rete e senza costi, ma richiede una CLI dei Foundation Models.
zsem-prefs-key = API key
zsem-prefs-key-desc = La chiave viene salvata nelle preferenze di Zotero in chiaro, come tutte le preferenze: non usarla su un computer condiviso.
zsem-prefs-model = Modello per i tag
zsem-prefs-embedmodel = Modello per gli embedding
zsem-prefs-apple = Apple on-device
zsem-prefs-apple-desc = Su macOS 27 Apple include /usr/bin/fm e il comando predefinito è già pronto: genera uno schema e vincola la risposta a un elenco di tag, così l'output è sempre JSON valido. Su macOS 26 /usr/bin/fm non esiste: serve una CLI di terze parti (es. fmx) e va indicato qui il suo percorso; se non supporta --schema il plugin ripiega automaticamente su un comando semplice. Nel modello {cli}, {prompt}, {schema} e {out} vengono sostituiti con percorsi reali; l'output è rediretto su file perché Zotero non può leggere lo stdout dei processi.
zsem-prefs-applecli = Percorso della CLI
zsem-prefs-appletpl = Modello di comando
zsem-prefs-tagging = Tag
zsem-prefs-maxtags = Numero massimo di tag proposti
zsem-prefs-reuse = Riusa i tag già presenti in biblioteca quando possibile
zsem-prefs-graph = Rete di relazioni
zsem-prefs-embeddings = Usa gli embedding per le distanze semantiche
zsem-prefs-embeddings-desc = Con gli embedding due documenti risultano vicini anche senza tag in comune. Disponibile solo con Gemini; con Apple si usano automaticamente tag, autori e collezioni. I vettori sono messi in cache su disco, quindi si pagano una sola volta.
zsem-prefs-maxnodes = Numero massimo di documenti nel grafo

zsem-menu-root = Zotero Semantic
zsem-menu-tag = Suggerisci tag con AI…
zsem-menu-graph = Mostra rete di relazioni…
zsem-menu-test = Verifica provider AI…
zsem-menu-key = Imposta API key Gemini…

# Item pane section. Zotero reads the header from .label and the side-bar
# button from .tooltiptext; a plain value would leave both blank.
zsem-section-concepts =
    .label = Concetti
zsem-section-concepts-sidenav =
    .tooltiptext = Concetti (Zotero Semantic)
