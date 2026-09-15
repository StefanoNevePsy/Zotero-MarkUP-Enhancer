/* eslint-disable no-undef */
// AI providers behind one interface, so the rest of the plugin never cares which
// engine is in use.
//
//   suggestTags(profile, vocabulary) -> [string]
//   embed(text)                      -> [number] | null   (null = unsupported)
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
    return this.current().suggestTags(profile, vocabulary);
  },

  async embed(text) {
    const p = this.current();
    if (typeof p.embed !== "function") return null;
    return p.embed(text);
  },

  supportsEmbeddings() {
    return typeof this.current().embed === "function";
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
    p += "Proponi al massimo " + max + " tag tematici per il documento descritto sotto.\n\n";
    p += "Regole:\n";
    p += "- I tag descrivono ARGOMENTI e CONCETTI, non il tipo di documento.\n";
    p += "- Preferisci termini brevi (1-3 parole), nella lingua del documento.\n";
    p += "- Niente duplicati, niente sinonimi dello stesso concetto.\n";
    if (reuse && vocabulary && vocabulary.length) {
      p += "- RIUSA i tag esistenti qui sotto quando sono pertinenti, con la stessa\n";
      p += "  grafia esatta. Inventa un tag nuovo solo se nessuno esistente va bene.\n\n";
      p += "Tag gia' presenti in biblioteca:\n" + vocabulary.join(", ") + "\n";
    }
    p += "\nDocumento:\n" + profile + "\n";
    p += "\nRispondi SOLO con un array JSON di stringhe, senza altro testo.\n";
    p += 'Esempio: ["terapia sistemica", "ipotizzazione", "setting clinico"]\n';
    return p;
  },

  // ---- Gemini -------------------------------------------------------------

  Gemini: {
    _base: "https://generativelanguage.googleapis.com/v1beta/models/",

    _key() {
      const k = (ZoteroSemantic.Utils.get("geminiKey") || "").trim();
      if (!k) throw new Error("Nessuna API key Gemini impostata nelle preferenze.");
      return k;
    },

    async suggestTags(profile, vocabulary) {
      const U = ZoteroSemantic.Utils;
      const model = U.get("geminiModel") || "gemini-2.5-flash";
      const prompt = ZoteroSemantic.Providers.buildTagPrompt(profile, vocabulary);

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

    async embed(text) {
      const U = ZoteroSemantic.Utils;
      const model = U.get("geminiEmbedModel") || "text-embedding-004";
      const url = this._base + encodeURIComponent(model) +
        ":embedContent?key=" + encodeURIComponent(this._key());
      const body = {
        model: "models/" + model,
        content: { parts: [{ text: U.clean(text, 8000) }] }
      };
      const res = await Zotero.HTTP.request("POST", url, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        responseType: "json"
      });
      const v = res.response && res.response.embedding && res.response.embedding.values;
      return Array.isArray(v) ? v : null;
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
    async suggestTags(profile, vocabulary) {
      const U = ZoteroSemantic.Utils;
      const P = ZoteroSemantic.Providers;
      const prompt = P.buildTagPrompt(profile, vocabulary);

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
