# Retrans Preview (Figma plugin)

Shows Retrans draft translations in copies of real Figma frames, so a designer can mark each string
*Fits* or *Too long* before the drafts are accepted. It works with files: Retrans exports a
`.retrans-preview.json`, the plugin saves a `.retrans-results.json` that Retrans imports. The plugin
never changes the original frames or variables and has no network access.

## Build and try it

```sh
pnpm build:figma-plugin
```

In the Figma desktop app: **Plugins → Development → Import plugin from manifest…** and pick
`figma-plugin/manifest.json`.

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
