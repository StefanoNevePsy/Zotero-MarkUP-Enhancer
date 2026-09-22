/* eslint-disable no-undef */
// AI providers behind one interface, so the rest of the plugin never cares which
// engine is in use.
//
//   generateList(prompt)     -> [string]        (tags and concepts)
//   embed(text, kind)        -> [number] | null
//   embedBatch(texts, kind)  -> [[number] | null]
//
// Gemini talks HTTP. Apple runs an on-device CLI: Zotero can launch processes
// with Zotero.Utilities.Internal.exec() but CANNOT capture their stdout (and the
// Subprocess module causes random crashes), so we redirect output to a temp file
// through /bin/sh and read the file back.

ZoteroSemantic.Providers = {
  name() {
    return ZoteroSemantic.Utils.get("provider") === "apple" ? "apple" : "gemini";
  },

  current() {
    return this.name() === "apple" ? this.Apple : this.Gemini;
  },

  async suggestTags(profile, vocabulary) {
    return this.generateList(this.buildTagPrompt(profile, vocabulary));
  },

  async suggestConcepts(profile, vocabulary) {
    return this.generateList(this.buildConceptPrompt(profile, vocabulary));
  },

  // Tags and concepts are both "a prompt in, a list of strings out", so the
  // engines expose that single operation and the prompts live here.
  async generateList(prompt) {
    const engine = this.current();
    return this.withRetry(() => engine.generateList(prompt));
  },

  // Free tiers answer 429 when requests come too fast, and analysing a whole
  // collection is exactly that. Waiting and retrying is what a person would do
  // by hand; failing the batch on the first refusal is not.
  async withRetry(fn, waits) {
    const delays = waits || [2000, 6000, 15000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const status = e && (e.status || (e.xmlhttp && e.xmlhttp.status));
        const transient = status === 429 || status === 503 || status === 502;
        if (!transient || attempt >= delays.length) throw e;
        ZoteroSemantic.log("provider busy (" + status + "), retry in " + delays[attempt] + " ms");
        // Zotero.Promise.delay rather than setTimeout: the plugin scope is not a
        // window and is not guaranteed to have timers of its own.
        await Zotero.Promise.delay(delays[attempt]);
      }
    }
  },

  // Pure. Splits a list into consecutive batches of at most `size`.
  batches(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  },

  // ---- embeddings -------------------------------------------------------
  // Chosen independently of the tagging engine: the Apple on-device CLI has no
  // embeddings API, and without this split picking it would silently disable
  // the relationship graph and the topic search.
  //
  // `kind` is "passage" for documents being indexed and "query" for a search
  // query. Retrieval embedders are asymmetric -- NVIDIA's documentation warns
  // that getting input_type wrong causes "large drops in retrieval accuracy" --
  // so this distinction is carried through every call site.

  embedProviderName() {
    return ZoteroSemantic.Utils.get("embedProvider") === "nvidia" ? "nvidia" : "gemini";
  },

  embedProvider() {
    return this.embedProviderName() === "nvidia" ? this.Nvidia : this.Gemini;
  },

  // Vectors from different models are not comparable, so this goes into the
  // cache key: changing engine or model invalidates old vectors instead of
  // silently mixing incompatible spaces.
  embedSignature() {
    const U = ZoteroSemantic.Utils;
    return this.embedProviderName() === "nvidia"
      ? "nvidia:" + U.get("nvidiaEmbedModel")
      : "gemini:" + U.get("geminiEmbedModel");
  },

  async embed(text, kind) {
    const p = this.embedProvider();
    if (typeof p.embed !== "function") return null;
    return this.withRetry(() => p.embed(text, kind === "query" ? "query" : "passage"));
  },

  // Many texts, few requests: both engines accept a list per call. Returns one
  // vector (or null) per input, in order.
  async embedMany(texts, kind) {
    const p = this.embedProvider();
    const k = kind === "query" ? "query" : "passage";
    const out = [];
    for (const chunk of this.batches(texts, 32)) {
      const vs = typeof p.embedBatch === "function"
        ? await this.withRetry(() => p.embedBatch(chunk, k))
        : await Promise.all(chunk.map((t) => this.withRetry(() => p.embed(t, k))));
      for (let i = 0; i < chunk.length; i++) out.push(Array.isArray(vs[i]) ? vs[i] : null);
    }
    return out;
  },

  supportsEmbeddings() {
    const U = ZoteroSemantic.Utils;
    const key = this.embedProviderName() === "nvidia"
      ? U.get("nvidiaKey") : U.get("geminiKey");
    return !!String(key || "").trim();
  },

  // Models may answer with a bare array, or -- when a structured-output schema
  // is used -- with an object wrapping one. Accept both.
  normalizeTags(parsed) {
    if (Array.isArray(parsed)) return parsed.map(String);
    if (parsed && typeof parsed === "object") {
      for (const v of Object.values(parsed)) {
        if (Array.isArray(v)) return v.map(String);
      }
    }
    return [];
  },

  // Small end-to-end check used by the "verify provider" menu entry.
  async selfTest() {
    const profile =
      "Titolo: La famiglia come sistema\n" +
      "Autori: Rossi, Maria\nAnno: 2019\n" +
      "Abstract: Uno studio sull'omeostasi familiare e sul ruolo del sintomo " +
      "nella terapia sistemica breve.";
    const tags = await this.suggestTags(profile, ["terapia sistemica", "omeostasi"]);
    return tags;
  },

  // Shared prompt so both engines are asked for exactly the same thing.
  buildTagPrompt(profile, vocabulary) {
    const U = ZoteroSemantic.Utils;
    const max = Number(U.get("maxTags")) || 8;
    const reuse = U.get("reuseVocabulary");

    let p = "Sei un bibliotecario esperto che indicizza una biblioteca di ricerca.\n";
    p += "Proponi al massimo " + max + " tag per il documento descritto sotto.\n\n";

    // The single most important instruction. Without it the model returns
    // umbrella terms ("Tecnologia", "Comunicazione") that match half the
    // library and therefore help nobody find anything.
    p += "REGOLA PRINCIPALE - SPECIFICITA':\n";
    p += "Un tag e' utile solo se DISTINGUE questo documento dagli altri della\n";
    p += "biblioteca. Se un tag potrebbe applicarsi a piu' di un documento su\n";
    p += "quattro, NON usarlo.\n";
    p += "- Usa i concetti, le teorie, i costrutti, i metodi, le popolazioni e i\n";
    p += "  fenomeni SPECIFICI trattati nel documento.\n";
    p += "- VIETATE le categorie generiche, per esempio: Tecnologia, Digitale,\n";
    p += "  Comunicazione, Relazioni, Societa', Scienze sociali, Accademico,\n";
    p += "  Ricerca, Studio, Salute, Benefici, Aspetti sociali.\n";
    p += "- Esempio SBAGLIATO (troppo generico): [\"Tecnologia\", \"Comunicazione\", \"Relazioni\"]\n";
    p += "- Esempio GIUSTO (specifico): [\"chatbot relazionali\", \"legami parasociali\",\n";
    p += "  \"riparazione conversazionale\", \"antropomorfizzazione\"]\n\n";

    p += "Altre regole:\n";
    p += "- Termini brevi (1-4 parole), nella lingua del documento.\n";
    p += "- Niente duplicati e niente sinonimi dello stesso concetto.\n";
    p += "- Non descrivere il tipo di documento (articolo, revisione, libro).\n";
    p += "- Meglio pochi tag precisi che molti vaghi: se ne trovi solo 3 di\n";
    p += "  davvero specifici, restituisci solo quelli.\n";

    if (reuse && vocabulary && vocabulary.length) {
      p += "- Puoi riusare un tag dall'elenco qui sotto, con la stessa grafia\n";
      p += "  esatta, SOLO se descrive specificamente questo documento. Non\n";
      p += "  riusarlo perche' e' genericamente attinente: in caso di dubbio\n";
      p += "  preferisci un tag nuovo e piu' preciso.\n\n";
      p += "Tag gia' presenti in biblioteca (da riusare solo se calzanti):\n";
      p += vocabulary.join(", ") + "\n";
    }

    p += "\nDocumento:\n" + profile + "\n";
    p += "\nRispondi SOLO con un array JSON di stringhe, senza altro testo.\n";
    return p;
  },

  // Concepts differ from tags in purpose: tags are a few curated labels, while
  // concepts are a fuller inventory of what the document discusses, central
  // and secondary alike. The model only NAMES them; how much the document is
  // about each one is measured afterwards from the text itself, because a
  // model's self-assigned scores are not comparable between documents.
  buildConceptPrompt(profile, vocabulary) {
    const U = ZoteroSemantic.Utils;
    const max = Number(U.get("conceptsMax")) || 12;

    let p = "Sei un ricercatore che indicizza una biblioteca di ricerca.\n";
    p += "Elenca da 6 a " + max + " concetti di cui tratta il documento descritto\n";
    p += "sotto: sia i temi centrali sia quelli secondari ma presenti.\n\n";
    p += "Regole:\n";
    p += "- Concetti SPECIFICI: teorie, costrutti, fenomeni, metodi, popolazioni,\n";
    p += "  contesti. Un concetto che si applicherebbe a quasi ogni documento\n";
    p += "  (Ricerca, Studio, Societa', Tecnologia, Comunicazione, Salute) e' inutile.\n";
    p += "- Espressioni nominali brevi (1-4 parole), nella lingua del documento.\n";
    p += "- Ogni concetto una sola volta: niente sinonimi dello stesso concetto.\n";
    p += "- Non dare punteggi e non ordinare per importanza: serve solo l'elenco.\n";

    if (vocabulary && vocabulary.length) {
      p += "- Se un concetto coincide con uno di quelli gia' usati in biblioteca,\n";
      p += "  scrivilo ESATTAMENTE con la stessa grafia, cosi' i documenti restano\n";
      p += "  confrontabili. Se invece e' solo affine, usa il nome piu' preciso.\n\n";
      p += "Concetti gia' usati in biblioteca:\n" + vocabulary.join(", ") + "\n";
    }

    p += "\nDocumento:\n" + profile + "\n";
    p += "\nRispondi SOLO con un array JSON di stringhe, senza altro testo.\n";
    return p;
  },

  // Pure. Cleans the model's list: trims, drops empty or overlong entries and
  // case-insensitive duplicates, and adopts the library's existing spelling
  // when a concept already exists -- that shared spelling is what makes
  // "sort the library by this concept" find the same concept across documents.
  normalizeConcepts(list, vocabulary, max) {
    const known = new Map();
    for (const v of vocabulary || []) {
      const k = String(v).trim().toLowerCase();
      if (k && !known.has(k)) known.set(k, String(v).trim());
    }
    const seen = new Set();
    const out = [];
    for (const raw of list || []) {
      let name = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim()
        .replace(/^[-•*\d.)\s]+/, "").replace(/[.;:,]+$/, "").trim();
      if (name.length < 2 || name.length > 60) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(known.get(key) || name);
      if (out.length >= (max || 12)) break;
    }
    return out;
  },

  // ---- Gemini -------------------------------------------------------------

  Gemini: {
    _base: "https://generativelanguage.googleapis.com/v1beta/models/",

    _key() {
      const k = (ZoteroSemantic.Utils.get("geminiKey") || "").trim();
      if (!k) throw new Error("Nessuna API key Gemini impostata nelle preferenze.");
      return k;
    },

    async generateList(prompt) {
      const U = ZoteroSemantic.Utils;
      const model = U.get("geminiModel") || "gemini-2.5-flash";

      const url = this._base + encodeURIComponent(model) +
        ":generateContent?key=" + encodeURIComponent(this._key());

      // responseSchema makes the array of strings a guarantee rather than a
      // request the model may phrase differently.
      const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: { type: "ARRAY", items: { type: "STRING" } }
        }
      };

      const res = await Zotero.HTTP.request("POST", url, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        responseType: "json"
      });

      const data = res.response;
      const text = data && data.candidates && data.candidates[0] &&
        data.candidates[0].content && data.candidates[0].content.parts &&
        data.candidates[0].content.parts.map((p) => p.text || "").join("");
      return ZoteroSemantic.Providers.normalizeTags(U.parseJSONLoose(text));
    },

    async embed(text, kind) {
      const U = ZoteroSemantic.Utils;
      const model = U.get("geminiEmbedModel") || "text-embedding-004";
      const url = this._base + encodeURIComponent(model) +
        ":embedContent?key=" + encodeURIComponent(this._key());
      // Gemini has the same asymmetry as other retrieval embedders: documents
      // and queries are embedded for different roles.
      const body = {
        model: "models/" + model,
        content: { parts: [{ text: U.clean(text, 8000) }] },
        taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT"
      };
      const res = await Zotero.HTTP.request("POST", url, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        responseType: "json"
      });
      const v = res.response && res.response.embedding && res.response.embedding.values;
      return Array.isArray(v) ? v : null;
    },

    // batchEmbedContents: one request for a whole list, same task types.
    async embedBatch(texts, kind) {
      const U = ZoteroSemantic.Utils;
      const model = U.get("geminiEmbedModel") || "text-embedding-004";
      const url = this._base + encodeURIComponent(model) +
        ":batchEmbedContents?key=" + encodeURIComponent(this._key());
      const taskType = kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
      const body = {
        requests: texts.map((t) => ({
          model: "models/" + model,
          content: { parts: [{ text: U.clean(t, 8000) }] },
          taskType
        }))
      };
      const res = await Zotero.HTTP.request("POST", url, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        responseType: "json"
      });
      const list = (res.response && res.response.embeddings) || [];
      return texts.map((_, i) => (list[i] && Array.isArray(list[i].values) ? list[i].values : null));
    }
  },

  // ---- NVIDIA (embeddings only) -------------------------------------------
  // OpenAI-shaped /v1/embeddings. nemotron-3-embed-1b returns 2048-dimensional
  // vectors and is validated to 4096 tokens, so long profiles are truncated at
  // the end by the service rather than rejected. No generateList(): this engine
  // is wired up purely as an embedding source.

  Nvidia: {
    // Pure, so the input_type contract can be asserted in tests.
    buildBody(text, kind, model) {
      return {
        input: Array.isArray(text) ? text.map(String) : [String(text)],
        model: model,
        input_type: kind === "query" ? "query" : "passage",
        encoding_format: "float",
        truncate: "END"
      };
    },

    async embed(text, kind) {
      return (await this.embedBatch([text], kind))[0];
    },

    async embedBatch(texts, kind) {
      const U = ZoteroSemantic.Utils;
      const key = String(U.get("nvidiaKey") || "").trim();
      if (!key) throw new Error("Nessuna API key NVIDIA impostata nelle preferenze.");

      const base = String(U.get("nvidiaBase") || "https://integrate.api.nvidia.com/v1")
        .replace(/\/+$/, "");
      const model = U.get("nvidiaEmbedModel") || "nvidia/nemotron-3-embed-1b";
      const body = this.buildBody(texts.map((t) => U.clean(t, 12000)), kind, model);

      const res = await Zotero.HTTP.request("POST", base + "/embeddings", {
        body: JSON.stringify(body),
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": "Bearer " + key
        },
        responseType: "json"
      });
      return this.parseResponse(res.response, texts.length);
    },

    // Pure. OpenAI-shaped responses carry an `index` per vector; order by it
    // rather than trusting arrival order, so vector i always belongs to text i.
    parseResponse(response, count) {
      const out = new Array(count).fill(null);
      const data = (response && response.data) || [];
      data.forEach((d, pos) => {
        const i = Number.isInteger(d && d.index) ? d.index : pos;
        if (i >= 0 && i < count && d && Array.isArray(d.embedding)) out[i] = d.embedding;
      });
      return out;
    }
  },

  // ---- Apple on-device ----------------------------------------------------
  // No embed() on purpose: the Foundation Models CLI exposes text generation,
  // not embeddings, so Similarity falls back to lexical scoring for this engine.

  Apple: {
    // macOS 27's fm can guarantee the shape of its answer:
    //   fm schema object --name Tags --string tags --array > schema.json
    //   fm respond "<prompt>" --schema schema.json      -> {"tags": [...]}
    // If the installed CLI does not understand --schema (macOS 26 third-party
    // builds), we transparently retry with a plain prompt and parse loosely.
    async generateList(prompt) {
      const U = ZoteroSemantic.Utils;
      const P = ZoteroSemantic.Providers;

      let out = "";
      let firstError = null;
      try {
        out = await this.run(prompt, U.get("appleTemplate"));
        const tags = P.normalizeTags(U.parseJSONLoose(out));
        if (tags.length) return tags;
        ZoteroSemantic.log("apple: structured run gave no tags, retrying plain");
      } catch (e) {
        firstError = e;
        ZoteroSemantic.log("apple: structured run failed (" + e.message + "), retrying plain");
      }

      try {
        out = await this.run(prompt, U.get("appleTemplatePlain"));
        return P.normalizeTags(U.parseJSONLoose(out));
      } catch (e) {
        throw firstError || e;
      }
    },

    // Substitutes every placeholder occurrence. Note the default template names
    // {cli} twice, so this must replace all of them, not just the first.
    buildCommand(template, cli, paths) {
      return String(template)
        .split("{cli}").join(cli)
        .split("{prompt}").join(paths.prompt)
        .split("{schema}").join(paths.schema)
        .split("{out}").join(paths.out);
    },

    // Runs a command template and returns what it wrote to the output file.
    // Zotero can start processes but cannot read their stdout, hence the file.
    async run(prompt, template) {
      const U = ZoteroSemantic.Utils;
      const cli = U.get("appleCli") || "/usr/bin/fm";
      if (!template) template = U.DEFAULTS.appleTemplate;

      const tmp = Zotero.getTempDirectory().path;
      const stamp = Date.now() + "-" + Math.floor(Math.random() * 1e6);
      const promptPath = PathUtils.join(tmp, "zsem-prompt-" + stamp + ".txt");
      const outPath = PathUtils.join(tmp, "zsem-out-" + stamp + ".txt");
      const schemaPath = PathUtils.join(tmp, "zsem-schema-" + stamp + ".json");

      await IOUtils.writeUTF8(promptPath, prompt);

      const cmd = this.buildCommand(template, cli, {
        prompt: promptPath, schema: schemaPath, out: outPath
      });

      ZoteroSemantic.log("apple cmd: " + cmd);

      try {
        await Zotero.Utilities.Internal.exec("/bin/sh", ["-c", cmd]);
        let text = "";
        try { text = await IOUtils.readUTF8(outPath); } catch (e) { /* no output */ }
        if (!text.trim()) {
          throw new Error(
            "Nessun output da '" + cli + "'. Verifica che il file esista " +
            "(su macOS 26 /usr/bin/fm non c'e') e che il modello di comando sia corretto."
          );
        }
        return text;
      } finally {
        for (const p of [promptPath, outPath, schemaPath]) {
          try { await IOUtils.remove(p, { ignoreAbsent: true }); } catch (e) { /* ignore */ }
        }
      }
    }
  }
};
