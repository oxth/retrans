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
- **Privacy:** translation runs entirely on your computer. The only network traffic is the model download from huggingface.co.

## First launch of an unsigned build

Releases are not code-signed for the OS, so the system warns on first launch.

- **macOS:** right-click the app and choose **Open**, then confirm. Alternatively, try to open it once, then go to **System Settings > Privacy & Security** and click **Open Anyway**.
- **Windows:** when SmartScreen appears, click **More info**, then **Run anyway**.

## Manual checklist

The core editing logic is covered by automated tests (`src/test/e2e-core.test.ts`, and `src/test/e2e-mt.test.ts` for batch machine translation with a fake engine). These GUI checks need a person, using `pnpm tauri dev` on a copy of each fixture in `src/test/fixtures/`:

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
