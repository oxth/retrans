# Paratrans — Design

Date: 2026-10-30
Status: Draft for review

## 1. Intent

Paratrans is a free desktop app for managing translation files for web projects that use **next-i18next** or **Paraglide (inlang)**.

**Why it exists.** In projects with many languages, the JSON translation files drift apart. A key gets added to one language and missed in another, and nobody notices until a raw key or blank text shows up on the frontend. Tolgee solves this well, but its free plan caps usage and the owner can't pay. Paratrans aims for the same everyday experience (a friendly grid, missing translations impossible to miss, review status, machine suggestions) while being completely free, with no usage limits, no account, and no server.

**Who it serves.**
- **Developer (owner):** opens or creates the project's translation folder, adds and renames keys, and commits the resulting files to git.
- **Non-technical translator:** never sees JSON. They open the same folder on their own machine (sent to them, or via a shared drive or git checkout), fill in the gaps, mark items reviewed, and save.

**What success looks like.** No more missing keys found on the frontend. A translator can work through every missing Thai string without help. Saved files produce clean, minimal git diffs.

## 2. Goals (version 1)

1. Desktop app for **macOS and Windows**, offline first.
2. **Open an existing project folder** and automatically detect next-i18next or Paraglide.
3. **Create a new project**: choose format, base language, target languages, and (for next-i18next) the first namespace, then generate the right folder structure.
4. A Tolgee-like translation screen with **List view and Table view, switchable**.
5. Missing translations are **highlighted, counted, and filterable**.
6. **Key management:** add, rename (across all languages), and delete keys; add and remove languages; add namespaces (next-i18next).
7. **Review status** per translation: Untranslated → Translated → Reviewed, with "needs review" when the base text changes.
8. **Placeholder checks:** warn when a translation's variables don't match the base language.
9. **Built-in local machine translation** (llama.cpp). It's off by default, and **no model is downloaded until the user enables it**.
10. **Save back in the same format** with minimal diffs.
11. Free build and distribution via GitHub Actions and GitHub Releases, with auto-update.

## 3. Non-goals (version 1)

- Accounts, login, permissions, and multi-user sync. These may come later; the approach is undecided.
- Web or browser version.
- Linux builds (likely easy later with Tauri, but not tested or shipped in v1).
- Paid code signing. Installers are unsigned; see §10.
- Cloud machine translation providers (DeepL, Google, and so on).
- Comments, screenshots, tags, translation memory, glossary, and in-context editing (Tolgee features not requested).
- Formats other than next-i18next and Paraglide.

## 4. Anti-goals (failure even if it "works")

- **Any cost or usage limit** for using the app itself.
- **Mangled or noisy files:** reordered keys, changed indentation, rewritten untouched files, lost `$schema` entries, or broken nested/flat structure. A save that touches nothing must change nothing on disk.
- **Lost work:** unsaved edits disappearing, or silently overwriting changes made on disk by someone else (for example, after a `git pull`).
- **Translation text leaving the machine** without the user knowing. The only network use is model downloads and update checks.
- **A large installer.** Models are never bundled.
- **Machine output treated as final.** Machine translations are never marked Reviewed automatically.
- **Writing empty strings for untranslated keys.** In i18next an empty string renders as blank instead of falling back. Untranslated keys must be omitted from that language's file.

## 5. Platform and tech (owner's decisions, then my calls)

**Decided by owner:**
- Desktop first: macOS and Windows.
- Free to build and distribute.
- Machine translation via a local LLM built into the app; models are downloaded only when enabled.
- UI and functionality similar to Tolgee, with both List and Table views and a toggle.
- Default model: suited to **Thai ↔ English**, the main languages in use.

**My calls (the builder may revisit with good reason):**
- **Tauri 2** (Rust back end) with a **React + TypeScript + Vite** front end. This keeps installers small and gives direct file-system access.
- A virtualized grid, so projects with thousands of keys stay smooth.
- The UI follows Tolgee's *layout and workflow* but uses Paratrans's own visual identity. Don't copy Tolgee's branding, logo, or assets.
- Working name **Paratrans**.

## 6. Core data model

Keep the internal model **independent of file format**, so format adapters (and later a sync backend) plug into it:

```
Project
  format: "next-i18next" | "paraglide"
  rootPath
  baseLocale, locales[]
  namespaces[]            // next-i18next only; Paraglide has a single implicit one
  keys: Map<(namespace, keyPath), Entry>
Entry
  values: Map<locale, Message>      // absent = untranslated
  meta per locale: { status, sourceHash, machine: bool }
Message
  simple string | complex (structured; see §7.2)
```

