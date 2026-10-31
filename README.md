# Paratrans

Paratrans is a free desktop app for managing translation files in web projects that use **next-i18next** or **Paraglide (inlang)**. It shows every key and language in one grid, makes missing translations impossible to miss, tracks review status, and saves minimal, git-friendly diffs. It needs no account, no server and has no usage limits.

## Requirements

- Node.js 20+
- pnpm
- Rust (stable toolchain) and the [Tauri 2 platform prerequisites](https://tauri.app/start/prerequisites/)

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

## Build

```sh
pnpm tauri build
```

Installers and bundles end up in `src-tauri/target/release/bundle/`.

## First launch of an unsigned build

Releases are not code-signed for the OS, so the system warns on first launch.

- **macOS:** right-click the app and choose **Open**, then confirm. Alternatively, try to open it once, then go to **System Settings > Privacy & Security** and click **Open Anyway**.
- **Windows:** when SmartScreen appears, click **More info**, then **Run anyway**.

## Manual checklist

The core editing logic is covered by automated tests (`src/test/e2e-core.test.ts`). These GUI checks need a person, using `pnpm tauri dev` on a copy of each fixture in `src/test/fixtures/`:

- [ ] The window opens and the project loads from the chosen folder.
- [ ] Tab moves to the next missing cell; fill a missing Thai cell this way and mark it reviewed.
- [ ] Changing the English text shows the Thai cell as needing review.
- [ ] Add, rename and delete a key; add the language `ja`; save. `git diff` in the fixture copy shows only the intended lines.
- [ ] Edit a translation file in a text editor while the app is open: the app picks up the change, and a conflicting unsaved cell shows the conflict dialog.
- [ ] Closing the window with unsaved edits shows the close prompt.
- [ ] While the conflict dialog is open, Save / Cmd+S don't save ("Resolve conflicts before saving").
- [ ] Put git conflict markers into `.paratrans/state.json`: the load-error banner lists it, saving still writes translations, and the file is left untouched until it's fixed.
- [ ] Kill the app with unsaved edits, reopen the project, and the restore prompt appears.
