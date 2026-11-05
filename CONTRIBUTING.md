# Contributing to Retrans

Retrans is a [Tauri 2](https://tauri.app/) app: a React + TypeScript frontend in `src/` and a Rust backend in `src-tauri/`, with an embedded llama.cpp engine for the built-in translation models.

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

### App icon

The app icon's source is `src-tauri/icons/app-icon.svg`. After changing it, regenerate every size with:

```sh
pnpm tauri icon src-tauri/icons/app-icon.svg
```

The command also creates `android/` and `ios/` folders; delete them, as the app only ships for desktop. The website uses the same drawing without the outer margin in `site/icon.svg`, and its link-preview image is `site/og-image.svg` (render it to `site/og-image.png` with `rsvg-convert -w 1200 -h 630`).

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
- [ ] **Fallback check:** if TranslateGemma 4B fails to load or gives poor Thai to English output, confirm a Qwen model from the catalog works instead.
- [ ] Translator packages: export, open the zip as a translator, translate, re-export, then import with a conflict, and resolve it.
- [ ] TypeScript workspace on `src/test/fixtures/ts-locales` (a copy): Open project offers **Import TypeScript translations**; after import the " (EN)" cells show as missing, drafts can be accepted, `change_pw` shows **Duplicate key** and `maguro_brand` is read-only. Save leaves the `.ts`/`.tsx` files unchanged.
- [ ] Workspace auto-sync: with the workspace open, add a key to a `.ts` file in a text editor; it appears in the app. Change the same cell in both the app and the file: a conflict appears, and **Write back to the original files** refuses until it is resolved.
- [ ] Workspace exports: write back, write TypeScript to another folder, i18next JSON per group and single file (blocked while duplicates exist), Paraglide (blocked likewise), and TypeScript modules (table style).
- [ ] Workspace translator package: export it, open the zip as a translator (it opens as a workspace with no row marked **Removed in source**, and **Export…** doesn't offer **Write back to the original files**), translate, send back, import into the workspace, then write back to the code.
- [ ] **New project:** the default location is `~/Documents/Retrans/<name>/`; a non-empty folder is refused; add keys and languages, then export to each format.
- [ ] **Real TypeScript project:** on a fresh copy of a real project that uses TypeScript locale modules (never the original), open it, import, check the " (EN)" placeholders are flagged as missing, edit and review a few cells (one Thai, one English, one placeholder), Save, then **Write back to the original files**. In the copy, `git diff` shows only the changed strings, one line each, and `git status` shows no other changed files besides the new `.retrans/` folder.
- [ ] Updates: an update banner appears against a draft-free test release.
- [ ] Windows: suggestions work on a non-AVX2 machine if one is available, otherwise on any machine.

## Continuous integration

`.github/workflows/ci.yml` runs on every branch push and pull request, on macOS and Windows: frontend tests, type check, `cargo test`, and an engine smoke test with a tiny (1.2 MB) model whose SHA-256 is checked. On Windows it also builds the NSIS installer and fails if `llama.dll`, `ggml*.dll` or the `ggml-cpu-*.dll` variants are not next to `retrans.exe` in the installer.

`.github/workflows/pages.yml` publishes the website in `site/` to GitHub Pages whenever `site/` or `CHANGELOG.md` changes on `main`. The website's changelog shows released versions only; an `## [Unreleased]` section stays in `CHANGELOG.md` until release.

## Releasing

Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed. It builds macOS installers for Apple Silicon (M1 and later) only, and Windows installers, signs the updater artifacts, and uploads everything, including `latest.json`, to a **draft** GitHub release.

1. Bump `version` in `src-tauri/tauri.conf.json` and `package.json` (they must match; the workflow fails if the tag doesn't match both).
2. In `CHANGELOG.md`, rename `## [Unreleased]` to the new version and date, and add its link at the bottom.
3. Run the [manual checklist](#manual-checklist) on a real Mac and a real Windows machine.
4. Tag and push:

   ```sh
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

5. Wait for the workflow to finish and the draft release to appear.
6. Edit the release notes, then publish. Publishing is what makes `latest.json` reach users: the app checks `https://github.com/oxth/retrans/releases/latest/download/latest.json`, and drafts are not "latest".

### Updater key safety

Updates are signed with the Tauri updater key. The public key is in `src-tauri/tauri.conf.json`. The private key and its password live only in the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` and on the maintainer's machine.

- **Never commit the private key** or its password, and never paste them into issues or logs.
- **Back it up.** If the private key is lost, existing installs can no longer auto-update: every user would have to download and install a new version by hand.
