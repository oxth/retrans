# Retrans — Workspaces and TypeScript locale sources (Design)

Date: 2026-11-03
Status: Draft for review
Extends: `docs/superpowers/specs/2026-10-30-paratrans-design.md` (the app is now named **Retrans**; project folder `.retrans/`). Everything in that spec still applies unless this document says otherwise.

## 1. Intent

Some real projects don't keep translations in JSON. The owner's own project, `axons-cms` (TanStack + react-i18next), keeps them in TypeScript modules under `src/assets/locales/` and assembles them in `src/utils/i18n.ts`. Retrans can't open it today, so the same pain the app was built for — missing translations found only on the frontend — remains there. The project even marks untranslated English strings by hand, e.g. `'ลบ (EN)'` (Thai text with "(EN)" appended).

This design adds a **workspace**: Retrans's own format-independent store of keys, languages, translations and review statuses. TypeScript sources are **imported** into a workspace and only written when the user explicitly **exports**. New projects become format-free workspaces whose output format is chosen at export time.

**Success:** the owner opens `axons-cms`, sees every key in `th` and `en` with the "(EN)" placeholders flagged as missing, translates and reviews them (incl. machine translation and translator packages), exports back to the same `.ts`/`.tsx` files, and the git diff shows only the changed strings.

## 2. Goals

1. **Import TypeScript locale modules** (both styles in §4) into a workspace, without modifying the source files.
2. **Save writes only the workspace.** Source files are never touched by Save.
3. **Export** as a separate, explicit action with three destinations:
   1. **Write back to the original files** (same paths), minimal diffs.
   2. **Write to another folder** (same format).
   3. **Write in another format:** i18next JSON (next-i18next layout), Paraglide messages, or TypeScript modules.
4. **Auto-sync from source:** detect changes to the imported source files (on open and while open) and merge them into the workspace.
5. **Format-free new projects:** "Create new project" no longer asks for a format; the format is chosen at export.
6. Every existing feature works on workspaces: List/Table views, missing highlighting and counts, review status rules, placeholder warnings, key/language management, machine translation (suggestions and translate-all), translator packages, crash recovery.

## 3. Non-goals

- Editing arbitrary TypeScript/JavaScript code. Retrans only edits string literal values inside the recognized translation objects (§4); anything else in a file is left byte-for-byte.
- Rewriting `src/utils/i18n.ts`, the `mapLocale` helper or any other code. When a change needs code (e.g. a new language for a TS project, a new locale file that must be imported in `i18n.ts`), Retrans shows the code to paste with a Copy button — the same rule as next-i18next configs today (original spec §8.4).
- Changing how existing **JSON** (next-i18next) and **Paraglide** projects work: they keep opening and saving directly, as today. (Owner confirmed by not objecting; marked as the default reading.)
- Real-time multi-user editing.

## 4. TypeScript source formats (as found in `axons-cms`)

33 files in `src/assets/locales/` (`.ts` and `.tsx`), two styles, plus a helper and tests:

**Split style** (26 files, e.g. `button.tsx`, `change-password.ts`):
```ts
export const buttonTH = { button_save: 'บันทึก', button_ok: 'ตกลง', ... };
export const buttonEN = { button_save: 'Save', button_ok: 'OK', ... };
```
One exported object per language. The language is the export-name suffix (`TH`, `EN`). Export-name prefixes do not always match the file name (`dashboardMaguro.tsx` exports `maguroTH`/`maguroEN`).

**Table style** (6 files: `common.ts`, `breadcrumb.tsx`, `cameraSetting.tsx`, `menu.tsx`, `notificationChannel.tsx`, `user.tsx`):
```ts
const common = { email: { th: 'อีเมล', en: 'Email' }, ... };
export const commonTH = mapLocale(common, 'th');
export const commonEN = mapLocale(common, 'en');
```
One object of `{ th, en }` pairs; `mapLocale` (in `mapLocale.ts`) derives the per-language objects. Either side of a pair may be absent.

**Not translation files:** `mapLocale.ts` (the helper) and `__tests__/` must be ignored.

**Values:** mostly single-quoted strings (some double-quoted), sometimes split across lines after the key, containing `{{placeholders}}`, `<0>…</0>` tags and `\n`/`\t` escapes. Quote style is preserved per literal on write. Some keys exist in only one language (e.g. `zone_name`). All keys are flat (no nesting) and all files feed one i18next namespace (`translation`).

