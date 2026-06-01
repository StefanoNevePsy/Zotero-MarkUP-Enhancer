# Markup Enhancer for Zotero

A Zotero plugin (Zotero 7 / 8 / 9) that improves highlighting and tagging:

1. **Custom highlighter palettes** — *pastel*, *neon*, *earthy*, *default*, or a
   fully **custom** palette. The palette only changes how highlights *look* in
   the reader. The stored annotation colour is **never** modified, so your notes
   keep their normal mapping and sync exactly as before.
2. **Rounded highlight corners** — with a configurable radius.
3. **Fast colored tag grid** — a "Tag Grid" section in the item pane shows a
   scrollable grid of every existing tag as a coloured chip. Click to add/remove.
   The most **recently-used** tags appear first; the rest are alphabetical.
   Each tag gets a **stable** colour (Zotero's own tag colour if set, otherwise a
   pleasant auto-assigned colour that never changes), so tags are recognisable at
   a glance. The same grid is available for **annotations**: a 🏷 button in each
   annotation's header in the reader sidebar opens the grid as a popup.
4. **Merge overlapping highlights** — when a new highlight overlaps an existing
   one, the two are merged into a single annotation (rectangles unioned, text /
   comments / tags combined) instead of leaving two duplicated notes.

## How the palette works (and why it is sync-safe)

Zotero's reader **draws PDF highlights onto a `<canvas>`** from each annotation's
`color` value — there is no DOM/CSS element to restyle. So the palette is applied
at the **data layer**:

- **Display:** `Zotero.Annotations.toJSON` is wrapped so the colour handed to the
  reader is the palette colour (standard → displayed). The canvas then draws the
  palette colour.
- **Storage:** a guarded `Notifier` "safety net" maps any palette colour that the
  reader echoes back into the database back to its **standard** colour. It can
  only ever turn a known palette colour into its matching standard colour and
  never touches a colour that is already standard, so the stored value — and
  therefore sync — always stays standard.

The overlap merger *does* change data, but only by producing one ordinary
annotation in place of two, which syncs normally. You can turn it off in the
preferences.

## Install

### From a packaged build

1. Run `./build.sh` to produce `markup-enhancer.xpi` in `build/`.
2. In Zotero: **Tools → Plugins → gear icon → Install Plugin From File…** and
   pick the `.xpi`.

### For development

Zotero can load an unpacked plugin via a proxy file:

1. Find your Zotero profile directory (**Help → "Show Data Directory"** is the
   data dir; the profile dir is shown in `about:support`).
2. Create a file named `markup-enhancer@stefanonevepsy` (no extension) inside
   `<profile>/extensions/` whose only content is the absolute path to this
   repository checkout (the folder containing `manifest.json`).
3. In `prefs.js` of the profile set `extensions.lastAppBuildId` and
   `extensions.lastAppVersion` to empty strings, or just start Zotero with
   `-purgecaches`.
4. Restart Zotero. Use **Tools → Developer → Run JavaScript** and the Debug
   Output Logging to inspect `[Markup Enhancer]` log lines.

## Preferences

**Settings → Markup Enhancer**:

- Highlighter palette (pastel / neon / earthy / default / custom)
- Round highlight corners + corner radius
- Custom palette editor (one colour per standard Zotero colour)
- Merge overlapping highlights (+ "same colour only")
- Number of recent tags shown first in the tag grid

## Project layout

```
manifest.json            Plugin manifest (Zotero 7–9)
bootstrap.js             Lifecycle entry point; loads src/*.js
src/index.js             Namespace + orchestration + prefs registration
src/utils.js             Prefs access and colour helpers
src/palettes.js          Palette definitions (standard → displayed colour maps)
src/tagColors.js         Stable per-tag colour assignment + recent tracking
src/readerStyler.js      Reader re-tinting + rounded corners (visual only)
src/tagGrid.js           Item-pane "Tag Grid" section
src/overlapMerger.js     Merge overlapping highlight annotations
prefs/prefs.xhtml,.js    Preferences pane
locale/*/markup-enhancer.ftl   Localisation (en-US, it)
icons/                   Plugin and section icons
```

## Notes & limitations

- **Palette** relies on `Zotero.Annotations.toJSON` being the serializer the
  reader uses for annotation colour. This is an internal API; if a future Zotero
  build changes it, the palette display would need adjusting (the safety net
  still protects your data either way). Highlights created during a session are
  re-pushed to the reader so they pick up the palette colour too, and changing
  the palette re-colours open readers live (no reload).
- **Rounded corners** only apply to DOM-based reader views (EPUB / web
  snapshots). PDF highlights are sharp rectangles drawn on a canvas and cannot be
  rounded without patching the reader's internal drawing, so rounding has no
  effect on PDFs.
- The reader's colour picker shows Zotero's standard swatches (it is hardcoded in
  the reader), so picking a colour there stores a standard colour as expected.
- The overlap merger acts on newly-created highlights and merges one overlapping
  neighbour per creation; chains of overlaps resolve as each highlight is added.

## License

MIT — see `LICENSE`.
