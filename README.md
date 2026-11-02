# Retrans

Retrans is a free desktop app for managing translation files in web projects that use **next-i18next** or **Paraglide (inlang)**. It shows every key and language in one grid, makes missing translations impossible to miss, tracks review status, and saves minimal, git-friendly diffs. It needs no account, no server and has no usage limits.

## Requirements

- Node.js 20+
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

1. **Export (developer).** Save your project, then open the **Import / Export** page, and under **Export for translator** pick the languages and click **Export...**. Save the zip. Export refuses while there are unsaved edits.
2. **Send the zip.** Any channel works.
3. **Open (translator).** On the start screen choose **Open translator package...**, pick the zip, and choose an empty folder to extract it into. Retrans never edits files inside the zip.
4. **Translate.** Edit and mark cells Reviewed as usual, then Save.
5. **Send back (translator).** On the Import / Export page, under **Send back to the developer**, click **Export...**. The original baseline is kept, so the developer can tell what changed.
6. **Import (developer).** On the Import / Export page choose **Import package (.zip)...** (or **Import folder...**). Cells the translator filled are added, status changes are applied, and cells both of you changed differently are listed as conflicts to resolve. Your own edits elsewhere are untouched, and the base language is never changed.
7. **Review and save.** Check the imported cells, then Save.

## First launch of an unsigned build

Releases are not code-signed for the OS, so the system warns on first launch.

- **macOS:** right-click the app and choose **Open**, then confirm. Alternatively, try to open it once, then go to **System Settings > Privacy & Security** and click **Open Anyway**.
- **Windows:** when SmartScreen appears, click **More info**, then **Run anyway**.

## Manual checklist

The core editing logic is covered by automated tests (`src/test/e2e-core.test.ts`, `src/test/e2e-mt.test.ts` for batch machine translation with a fake engine, and `src/test/e2e-package.test.ts` for the translator package round trip). These GUI checks need a person, using `pnpm tauri dev` on a copy of each fixture in `src/test/fixtures/`:

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
- [ ] Updates: an update banner appears against a draft-free test release (after the first real release).
- [ ] Windows: suggestions work on a non-AVX2 machine if one is available, otherwise on any machine.

## Continuous integration

`.github/workflows/ci.yml` runs on every branch push and pull request, on macOS and Windows: frontend tests, type check, `cargo test`, and an engine smoke test with a tiny (1.2 MB) model whose SHA-256 is checked. On Windows it also builds the NSIS installer and fails if `llama.dll`, `ggml*.dll` or the `ggml-cpu-*.dll` variants are not next to `retrans.exe` in the installer.

## Releasing

Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed. It builds macOS (Apple Silicon and Intel) and Windows installers, signs the updater artifacts, and uploads everything, including `latest.json`, to a **draft** GitHub release.

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