**Duplicate keys across files (owner decision):** keys are *not* guaranteed unique — e.g. `change_pw` is in `common.ts` (th + en) and in `change-password.ts` (en only); at runtime the file spread later in `i18n.ts` wins. Retrans shows each file's copy as **its own row** (`common › change_pw`, `change-password › change_pw`) with a **"duplicate key"** warning, and each is edited where it lives. Export to a format where keys must be unique (single-namespace JSON, Paraglide) is **blocked** until duplicates are resolved (the dialog lists them). Export back to TypeScript and to one-namespace-per-group JSON is allowed.

**Untranslated marker (owner decision):** **any** value ending in ` (EN)` in the `en` language means "not translated yet" — whether the text before it is a copy of the Thai (`'ลบ (EN)'`), drifted Thai, or a real English draft (`'Age (EN)'`, `'Reset password (EN)'`). Such a cell counts as **missing** (red, counted, filterable, offered to machine translation). When the text before ` (EN)` is not just the Thai value, it is shown under the cell as a **draft** the user can accept with one click (accepting = a normal hand edit, status Translated). Writing a real translation replaces the marker. On export, a still-missing cell that held a marker keeps its marker text (so the running app still shows something), and because the rule is "ends in ` (EN)`" it is still recognized as missing on the next import/sync even if the Thai changed. The same rule applies to other target languages with their own code (e.g. ` (JA)` for `ja`) if such languages appear.

Unrecognized shapes in a locale file (computed values, template literals with `${}`, spreads, functions) are shown read-only with a "can't edit here" note and are written back untouched.

## 5. The workspace

**What it holds:** keys grouped by **group** (for TS imports: one group per source file, named after the file, e.g. `button`, `common`), languages (base first), values per language, review status per cell (same rules as original spec §8.3), project settings, and — for imported workspaces — the **source mapping**: for each key and language, which file, which object and which style it came from, plus a baseline of the last imported/exported source values (used for sync and conflict detection).

**Where it lives:**
- Opened from an existing project (e.g. `axons-cms`): inside that project, `axons-cms/.retrans/`, next to the existing status file, so it can be committed and shared through git.
- Created as a new project: the user picks the location; the default is `~/Documents/Retrans/<project name>/`.