Format adapters handle **read → model** and **model → write**, and are responsible for preserving file style (§7.3).

## 7. File formats

### 7.1 next-i18next

- **Detection:** a `.paratrans/package.json` manifest if present (translator packages, §8.6), otherwise a `next-i18next.config.(js|mjs|cjs|ts)` file and/or a `public/locales/{locale}/{namespace}.json` layout. The user can override the locales path in project settings if detection fails. Read locales and default locale from the config where it can be parsed statically; otherwise infer them from folder names and ask the user to confirm the base language once.
- **Keys:** support both **nested objects** and **flat dotted keys**, and preserve whichever style each file already uses. Show keys in the UI as dotted paths (`home.title`).
- **Plurals:** recognize i18next v4 JSON plural suffixes (`_zero`, `_one`, `_two`, `_few`, `_many`, `_other`). In the UI, group them under one logical key with sub-fields. When adding a language, offer the plural forms that language needs (Thai needs only `_other`; English needs `_one` and `_other`). Use `Intl.PluralRules`.
- **Context suffixes** (such as `_male`) and **nesting** (`$t(other.key)`) are kept as ordinary keys and text in v1, with no special UI.
- **Placeholders:** `{{name}}`, including format modifiers such as `{{date, datetime}}`.

### 7.2 Paraglide (inlang)

- **Detection:** `project.inlang/settings.json`. Read `baseLocale`, `locales`, and the message-format plugin's `pathPattern` (for example `./messages/{locale}.json`). Writing back to `settings.json` is limited to the `locales` list when languages are added or removed; everything else in it is preserved.
- **Messages:** flat keys with string values; placeholders are `{name}`. Preserve the `$schema` entry in each messages file.
- **Complex messages** (variants/plurals in the inlang message format): v1 must **round-trip them untouched**. They appear in the grid with a "complex" badge and are edited in a raw JSON editor that checks the JSON is valid before saving. Machine translation skips them.
- **Supported version:** the current inlang message-format plugin and Paraglide 2.x. The builder should confirm the exact file shapes against the current docs before implementing.

### 7.3 Writing files (minimal diffs)

- Only write files whose content actually changed.
- Preserve existing key order. New keys go at the end of their parent object (nested) or file (flat).
- Detect and preserve indentation (spaces or tabs, width), line endings, and whether the file ends with a trailing newline.
- Untranslated keys are **omitted** from that language's file, never written as `""`.
- Writes are atomic (write to a temp file, then rename).
- **Required test:** for a set of fixture projects, open → save with no edits must produce byte-identical files.

### 7.4 Status side file

- next-i18next and Paraglide files can't hold metadata, so review status lives in **`.paratrans/state.json`** at the project root. It's meant to be committed to git alongside the translations.
- Per key per locale it stores `status`, `sourceHash` (a hash of the base-language text when that translation was last confirmed), and `machine` (true if accepted from machine translation and not since edited).
- Make the format stable and diff-friendly: sorted keys and one entry per line where practical, so merges are tolerable.
- On load, reconcile with the files: entries for keys that no longer exist are pruned. A translation present in the files with no state entry counts as Translated.
- If the file is missing (a project used outside Paratrans), everything still works, and statuses are derived as above.

## 8. Features

### 8.1 Start screen

- **Open project folder:** pick a folder, detect the format, and show what was found (format, languages, namespace and key counts) before opening.
- **Create new project** wizard:
  1. Format: next-i18next or Paraglide
  2. Base language and target languages (searchable locale list)
  3. next-i18next only: first namespace name (default `common`)
  4. Location on disk
  
  It generates:
  - next-i18next: `public/locales/{locale}/{ns}.json` for each locale (base file `{}`, others `{}`), plus a minimal `next-i18next.config.js` if none exists.
  - Paraglide: `project.inlang/settings.json` (base locale, locales, and the standard message-format plugin config) and `messages/{locale}.json` (with `$schema`).
- **Recent projects** list.

### 8.2 Translation screen (main)

