# Retrans Preview (Figma plugin)

Shows Retrans draft translations in copies of real Figma frames, so a designer can mark each string
*Fits* or *Too long* before the drafts are accepted. It works with files: Retrans exports a
`.retrans-preview.json`, the plugin saves a `.retrans-results.json` that Retrans imports. The plugin
never changes the original frames or variables. Its only network access is to the Retrans app on
your own computer (`localhost` ports 47321 to 47325), to get drafts and send results without files.

## How it talks to Retrans

The plugin tries localhost ports 47321 to 47325 with `GET /v1/hello` to find Retrans. It sends a drafts request (project and language), the results you send, and the pairing code when you connect. The token it gets is sent only as a Bearer header to localhost. Nothing leaves your computer. Retrans answers only while its live link switch is on.

## Build and try it

```sh
pnpm build:figma-plugin
```

In the Figma desktop app: **Plugins → Development → Import plugin from manifest…** and pick
`figma-plugin/manifest.json`.

## Versions and releases

The plugin is versioned and released on its own, separate from the Retrans app:

- Its version is the newest section of [`CHANGELOG.md`](CHANGELOG.md) in this folder.
- The *Figma plugin* workflow (`.github/workflows/figma-plugin.yml`) runs only when the plugin
  changes (`figma-plugin/**` or `src/preview/format.ts`, which it bundles). It tests and builds it.
- On `main`, if that version has no release yet, it creates one, tagged `figma-plugin-v<version>`,
  with `retrans-preview-<version>.zip` (the manifest and the built files) and
  `retrans-preview-<version>-whats-new.txt`. Plugin releases are never marked "latest", because the
  app's updater reads the latest release.
- To release a change, add a section for the new version at the top of `CHANGELOG.md`. A change
  pushed without a new version is built and tested but not released.

## Publishing to the Figma Community

Figma has no API for publishing, so this is the one manual step.

1. **Once:** get the plugin id from Figma (create the plugin in Figma, or take the id the first
   publish gives you) and put it in `manifest.json` as `"id"`. Every update publishes to that id.
   Until then the workflow makes no release: it keeps the zip on the workflow run for testers and
   warns that the id is a placeholder. Pushing the real id releases the current version.
2. **Each version:** download the zip and the What's new text from the `figma-plugin-v<version>`
   release, unzip, import the manifest (Plugins → Development → Import plugin from manifest…), then
   **Publish** and paste the text into the version notes.

The first publish is reviewed by Figma; updates after approval go out immediately. The listing's
data disclosure: the plugin sends draft translations and the designer's marks only to the Retrans
app on the same computer (localhost), and never anywhere else.

## Checks in real Figma (not yet run)

These can't run in automated tests. Record the outcome here.

| Check | Figma desktop | Figma in browser |
| --- | --- | --- |
| Load a `.retrans-preview.json` | – | – |
| *Save results* downloads a file | – | – |
| Text bound to a **library** variable matches the ID in the library's `.tokens.json` (exact, or ending in `/<id>`) | – | – |
| Make preview copies: originals unchanged (check version history) | – | – |
| Long text in a fixed box gets ⚠ | – | – |
| Making copies again replaces the earlier copies | – | – |
| Verdicts survive closing and reopening the plugin | – | – |
| Remove copies leaves originals | – | – |
| A frame inside a Section, and a frame nested in another frame or auto-layout: copy lands beside it and the original layout is unchanged | – | – |
| Two different Figma files keep their own loaded file and verdicts | – | – |
| Pair with the 6-digit code shown in Retrans (Settings, Figma) | – | – |
| *Get drafts* loads a project's drafts for the chosen language | – | – |
| *Send to Retrans* delivers results; Retrans shows them | – | – |
| Retrans closed: plugin says "Open Retrans to connect" and the file buttons still work; *Try again* finds it once open | – | – |
| *Refresh* lists a project opened in Retrans after the plugin | – | – |
| Retrans quit and reopened after Get drafts: *Send to Retrans* still reaches the project | – | – |
| Figma in Chrome (Local Network Access prompt): allowing it lets the plugin find Retrans | – | – |
| Forget the plugin in Retrans: plugin asks to connect again | – | – |
