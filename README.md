# Retrans

Retrans is a free desktop app for managing translation files in web projects that use **next-i18next** or **Paraglide (inlang)**. It shows every key and language in one grid, makes missing translations impossible to miss, tracks review status, and saves minimal, git-friendly diffs. It needs no account, no server and has no usage limits.

## Requirements

- Node.js 20.16+ (or 22.3+)
- pnpm
- Rust (stable toolchain) and the [Tauri 2 platform prerequisites](https://tauri.app/start/prerequisites/)
- CMake, to build the embedded translation engine (llama.cpp): `brew install cmake` on macOS. On Windows, install CMake and the MSVC build tools.

## Development

```sh
pnpm install
pnpm tauri dev
```

## Tests

```sh
pnpm test                 # TypeScript unit and end-to-end core tests (vitest)
pnpm exec tsc --noEmit    # type check
cd src-tauri && cargo test
```

### Running the real-model Rust test

The engine test that loads an actual GGUF model is ignored by default. Point it at a model file to run it:

```sh
cd src-tauri && RETRANS_TEST_MODEL=<path-to-model.gguf> cargo test -- --ignored
```

It runs `translates_english_to_thai_with_real_model`.

## Build

```sh
pnpm tauri build
```

Installers and bundles end up in `src-tauri/target/release/bundle/`.

## Machine translation

Retrans can suggest and batch-fill translations with a local language model. It is off until you enable it.

- **Enable it** in the machine translation settings, then pick a model. Sizes range from a small model (about 1.8 GB) to larger, better ones; the settings list the exact download size of each.
- **Gemma terms:** TranslateGemma is under the Gemma terms of use. The app shows a summary and links, and asks you to accept before downloading.
- **Where models live:** in the app data folder. A custom GGUF file you add stays where it is.
- **Privacy:** translation runs entirely on your computer. The only network traffic is the model download from huggingface.co and update checks/downloads from github.com. There is no telemetry.

## Working with a translator

A translator package is a `.zip` that is a complete, openable project: the locale files, `.retrans/state.json`, the project settings, and a manifest (`.retrans/package.json`) that remembers what the project looked like when it was exported.

1. **Export (developer).** Save your project, then open the **Import / Export** page, and under **Export for translator** pick the languages and click **Export…**. Save the zip. Export refuses while there are unsaved edits.
2. **Send the zip.** Any channel works.
3. **Open (translator).** On the start screen choose **Open translator package…**, pick the zip, and choose where to put it: Retrans extracts it into a new folder named after the zip. Opening the same zip again offers the folder it already made and never overwrites your work. Retrans never edits files inside the zip.
4. **Translate.** Edit and mark cells Reviewed as usual, then Save.
5. **Send back (translator).** On the Import / Export page, under **Send back to the developer**, click **Export…**. The original baseline is kept, so the developer can tell what changed.
6. **Import (developer).** On the Import / Export page choose **Import package (.zip)…** (or **Import folder…**). Cells the translator filled are added, status changes are applied, and cells both of you changed differently are listed as conflicts to resolve. Your own edits elsewhere are untouched, and the base language is never changed.
7. **Review and save.** Check the imported cells, then Save.

## TypeScript translations and workspaces

Some projects keep their translations in TypeScript modules instead of JSON, for example `const common = { email: { th: 'อีเมล', en: 'Email' } }` passed through `mapLocale`, or one object per language (`buttonTH`, `buttonEN`). Retrans edits these through a **workspace**.

- **Import.** Choose **Open project** and pick the project folder (or its locales folder). When Retrans finds TypeScript locale modules but no JSON project, it shows **Import TypeScript translations**. It looks in `src/assets/locales`, `src/locales`, `src/i18n` and `locales`, ignores `mapLocale.ts`, `__tests__/` and `*.test.*` / `*.spec.*` files, and never edits `src/utils/i18n.ts` or any other code. The base language defaults to `th` when the project has it. Each file becomes a **Group**. Values computed in code (a template literal, a variable) are shown read-only.
- **Where it lives.** The workspace is stored in `<project>/.retrans/`: the translations as JSON under `.retrans/workspace/`, the workspace settings in `.retrans/workspace.json`, review status in `.retrans/state.json`, and what the TypeScript files held at the last import, sync or export in `.retrans/source-baseline.json`. Commit `.retrans/` with the project if you want to share review status.
- **Save vs Export.** **Save** writes only the workspace in `.retrans/`; it never touches your TypeScript files. **Export…** is the only thing that writes outside the workspace.
- **Export kinds.**
  1. **TypeScript:** **Write back to the original files** (a minimal diff: only the changed string literals change, and quotes, indentation, line breaks and comments stay as they were), **Write TypeScript files to another folder**, or **TypeScript modules (table style)** for new code.
  2. **i18next JSON:** one file per group (`<locale>/<group>.json`) or one `translation.json` per language.
  3. **Paraglide:** `messages/<locale>.json` plus `project.inlang/settings.json`. `{{x}}` placeholders become `{x}`; i18next format modifiers are dropped, with a warning.

  Untranslated keys are left out of JSON and Paraglide exports (never written as `""`). A language added in Retrans is not written into existing TypeScript files: write-back lists it as left out and shows a snippet to add it by hand.
- **Auto-sync.** When a workspace opens, and whenever the TypeScript files change on disk (a `git pull`, an edit in your code editor), Retrans merges the change into the workspace, cell by cell: a value changed only in the code is taken, a value changed only in Retrans is kept, and a value changed differently on both sides is a conflict to resolve. Keys removed from the code are marked **Removed in source** (Keep or Delete them); they are never deleted silently. Write-back syncs first and refuses while a conflict is open. If the source folder is missing (for example in a translator package), the app shows "Source files not found — showing the saved workspace." and changes nothing.
- **The " (EN)" rule.** A value in language `xx` that ends with ` (XX)`, such as `'Reset password (EN)'` in `en`, is an untranslated marker and counts as **missing**. If the text before the marker isn't just the base-language value, Retrans offers it as a **Draft**; accepting it makes it a normal translation. On write-back, a cell that is still missing keeps its original marker text, so the code still shows the fallback.
- **Duplicate keys.** The same key in two groups gives two rows, each marked **Duplicate key**. Export to single-file i18next JSON and to Paraglide is blocked until they are renamed; per-group JSON and the TypeScript exports still work.
- **Renames.** Renaming a key in Retrans survives syncs. Write-back carries it to the code: the old key is removed from the TypeScript object and the new key written in its place.
- **Format-free new projects.** **New project** creates an empty workspace (default location `~/Documents/Retrans/<name>/`, or any empty folder you choose) that isn't tied to a file format. Add groups, keys and languages, then pick the format at **Export…** time.
- **Translator packages** work for workspaces too. The package holds the workspace (without the TypeScript files and the source baseline), so the translator works on it like any project; importing it back works as described above. Write back to the code afterwards with **Export…**.

## First launch of an unsigned build

The macOS download is for Apple Silicon Macs (M1 and later) running macOS 11 Big Sur or newer.

Releases are not code-signed for the OS, so the system warns on first launch.

- **macOS:** open the app once (macOS says it can't verify the developer), then go to **System Settings > Privacy & Security**, scroll down and click **Open Anyway**. On macOS 14 and older, right-click the app and choose **Open** also works. If macOS ever says the app "is damaged", run `xattr -cr /Applications/Retrans.app` once in Terminal and open it again.
- **Windows:** when SmartScreen appears, click **More info**, then **Run anyway**.

## Manual checklist

The core editing logic is covered by automated tests (`src/test/e2e-core.test.ts`, `src/test/e2e-mt.test.ts` for batch machine translation with a fake engine, `src/test/e2e-package.test.ts` for the translator package round trip, and `src/test/e2e-workspace.test.ts` for the TypeScript workspace round trip). These GUI checks need a person, using `pnpm tauri dev` on a copy of each fixture in `src/test/fixtures/`:

- [ ] The window opens and the project loads from the chosen folder.
- [ ] Tab moves to the next missing cell; fill a missing Thai cell this way and mark it reviewed.
- [ ] Changing the English text shows the Thai cell as needing review.
- [ ] Add, rename and delete a key; add the language `ja`; save. `git diff` in the fixture copy shows only the intended lines.
- [ ] Edit a translation file in a text editor while the app is open: the app picks up the change, and a conflicting unsaved cell shows the conflict dialog.
- [ ] Closing the window with unsaved edits shows the close prompt.
- [ ] While the conflict dialog is open, Save / Cmd+S don't save ("Resolve conflicts before saving").
- [ ] Put git conflict markers into `.retrans/state.json`: the load-error banner lists it, saving still writes translations, and the file is left untouched until it's fixed.
- [ ] Kill the app with unsaved edits, reopen the project, and the restore prompt appears.
- [ ] Enable MT, accept the Gemma terms and download TranslateGemma 4B. Pause, quit the app, reopen, then resume: the download continues.
- [ ] "Test this model": en to th with `{{name}}` keeps the placeholder.
- [ ] Open a missing `th` cell: a suggestion appears. Cmd+Enter accepts it, and the yellow dot shows the machine marker.
- [ ] "Translate missing..." for `th`, cancel midway: the items already finished stay.
- [ ] Delete the model: the space used drops.
- [ ] **Fallback check:** if TranslateGemma 4B fails to load or gives poor Thai to English output, swap catalog entry 1 for the Qwen3 4B fallback given in Task 2 of `docs/superpowers/plans/2026-10-31-paratrans-local-mt.md`.
- [ ] Translator packages: export, open the zip as a translator, translate, re-export, then import with a conflict, and resolve it.
- [ ] TypeScript workspace on `src/test/fixtures/ts-locales` (a copy): Open project offers **Import TypeScript translations**; after import the " (EN)" cells show as missing, drafts can be accepted, `change_pw` shows **Duplicate key** and `maguro_brand` is read-only. Save leaves the `.ts`/`.tsx` files unchanged.
- [ ] Workspace auto-sync: with the workspace open, add a key to a `.ts` file in a text editor; it appears in the app. Change the same cell in both the app and the file: a conflict appears, and **Write back to the original files** refuses until it is resolved.
- [ ] Workspace exports: write back, write TypeScript to another folder, i18next JSON per group and single file (blocked while duplicates exist), Paraglide (blocked likewise), and TypeScript modules (table style).
- [ ] Workspace translator package: export it, open the zip as a translator (it opens as a workspace with no row marked **Removed in source**, and **Export…** doesn't offer **Write back to the original files**), translate, send back, import into the workspace, then write back to the code.
- [ ] **New project:** the default location is `~/Documents/Retrans/<name>/`; a non-empty folder is refused; add keys and languages, then export to each format.
- [ ] **`axons-cms` run:** on a fresh copy (`cp -R ~/Works/AXONS/axons-cms /tmp/axons-cms-copy`; never the original), open it, import, check the " (EN)" placeholders are flagged as missing, edit and review a few cells (one Thai, one English, one placeholder), Save, then **Write back to the original files**. In the copy, `git diff` shows only the changed strings, one line each, and `git status` shows no other changed files besides the new `.retrans/` folder.
- [ ] Updates: an update banner appears against a draft-free test release (after the first real release).
- [ ] Windows: suggestions work on a non-AVX2 machine if one is available, otherwise on any machine.

## Continuous integration

`.github/workflows/ci.yml` runs on every branch push and pull request, on macOS and Windows: frontend tests, type check, `cargo test`, and an engine smoke test with a tiny (1.2 MB) model whose SHA-256 is checked. On Windows it also builds the NSIS installer and fails if `llama.dll`, `ggml*.dll` or the `ggml-cpu-*.dll` variants are not next to `retrans.exe` in the installer.

## Releasing

Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed. It builds macOS installers for Apple Silicon (M1 and later) only, and Windows installers, signs the updater artifacts, and uploads everything, including `latest.json`, to a **draft** GitHub release.

1. Bump `version` in `src-tauri/tauri.conf.json` and `package.json` (they must match; the workflow fails if the tag doesn't match both).
2. Run the [manual checklist](#manual-checklist) on a real Mac and a real Windows machine.
3. Tag and push:

   ```sh
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

4. Wait for the workflow to finish and the draft release to appear.
5. Edit the release notes, then publish. Publishing is what makes `latest.json` reach users: the app checks `https://github.com/oxth/retrans/releases/latest/download/latest.json`, and drafts are not "latest".

### Updater key safety

Updates are signed with the Tauri updater key. The public key is in `src-tauri/tauri.conf.json`. The private key and its password live only in the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` and on the maintainer's machine (`~/.tauri/retrans.key`).

- **Never commit the private key** or its password, and never paste them into issues or logs.
- **Back it up.** If the private key is lost, existing installs can no longer auto-update: every user would have to download and install a new version by hand.

## License

Retrans is free and open source under the [MIT License](LICENSE).

The optional TranslateGemma models are covered by their own Gemma terms of use, which the app shows before you download one.