- **Sidebar:** project name; Translations, Languages, Import/Export, Settings; a completion bar per language (translated ÷ total keys; the bar turns amber below a threshold).
- **Toolbar:** search (matches keys and translated text), filters (**Missing**, **Needs review**, **Machine-translated**, status, namespace), the **List / Table** toggle (remembered per project), and **+ Key**.
- **List view:** one row per key. On the left are the key path and namespace; on the right, the languages stacked with a status dot each.
- **Table view:** one column per language; key and base language columns are pinned. Columns can be hidden.
- **Editing:** click a cell to edit in place. Enter saves the cell, Shift+Enter inserts a newline, Esc cancels, and Tab jumps to the **next missing translation**. Multi-line text grows the editor.
- **Status dot:** red = Untranslated, yellow = Translated, green = Reviewed, plus a "needs review" marker. Click the dot (or use a shortcut) to mark Reviewed.
- **Warnings (they never block saving):** placeholder mismatch against the base text (missing or extra variables), and keys that exist in a target language but not the base ("orphan").
- **Mockup reference:** `.superpowers/brainstorm/*/content/translations-layout.html`.

### 8.3 Review status rules

- Editing a translation (by hand) → **Translated**, `machine=false`, and `sourceHash` updated.
- Accepting a machine suggestion → **Translated**, `machine=true`.
- Mark reviewed → **Reviewed**, and `sourceHash` updated.
- Editing a Reviewed translation → back to **Translated**.
- When base-language text changes, every other language whose `sourceHash` no longer matches shows **needs review**, whatever its prior status. Re-confirming (editing or marking reviewed) clears it.
- Clearing a translation → **Untranslated**.

### 8.4 Key and language management