**File form (builder's call within these rules):** stable and diff-friendly like `state.json` — sorted keys, one entry per line where practical, so git merges are tolerable; readable JSON; includes a format version. A project that has both a workspace and the existing `state.json` must not end up with two disagreeing sources of review status — the builder decides how they relate, and documents it.

**Save** writes only the workspace (atomic write, unsaved-indicator and crash recovery as today).

**Recent projects / start screen:** workspaces appear in Recent projects like folders do. "Open project" on a folder that contains a workspace opens the workspace.

## 6. Importing a TypeScript project

- **Detection:** a folder (project root or `src/assets/locales` directly) whose locale files match §4. For `axons-cms` the user may point at the project root; Retrans finds the locales folder (the builder decides how; a settings override for the locales path, like today's, is acceptable).
- **Languages:** from the split-style suffixes and the table-style pair keys (`th`, `en`). Base language: ask once if it can't be inferred, and remember it (same as today). For `axons-cms` the base is `th`.
- The import reads files only. The workspace is created in `<project>/.retrans/` on first Save.

## 7. Sync from source (auto-detect and merge)

While a workspace is open, and whenever it is opened, Retrans compares the imported source files with the workspace's baseline and merges changes automatically:

- **New key in code** (e.g. a developer adds `button_export` to `buttonTH`/`buttonEN`): added to the workspace in the right group with whatever languages were filled; absent languages show as missing.
- **Value changed in code, unchanged in the workspace:** take the code's value.
- **Changed in both:** show both and let the user pick (same conflict UI as today). Never a silent overwrite.
- **Key deleted from code:** mark it "removed in source"; the user confirms deletion. Nothing disappears unseen.
- **New source file** (new group): imported as a new group. **Deleted source file:** its keys are marked "removed in source".

## 8. Export

An **Export…** action (on the Import / Export page, and reachable from the main screen) opens a dialog:

1. **Write back to the original files** (only for imported workspaces): rewrite the same `.ts`/`.tsx` files.
   - Only changed string literals are rewritten; everything else is byte-identical (quotes style, indentation, line breaks, comments, code).
   - A new key goes at the end of its group's object(s): in split style into **every** language object of that file (`buttonTH` and `buttonEN`); in table style as a new `{ th, en }` entry. Each file keeps its own style.
   - A new group (created in Retrans) becomes a new file in the locales folder in table style, and Retrans shows the import/spread lines to paste into `i18n.ts`.
   - **A language added in Retrans** that the source files don't have (e.g. `ja`) is **not** written into the existing TS files (that would need structural edits in every file plus a change to `mapLocale`'s `'th' | 'en'` type, which Retrans never edits). Write-back covers the languages the source already has; the dialog says which languages were left out and points to exporting them in another format or adding them to the code (with the snippet: the extra export/field pattern and the `mapLocale` type change). *(My call.)*
   - A key deleted in Retrans is removed from the file(s).
   - **Safety:** before writing, check whether the source files changed since the workspace's baseline; if so, run the sync merge (§7) first and only write after conflicts are resolved. Export never overwrites someone else's change. Atomic writes.
   - Untranslated cells follow §4 (marker kept if it was there; otherwise the key is omitted for that language, or — in split style, if omitting would break the TS type — the builder picks the least surprising behavior and documents it).
2. **Write to another folder:** same format and layout, chosen folder.
3. **Write in another format:**
   - **i18next JSON** in the next-i18next layout (`<folder>/<locale>/<namespace>.json`). Group → namespace mapping is the user's choice in the dialog: one namespace per group, or everything in one namespace (`translation`) — `axons-cms` uses a single namespace, so that option must exist.
   - **Paraglide** messages (`messages/<locale>.json` + `project.inlang/settings.json`). Groups are flattened (keys are unique).
   - **TypeScript modules:** table style with a generated `mapLocale` helper, one file per group, plus the `i18n.ts` snippet to paste.
   - Untranslated keys are omitted (original spec anti-goal: never write empty strings).
- Export remembers the last destination and options per workspace, so repeat exports are one click.
- **Scope:** this Export dialog is for **workspaces** (imported TS projects and format-free new projects). Direct-edit JSON and Paraglide projects keep their current Save and translator-package export; converting them to other formats is not in this version. *(My call; keeps the existing session model as is. The export layer should take format-independent data so it can be reused for that later.)*
- Translator packages (Plan 3) export/import the workspace itself.

## 9. Format-free new projects

"Create new project" asks for: project name, base language, target languages, and location (default `~/Documents/Retrans/<name>/`, or user's choice). No format, no translation files. The user adds groups/keys and translates; the format is chosen at **Export** (§8.3). A workspace can be exported to several formats over time.

## 10. Anti-goals (in addition to the original spec's)

- Save ever touching TypeScript source files.
- Any edit outside string-literal values of recognized translation objects in a TS file.
- Silent loss: a key removed or a value overwritten without the user seeing it (sync and export both).
- Treating the "(EN)" markers as real translations.
- A large installer: the TS parsing approach must keep the installer within the original size target (~40 MB).

## 11. Quality bar

- Round-trip tests on a copy of the `axons-cms` locales (or a fixture reproducing both styles, multi-line values, `\n` escapes, `{{placeholders}}`, `mapLocale.ts` and `__tests__`): import → export back with no edits = byte-identical files; one edit = a one-line diff.
- Sync tests for every case in §7; export-safety test (source changed since baseline → merge before write).
- Export tests for each target format, including single-namespace JSON for `axons-cms`.
- Smooth with 5,000 keys × 10 languages (existing bar).

## 12. Left to the builder

- How TypeScript is parsed and edited (e.g. a parser that gives exact source positions so only literal ranges are rewritten), within the installer-size limit and offline.
- The workspace file's exact schema and how it relates to the existing `.retrans/state.json`.
- How the locales folder is found from a project root, and UI wording/placement of the Export dialog.
- Whether the workspace is implemented as a new storage behind the existing session model or as a separate model, as long as all existing features work on it.

## 13. Calls I made (owner to check)

- TS sources use the workspace model; JSON/Paraglide projects keep direct editing.
- Groups = source files; keys are flat. (Owner decided: duplicates across files are separate rows with a warning; unique-key exports blocked until resolved.)
- (Owner decided: any value ending in " (EN)" is missing, with an English draft shown when there is one.) Markers are preserved on export while still untranslated.
- A language added in Retrans isn't written into existing TS files; it goes out through the other export formats.
- The new Export dialog is for workspaces only; JSON/Paraglide projects aren't converted in this version.
- New TS files and new languages need a pasted snippet in `i18n.ts`; Retrans never edits that file.
- Exporting a format-free project to TypeScript uses the table style with `mapLocale`.
- Export to JSON offers "one namespace per group" or "single `translation` namespace".