- **Add key:** namespace (next-i18next), dotted path, base text; optionally a plural key.
- **Rename key:** applies to every language file and the state file; reject collisions.
- **Delete key:** with confirmation; removes it from all languages.
- **Add language:** creates its empty files and records it in `.paratrans/state.json`. For Paraglide, it also updates the `locales` array in `settings.json` (plain JSON, so it's safe to edit). **Remove language:** with confirmation; deletes its files.
- **Never edit JS/TS code (my call).** Paratrans never rewrites `next-i18next.config.*` or `next.config.*`. After adding or removing a next-i18next language, it shows the updated `locales` line with a Copy button and a note telling the developer to paste it into their config. Detection treats folder names under the locales path as the source of truth for which languages exist. This avoids a code-editing component and the risk of mangling config files.
- **Add namespace** (next-i18next).
- Moving keys between namespaces is **not in v1**.

### 8.5 Saving and external changes

- Edits are held in memory with an unsaved indicator. **Cmd/Ctrl+S** saves all changed files. Closing with unsaved changes prompts the user.
- **Unsaved edits survive a crash:** keep a recovery journal in the app data folder and offer to restore it on the next launch.
- **File watcher:** if files change on disk (for example a `git pull`) and there are no unsaved edits, reload silently. If there are unsaved edits that conflict with on-disk changes for the same key and locale, show both values and let the user pick. Changes to different keys merge automatically.

### 8.6 Import / Export

- In v1, **opening the folder is the import**, and **saving is the export**.
- **Translator package (my call).** "Export for translator" writes a `.zip` that **is a complete, openable project**. It holds the locale files in their normal layout, `.paratrans/state.json`, the Paraglide `project.inlang/settings.json` or a copy of the next-i18next config, and a small `.paratrans/package.json` manifest (format, base locale, locales, export time, source project id). The translator opens the zip (or its unzipped folder) like any project; the manifest guarantees detection even without the dev setup. The export can optionally be limited to selected languages.
- **Importing a package back** shows a per-key, per-locale diff: new, changed, and conflicting values **and statuses**. The translator's Reviewed and `machine` flags travel with their values. Changes to different keys merge automatically. When both sides changed the same key and locale, the user picks one. Status conflicts follow the chosen value.
- Importing a plain folder of locale files (no manifest) also works and merges values only.

## 9. Machine translation (local LLM)

### 9.1 Behavior

- **Off by default.** The installer contains the inference engine but **no model**.
- **Settings → Machine Translation:** enable it, then choose a model from the catalog (§9.2) or "Use my own GGUF file." Each option shows its download size, RAM needed, languages, and license *before* downloading.
- **Download:** progress bar, pause/resume/cancel, resume after interruption, and checksum verification. Models are stored in the app data folder, not the project. Settings shows the space used, with **Delete model**.
- **Suggestion:** when an untranslated cell is focused, generate a suggestion from the base text and show it beneath the editor. One click (or a shortcut) accepts it.
- **Translate all missing:** per language (optionally filtered by namespace), with a progress bar, cancel, and results marked `machine=true` for review.
- **Placeholder safety:** before translating, replace placeholders (`{{x}}`, `{x}`, `$t(...)`, HTML-like tags) with opaque tokens, and restore them afterward. If any token is lost or duplicated, discard the suggestion and show "couldn't translate safely."
- **No network** during translation.
- **"Test this model":** a small panel to translate a sample sentence, so users can judge quality on their own language pair.
- Complex Paraglide messages are skipped.

### 9.2 Model catalog (initial)

| Tier | Model | Approx. download (Q4) | RAM guidance | License |
|---|---|---|---|---|
| Small | Qwen3 1.7B Instruct | ~1.1 GB | 8 GB | Apache 2.0 |
| **Recommended (default)** | TranslateGemma 4B | ~2.5–3 GB | 8–16 GB | Gemma terms |
| Best quality | TranslateGemma 12B | ~7–8 GB | 16–32 GB | Gemma terms |
| Best quality (alt) | Qwen3 8B Instruct | ~5 GB | 16 GB | Apache 2.0 |
| Custom | Any llama.cpp-compatible GGUF | — | — | User's responsibility |

- The default is chosen for **Thai ↔ English**, and both TranslateGemma and Qwen3 support Thai.
- **Excluded for licensing:** NLLB-200 and Aya Expanse (non-commercial), and Hunyuan-MT (regional restrictions).
- **Gemma license handling:** official Google repositories are gated on Hugging Face. Show the Gemma terms in the app with an **Accept & download** button, and download from a public, ungated GGUF build. An ungated community build exists for the 4B model (`42ailab/TranslateGemma-4B-GGUF`, Q4_K_M ≈ 2.49 GB, checked 2026-10-30). Pin each download by exact file URL and SHA-256 checksum.
- **Fallback (my call):** if the builder can't find a trustworthy ungated GGUF for a TranslateGemma entry (one that loads in the bundled llama.cpp and gives sensible Thai↔English output), that entry is dropped and **Qwen3 4B Instruct (Apache 2.0, ~2.5 GB)** becomes the Recommended default. Paratrans **never hosts model files itself**: no mirror, no infrastructure, no cost.
- Keep the catalog as data (a JSON file shipped with the app, updatable with app releases) so models can be swapped without code changes.
- Use each model's own recommended prompt template. TranslateGemma has a specific translation template; Qwen3 uses a short instruction prompt with thinking disabled.

### 9.3 Engine

- llama.cpp, embedded via Rust bindings or shipped as a sidecar binary (the builder decides). Requirements: GPU acceleration via Metal on Apple Silicon; a CPU path that works on any Windows x64 machine, plus GPU acceleration (for example Vulkan) where it doesn't bloat the installer much; and **a total installer size target under ~40 MB**.
- Load the model only when it's first needed; unload after a period of inactivity to free RAM.

## 10. Distribution

- **GitHub Actions** builds macOS (Apple Silicon + Intel, or universal) and Windows x64 installers on tag push. **GitHub Releases** hosts them.
- **Auto-update** via Tauri's updater, which uses a free update-signing key that is separate from OS code signing.
- **Unsigned for OS purposes.** The README and the download page explain the first-launch steps: macOS right-click → Open (or the System Settings "Open Anyway"); Windows SmartScreen → More info → Run anyway.
- Network use is limited to update checks and model downloads. There is no telemetry in v1.

## 11. Quality bar

- Round-trip fixture tests for both formats (nested/flat, plurals, `$schema`, complex Paraglide messages, tabs/spaces, CRLF/LF, no trailing newline): byte-identical when nothing was edited, and minimal diffs when one value changes.
- Unit tests for the status rules (§8.3) and placeholder extraction/compare/tokenize (§9.1).
- Stays smooth with **5,000 keys × 10 languages**.
- Manual test passes on a real Mac and a real Windows machine before each release.

## 12. Later (not v1, but don't block it)

- **Accounts, sharing, permissions, and sync:** possible future direction, approach undecided. The only v1 requirement is §6's format-independent data model, so sync could be added later as another adapter.
- Cloud machine-translation providers using the user's own keys (DeepL Free and others).
- Linux build, code signing, comments, glossary.

## 13. Left to the builder

- UI component library and styling approach, theme (light/dark), icons.
- State management, grid library, and file-watching library.
- How llama.cpp is integrated (§9.3), within the size and acceleration constraints.
- Exact `.paratrans/state.json` schema, within §7.4's rules.
- Keyboard shortcuts beyond those listed.
