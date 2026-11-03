# Retrans Workspaces and TypeScript Locale Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Import TypeScript locale modules (as in `axons-cms`) into a Retrans **workspace**.
- Save edits only to the workspace.
- Auto-merge changes from the source files.
- Export explicitly, either back to the original files (with minimal diffs) or to another folder or format.
- Make "Create new project" format-free.

**Architecture:**

*Storage reuses existing machinery.*
- A workspace is stored as **next-i18next-layout JSON inside the project**, at `.retrans/workspace/<locale>/<group>.json` (flat keys).
- Alongside it sit a meta file, `.retrans/workspace.json`, and a source baseline, `.retrans/source-baseline.json`.
- `ProjectSession` therefore runs unchanged on top of the existing next-i18next adapter, pointed at that folder. Editing, minimal-diff saves, review status (`.retrans/state.json`), conflicts, the recovery journal, file watching, machine translation and packages all keep working.

*TypeScript handling is a separate, pure layer.*
- `src/tssource/` parses locale modules with `@babel/parser`, which gives exact source positions.
- It imports them into model data, and writes them back by splicing only string-literal ranges.

*Sync and export sit on top.*
- Sync uses the existing three-way `mergeCells`.
- Export turns a session into a list of files, which are then written atomically.

**Tech Stack:** existing (Tauri 2, React 19, TS 6, Vitest, Zustand). New: `@babel/parser` `~8.0.10` (pure JS, offline; only `parse` with the `typescript` and `jsx` plugins).

**Spec:** `docs/superpowers/specs/2026-11-03-retrans-workspaces-design.md`. It extends `docs/superpowers/specs/2026-10-30-paratrans-design.md`.

## Global Constraints

**Source files:**
- **Save never writes TypeScript source files.** Only Export writes them.
- In TS files, only string-literal values of recognised translation objects are edited. Everything else stays byte-for-byte: quotes, indentation, line breaks, comments, code.
- **Never edited by Retrans:** `src/utils/i18n.ts`, `mapLocale.ts`, any non-locale code. Where code would have to change, show a copyable snippet instead.
- **Ignored on import:** `mapLocale.ts`, anything under `__tests__/`, and `*.test.*` / `*.spec.*` files.

**Untranslated marker:** any value in language `xx` that ends with ` (XX)`, e.g. ` (EN)` for `en`.
- It counts as **missing**.
- If the text before the marker isn't just the base-language value (compared after trimming whitespace), that text is a **draft**.
- On export, a cell that is still missing and still had a marker in the source keeps its original marker text.

**Duplicate keys:** the same key in two groups gives two rows with a "duplicate key" warning. Export to single-namespace JSON and to Paraglide is **blocked** while duplicates exist.

**Exports:**
- Untranslated keys are omitted from JSON and Paraglide exports; never write `""`.
- A language added in Retrans is **not** written into existing TS files. Write-back reports it as left out.
- **Write-back safety:** if the source changed since the baseline, run sync first and write only once there are no open conflicts.

**Locations:**
- **Imported project:** the workspace lives in `<project>/.retrans/`.
- **New project:** the default location is `~/Documents/Retrans/<name>/`, and the user can choose another.
- **JSON / Paraglide projects:** behaviour unchanged. The new Export dialog is for workspaces only.

**Copy:** exact strings appear in the tasks.

**Verification:**
- `pnpm test`, `pnpm exec tsc --noEmit` and `cd src-tauri && cargo test` pass after every task.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Branch:** `feat/workspaces`, created from `main`.

## Review Focus

1. **Source folder missing or moved.** Triggers: a translator opens a workspace package with no source, the project is cloned without `src`, or the folder is renamed. Expected: sync does nothing and shows `Source files not found — showing the saved workspace.` It must **never** mark keys "removed in source". Tested in Task 6.
2. **No-op round trip.** Import followed by write-back with no edits must leave every file byte-identical. This covers CRLF, a BOM, double-quoted literals, `\n`/`\t`/`\'` escapes, Thai, multi-line `key:\n  'value'`, a trailing comma or none, and `(EN)` markers. Tested in Tasks 4 and 5.
3. **Awkward user text.** A value containing `'`, `"`, `\`, a newline, `${` or a backtick is written as a valid TS string literal that parses back to the same value. Tested in Task 4.
4. **Source changed before write-back** (e.g. after a `git pull`). Sync runs first; a value changed on both sides becomes a conflict, and the export refuses until it is resolved. Tested in Task 5.
5. **Export blocked by duplicates.** A single-namespace or Paraglide export with duplicate keys is blocked with the list of keys; per-group JSON and TS exports still work. Tested in Task 5.

---

## File Structure

```
src/workspace/meta.ts       WorkspaceMeta type, paths, parse/serialize, baseline read/write
src/workspace/store.ts      detectWorkspace(), createWorkspace(), workspace-aware open options
src/tssource/parse.ts       parseLocaleModule(): AST → LocaleModule (entries with literal ranges)
src/tssource/import.ts      findLocalesDir(), importTsLocales(): files → model data, markers, drafts, duplicates
src/tssource/write.ts       applyTsEdits(), encodeTsString(), newTableModule(), i18nSnippet()
src/workspace/sync.ts       syncFromSource(): three-way merge of source into the workspace
src/workspace/export.ts     planExport(), writeExportPlan()
src/ui/ImportTsDialog.tsx, src/ui/ExportDialog.tsx
src/test/fixtures/ts-locales/   fixture project reproducing axons-cms patterns
```

Modified:
- `src/formats/adapter.ts`: `DetectResult.workspace?`
- `src/formats/detect.ts`
- `src/core/session.ts`: `workspace` field; meta saved on save; no config snippet for workspaces
- `src/ui/StartScreen.tsx`, `src/ui/NewProjectWizard.tsx`, `src/ui/Cell.tsx`, `src/ui/Warnings.tsx`, `src/ui/SharePage.tsx`, `src/ui/LanguagesPage.tsx`, `src/ui/KeyDialogs.tsx`, `src/ui/AppShell.tsx`
- `src/package/build.ts`
- `README.md`

---

### Task 1: Workspace storage, meta and detection

**Files:**
- Create: `src/workspace/meta.ts`, `src/workspace/store.ts`
- Modify: `src/formats/adapter.ts`, `src/formats/detect.ts`, `src/core/session.ts`, `src/ui/LanguagesPage.tsx`, `src/ui/KeyDialogs.tsx`, `src/ui/AppShell.tsx`
- Test: `src/workspace/store.test.ts`

**Interfaces:**
- **`meta.ts`:**
  - `WORKSPACE_META_PATH = ".retrans/workspace.json"`
  - `WORKSPACE_DIR = ".retrans/workspace"`
  - `BASELINE_PATH = ".retrans/source-baseline.json"`
  - `interface TsSourceRef { type: "ts"; localesDir: string }`. `localesDir` is root-relative.
  - `type ExportTarget = { kind: "ts-writeback" } | { kind: "ts-copy"; dir: string } | { kind: "ts-modules"; dir: string } | { kind: "i18next-json"; dir: string; namespaces: "per-group" | "single" } | { kind: "paraglide"; dir: string }`. It is defined here so the meta can store it; Task 5 uses it.
  - `interface ExportSettings { target: ExportTarget }`
  - `interface WorkspaceMeta { retransWorkspace: 1; name: string; source?: TsSourceRef; drafts: Record<KeyId, Record<string, string>>; markers: Record<KeyId, Record<string, string>>; removedInSource: KeyId[]; duplicates: string[]; lastExport?: ExportSettings }`
  - `parseWorkspaceMeta(text: string | null): WorkspaceMeta | null`. It never throws.
  - `serializeWorkspaceMeta(m): string`. Sorted keys, 2-space indent, trailing newline (same style as `serializeState`).
  - `type Baseline = Record<KeyId, Record<string, string>>`, with `parseBaseline` and `serializeBaseline` in the same style.
- **`store.ts`:**
  - `detectWorkspace(fs: Fs, root: string): Promise<DetectResult | null>`. It reads the meta, then runs `nextI18nextAdapter`'s listing on `WORKSPACE_DIR` and returns `{ format: "next-i18next", localesPath: WORKSPACE_DIR, workspace: meta, ... }`. The base locale comes from `state.json`'s pinned base or from detection.
  - `createWorkspace(fs: Fs, root: string, opts: { name: string; baseLocale: string; locales: string[]; group?: string }): Promise<void>`. It writes the meta and `{}` files at `WORKSPACE_DIR/<locale>/<group ?? "common">.json`, and pins the base in `state.json` (as `pinBaseLocale` does).
- **`adapter.ts`:** `DetectResult` gains `workspace?: WorkspaceMeta`.
- **`detect.ts`:** `detectProject` checks `detectWorkspace` first, then the existing checks. The package manifest stays first if present.
- **`session.ts`:**
  - `readonly workspace: WorkspaceMeta | null`, set from `DetectResult.workspace` in `open`.
  - `setWorkspaceMeta(patch: Partial<WorkspaceMeta>): void` marks the session dirty.
  - `save()` also writes the meta when it changed.
  - For workspaces, `addLanguage` returns no `configSnippet`, and new files are always `shape: "flat"`.
- **UI:** where the UI says "namespace" for next-i18next, a workspace shows **"Group"** (labels only). The LanguagesPage config snippet is hidden for workspaces.

- [ ] **Step 1: Write the failing tests:**
  - `"createWorkspace then detect/open: groups, locales, base"`: create with `{name: "Demo", baseLocale: "th", locales: ["th","en"]}`. Detect gives `workspace.name === "Demo"`, `localesPath === ".retrans/workspace"`, `locales` = `["th","en"]`, `baseLocale` = `"th"`, and `namespaces` = `["common"]`.
  - `"edits save into .retrans/workspace and meta round-trips"`: `addKey("common","hello","สวัสดี")` + `setText(en)` + save → `.retrans/workspace/en/common.json` equals `{\n  "hello": "Hello"\n}\n`, flat. `setWorkspaceMeta({removedInSource: ["common::x"]})` + save + reopen → the value is kept.
  - `"addLanguage in a workspace returns no config snippet"`.
  - `"meta parse rejects garbage without throwing"`.
  - `"a plain next-i18next project still detects as before"` (no `workspace` field).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Run `pnpm test`. Expected: PASS, with existing tests green.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(workspace): storage, meta and detection"
  ```

---

### Task 2: Parsing TypeScript locale modules

**Files:**
- Create: `src/tssource/parse.ts`, the fixture folder `src/test/fixtures/ts-locales/src/assets/locales/` (files below) and `src/test/fixtures/ts-locales/src/utils/i18n.ts`
- Modify: `package.json` (add `@babel/parser` `~8.0.10`)
- Test: `src/tssource/parse.test.ts`

**Fixture** (reproduces the `axons-cms` patterns; written by the implementer exactly as listed):
- `button.tsx`: split style, `buttonTH`/`buttonEN`, 4 keys. Includes one en marker `'ลบ (EN)'` (th `'ลบ'`), one draft marker `'Reset password (EN)'`, and a key with no trailing comma on the last property.
- `common.ts`: table style. `import { mapLocale } from '@/assets/locales/mapLocale';`, `const common = {...}` with:
  - a multi-line pair (`key: {\n    th: '…',\n    en: '…',\n  },`);
  - a value with `{{minutes}}`;
  - a value with `\n`;
  - one double-quoted value;
  - a pair with only `th`;
  - `export const commonTH = mapLocale(common, 'th'); export const commonEN = mapLocale(common, 'en');`.
- `dashboardMaguro.tsx`: split style whose exports are `maguroTH`/`maguroEN`. Includes one value `'<0>Hi</0>'` and one computed value `` `x${y}` ``, which must be read-only.
- `change-password.ts`: split style. `changePasswordEN` contains `change_pw`, which also exists in `common` (a duplicate).
- `mapLocale.ts`: the helper, copied from `axons-cms`, which is not a locale module.
- `__tests__/mapLocale.test.ts`: must be ignored.
- `src/utils/i18n.ts`: imports and spreads all of them (realism only; never read).
- One file saved with **CRLF** line endings (`change-password.ts`).

**Interfaces:**
- `type Quote = "'" | '"'`
- `interface TsEntry { key: string; locale: string; value: string; range: [number, number]; quote: Quote }`. `range` covers the whole literal, including its quotes.
- `interface TsObjectRef { locale: string | null; exportName?: string; open: number; close: number; propIndent: string; trailingComma: boolean }`. `locale` is null for a table-style object; `open` and `close` are the offsets of `{` and `}`.
- `interface LocaleModule { style: "split" | "table"; group: string; locales: string[]; entries: TsEntry[]; readOnly: Array<{ key: string; locale?: string; reason: string }>; objects: TsObjectRef[]; pairObjects?: Record<string, TsObjectRef> }`. In table style, each key's `{ th, en }` object is recorded in `pairObjects`, so a missing language can be inserted later.
- `parseLocaleModule(text: string, fileName: string): LocaleModule | null`. It returns null when the file has no recognised locale exports.

**Rules:**
- **Group** is the file's base name without extension (`dashboardMaguro`, `change-password`).
- **Split style:** `export const <name><SUFFIX> = { ... }` where `SUFFIX` matches `/[A-Z]{2}$/`. The locale is the suffix lowercased.
- **Table style:** a `const X = { k: { <locale>: '…' } }` object referenced by `mapLocale(X, '<locale>')` exports. The locales are the set of pair keys plus the `mapLocale` arguments.
- A property whose value isn't a plain string literal (template literal with expressions, identifier, call, spread) is added to `readOnly` with a reason, and its key is still known.
- Literal values are decoded the way JS would decode them (escapes included).
- Offsets index into the original text, including a BOM if there is one.

- [ ] **Step 1: Write the failing tests:**
  - `"split style: entries, locales, group"`: `button.tsx` → `style: "split"`, `group: "button"`, `locales: ["th","en"]`. The entry for `button_ok`/`en` has `value === "OK"`, and `text.slice(range[0], range[1]) === "'OK'"`.
  - `"table style via mapLocale"`: `common.ts` → `style: "table"`, `locales: ["th","en"]`. The multi-line pair has the right values. `\n` is decoded to a newline. The double-quoted entry has `quote: '"'`. The pair with only th has no en entry, and `pairObjects` records it.
  - `"export-name prefix may differ from file name"`: `dashboardMaguro.tsx` → `group: "dashboardMaguro"`, and both locales are found.
  - `"computed values are read-only"`.
  - `"helper and non-locale files return null"`: `mapLocale.ts` → null.
  - `"CRLF file offsets still slice exact literals"`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** with `@babel/parser` `parse(text, { sourceType: "module", plugins: ["typescript", "jsx"], ranges: true })`. Use node `start`/`end` and `extra.raw` for quote detection.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(tssource): parse TypeScript locale modules"
  ```

---

### Task 3: Importing a TS locales folder into model data

**Files:**
- Create: `src/tssource/import.ts`
- Test: `src/tssource/import.test.ts`

**Interfaces:**
- `findLocalesDir(fs: Fs, root: string): Promise<string | null>`. It returns the first of `src/assets/locales`, `src/locales`, `src/i18n`, `locales` (root-relative) that contains at least one locale module.
- `interface TsImport { modules: Map<string, { relPath: string; module: LocaleModule; text: string }>; locales: string[]; values: CellMap; keyOrder: KeyId[]; drafts: WorkspaceMeta["drafts"]; markers: WorkspaceMeta["markers"]; baseline: Baseline; duplicates: string[]; readOnly: Array<{ id: KeyId; reason: string }> }`
- `isMarker(value: string, locale: string): boolean` is true when the trimmed value ends with ` (${locale.toUpperCase()})`.
- `importTsLocales(fs: Fs, root: string, localesDir: string, baseLocale: string): Promise<TsImport>`

**Rules:**
- `KeyId` is `keyId(group, key)`.
- `values` omit marker cells.
- `markers[id][locale]` holds the raw marker text.
- `drafts[id][locale]` holds the text before the marker, but only when that text (trimmed) differs from the base value (trimmed).
- `baseline` holds every source value **as written**, markers included. It is the "last seen source" for sync.
- `duplicates` lists keys that appear in more than one group.
- `keyOrder` follows file order: files sorted by path, then keys in source order.
- Locales are the union across modules, with the base first.
- Ignored: `mapLocale.ts`, `__tests__/`, and `*.test.*` / `*.spec.*`.

- [ ] **Step 1: Write the failing tests** (fixture from Task 2):
  - `"finds src/assets/locales from the project root"`.
  - `"imports both styles into one model"`: `values.get("button::button_ok")?.get("en")` is `{kind:"text", text:"OK"}`, and `common::email` has both locales.
  - `"marker cells are missing; drafts only for real drafts"`: `button::button_delete`/`en` is missing, `markers` holds `'ลบ (EN)'` and there is no draft. The `'Reset password (EN)'` cell is missing with `drafts[...].en === "Reset password"`.
  - `"duplicates are reported"`: `duplicates` equals `["change_pw"]`, and both `common::change_pw` and `change-password::change_pw` exist.
  - `"ignores helper and tests"`: no group named `mapLocale` and none from `__tests__`.
  - `"baseline keeps raw source including markers"`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(tssource): import TS locales into model data"
  ```

---

### Task 4: Writing TypeScript back with minimal edits

**Files:**
- Create: `src/tssource/write.ts`
- Test: `src/tssource/write.test.ts`

**Interfaces:**
- `type TsEdit = { kind: "set"; key: string; locale: string; value: string } | { kind: "add"; key: string; values: Record<string, string> } | { kind: "remove"; key: string }`
- `applyTsEdits(text: string, module: LocaleModule, edits: TsEdit[]): string`. Edits are applied back to front by offset, so ranges stay valid.
- `encodeTsString(value: string, quote: Quote): string`. It returns a valid literal in that quote style, escaping `\`, the quote character, newline as `\n`, tab as `\t` and `\r`. All other characters (Thai included) are written as is.
- `newTableModule(group: string, values: Record<string, Record<string, string>>, locales: string[]): string`. It generates a table-style file in the fixture's style: 2-space indent, single quotes, `mapLocale` import, `<group>TH`/`<group>EN` exports (suffix = locale uppercased).
- `i18nSnippet(groups: string[], locales: string[]): string`. It returns the import lines plus the spread lines to paste into `i18n.ts`.

**Rules:**
- `set` on an existing entry replaces only its `range`, keeping the original quote.
- `set` on a language missing from a table pair inserts `<locale>: '<v>',` before the pair object's `}`, matching the pair's indentation and line style (single-line pair → inline; multi-line → new line).
- `add` in split style appends `<propIndent><key>: '<v>',` before **each** language object's closing `}`. If the last existing property has no trailing comma, a comma is added after it first. Languages with no value are skipped.
- `add` in table style appends one `key: { <loc>: '<v>', ... },` entry.
- `remove` deletes the property's full text: leading indentation, the property, its comma and the line break. It removes it from every language object (split) or the whole pair (table).
- Line endings follow the file (CRLF stays CRLF).

- [ ] **Step 1: Write the failing tests:**
  - `"no edits → identical text"` for every fixture file. (Covers Review Focus #2.)
  - `"one set → one-line diff"`: changing `button_ok`/`en` to `"Okay"` makes exactly one line differ and the result parses back to `"Okay"`.
  - `"awkward text round-trips"`: values `it's`, `say "hi"`, `a\\b`, `line1\nline2`, `${x}`, `` `tick` `` set with both quote styles → `parseLocaleModule` reads the same values back. (Covers Review Focus #3.)
  - `"add in split style goes into every language object, comma fixed"`.
  - `"add and set-missing-language in table style"`.
  - `"remove deletes the key everywhere and leaves the rest byte-identical"`.
  - `"CRLF preserved"`.
  - `"newTableModule output parses as a table module with the given values"`, plus a snapshot of `i18nSnippet(["report"], ["th","en"])`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(tssource): minimal-diff TS writer"
  ```

---

### Task 5: Export engine

**Files:**
- Create: `src/workspace/export.ts`
- Test: `src/workspace/export.test.ts`

**Interfaces:**
- `ExportTarget`: imported from `src/workspace/meta.ts` (Task 1). `dir` values are absolute.
- `interface ExportPlan { files: Array<{ path: string; text: string }>; snippets: string[]; leftOutLocales: string[]; warnings: string[]; blocked?: { reason: "duplicates"; keys: string[] } | { reason: "conflicts" } }`
- `planExport(session: ProjectSession, target: ExportTarget, source?: TsImport): Promise<ExportPlan>`. `source` is required for `ts-writeback` and `ts-copy` and comes from `importTsLocales` on the current files.
- `writeExportPlan(fs: Fs, plan: ExportPlan): Promise<void>`. It writes atomically with `mkdirp` and refuses when `plan.blocked` is set.

**Rules:**
- **`ts-writeback` / `ts-copy`:** for each group, compute `TsEdit[]` by comparing the workspace with the source modules:
  - changed value → `set`;
  - key only in the workspace → `add`;
  - key in the source but deleted in the workspace (and not just "removed in source") → `remove`;
  - a missing workspace cell whose source cell is a marker → no edit (the marker stays);
  - a missing cell whose source had a real value → `remove` that language's property in split style, or that pair field in table style;
  - groups that exist only in the workspace → `newTableModule` plus an `i18nSnippet`;
  - locales not in the source → `leftOutLocales`, plus a snippet explaining how to add a language.

  `ts-writeback` writes to the original paths; `ts-copy` writes the same relative paths under `dir`.
- **Write-back safety:** before planning, if `source` differs from the stored baseline, return `blocked: { reason: "conflicts" }` unless the caller has already synced. The caller (Task 8) runs `syncFromSource` first (Task 6). (Covers Review Focus #4.)
- **`ts-modules`:** every group goes through `newTableModule`, one file per group, plus the `mapLocale.ts` helper and an `i18nSnippet`.
- **`i18next-json`:** files go to `<dir>/<locale>/<group>.json` for per-group, or `<dir>/<locale>/translation.json` for single, with flat keys, 2-space indent and a trailing newline. Untranslated keys are omitted. `single` is blocked while there are duplicates. (Covers Review Focus #5.)
- **`paraglide`:**
  - Writes `<dir>/messages/<locale>.json` (with `$schema`) plus `<dir>/project.inlang/settings.json`, using the same shapes `scaffold.ts` writes.
  - Placeholders `{{name}}` become `{name}`. `{{x, fmt}}` becomes `{x}` with a warning, `Format modifier dropped in <key>`.
  - Blocked while there are duplicates.

- [ ] **Step 1: Write the failing tests** (fixture project opened as a workspace via Tasks 1 and 3):
  - `"writeback with no edits writes nothing"`: `files` is empty. Writing the full plan leaves every fixture file byte-identical.
  - `"one edit → one file, one line"`.
  - `"new key in split group goes to both objects; new group becomes a new file plus snippet"`.
  - `"added language is reported as left out"`.
  - `"marker cells stay markers"`.
  - `"blocked when source changed since baseline"`: modify the source file after import → `blocked.reason === "conflicts"`.
  - `"i18next-json per-group and single"`: single is blocked with `keys: ["change_pw"]`; after renaming one duplicate it succeeds and the output has no empty strings.
  - `"paraglide converts placeholders and warns on modifiers"`.
  - `"ts-modules output re-imports to the same values"`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(workspace): export engine"
  ```

---

### Task 6: Sync from source

**Files:**
- Create: `src/workspace/sync.ts`
- Test: `src/workspace/sync.test.ts`

**Interfaces:**
- `interface SyncResult { sourceAvailable: boolean; conflicts: Conflict[]; added: KeyId[]; updated: KeyId[]; removedInSource: KeyId[]; newGroups: string[] }`
- `syncFromSource(session: ProjectSession): Promise<SyncResult>`. It reads `session.workspace.source`, runs `importTsLocales`, and compares the result with the baseline from `BASELINE_PATH`.

**Rules (inside `session.batch`):**
- **Source folder missing or no locale modules:** return `{ sourceAvailable: false, ... }` and change nothing. (Covers Review Focus #1.)
- **Per cell, three-way** with base = baseline, mine = workspace and theirs = source (markers count as missing, using the import rules):
  - source unchanged → nothing;
  - source changed and workspace equal to baseline → take the source via `importCell` (a draft is updated in the meta);
  - both changed differently → a `Conflict`, which keeps mine until it is resolved.
- **A key that is new in the source** is added. **A new group** is added as a new namespace file in the workspace.
- **A key in the baseline that has gone from the source** is added to `meta.removedInSource` (nothing is deleted).
- **After a successful sync** with no conflicts, the baseline becomes the current source. With conflicts, the baseline updates only for cells without a conflict.
- `meta.duplicates` is refreshed.

- [ ] **Step 1: Write the failing tests:**
  - `"new key in code is added"`: add `button_export` to both objects in the source file → it appears in the workspace.
  - `"code change wins when workspace untouched"`.
  - `"both changed → conflict, workspace keeps mine"`.
  - `"deleted in code → removedInSource, not deleted"`.
  - `"new source file → new group"`.
  - `"missing source folder → sourceAvailable false and nothing marked removed"`.
  - `"marker added in code for a translated cell counts as a source change to missing"`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(workspace): sync from TS source"
  ```

---

### Task 7: Opening a TS project, drafts, duplicates and removed-in-source in the UI

**Files:**
- Create: `src/ui/ImportTsDialog.tsx`
- Modify: `src/ui/StartScreen.tsx`, `src/ui/store.ts` (`openProject` runs sync after open when `workspace.source` is set, and on watcher events for paths under `source.localesDir`), `src/core/watch-filter.ts` (paths under the source dir count as relevant for workspaces), `src/ui/Cell.tsx`, `src/ui/Warnings.tsx`, `src/ui/RowMenu.tsx`
- Test: `src/ui/ImportTsDialog.test.tsx`, `src/ui/workspace-cells.test.tsx`

**Behaviour:**
- **Open project** on a folder:
  - If a workspace exists, open it.
  - Otherwise, if `detectProject` finds nothing but `findLocalesDir` does, show `ImportTsDialog` with the title `Import TypeScript translations`. It lists the folder, `<n> files`, `<n> keys`, `<n> languages`, `<n> marked "(EN)" (shown as missing)` and `<n> duplicate keys`, and has a base-language select (default `th` when present, otherwise the first locale).
  - `Import` creates the workspace in memory: values from `importTsLocales`, then `createWorkspace` content, meta with `source`, drafts, markers and duplicates, and the baseline.
  - The workspace is written on the first Save.
  - The project then opens normally.
- **Cell, missing with a draft:** under the missing text, show `Draft: <text>` with an `Accept draft` button. Accepting is a normal hand edit (`setText`, `machine: false`) and removes the draft from the meta.
- **Warnings:** a key in `meta.duplicates` shows the warning `Duplicate key — also in <other groups>`. A read-only entry shows `Can't edit here (computed in code)` and the cell can't be edited.
- **Removed in source:** the row shows a badge `Removed in source`. The row menu gets `Delete key` (existing flow) and `Keep` (removes it from `removedInSource`).
- **Missing source:** a banner, `Source files not found — showing the saved workspace.`

- [ ] **Step 1: Write the failing tests:**
  - The import dialog shows counts for the fixture (exact numbers from the fixture) and opens the project with `button::button_ok`.
  - A draft cell shows `Draft: Reset password` and Accept sets the value.
  - A duplicate warning shows on both rows.
  - Removed-in-source shows the badge, and Keep clears it.
  - The missing-source banner shows.
  - Save after import writes `.retrans/workspace/**`, `.retrans/workspace.json` and `.retrans/source-baseline.json`, and never touches `src/assets/locales/**` (byte compare).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(workspace): import TS projects; drafts, duplicates, removed-in-source"
  ```

---

### Task 8: Export dialog

**Files:**
- Create: `src/ui/ExportDialog.tsx`
- Modify: `src/ui/SharePage.tsx` (workspaces show an `Export…` section above the translator-package sections), `src/ui/AppShell.tsx` (an `Export…` button in the top bar for workspaces)
- Test: `src/ui/ExportDialog.test.tsx`

**Behaviour:**
- **Radio options:**
  - `Write back to the original files` (only when `workspace.source` exists);
  - `Write TypeScript files to another folder`;
  - `i18next JSON`, with a sub-option `One file per group` / `One translation file (translation.json)`;
  - `Paraglide`;
  - `TypeScript modules (table style)`.
- **Folder:** every option except write-back shows a folder picker (plugin-dialog `open({ directory: true })`).
- **`Export`:**
  1. If unsaved, save first.
  2. For write-back, run `syncFromSource`. If there are conflicts, show `Resolve the changes from your code first.` and open the existing conflict dialog.
  3. `planExport`.
  4. If blocked by duplicates, show `Can't export while these keys are duplicated: <keys>` and stop.
  5. `writeExportPlan`.
- **Result panel:** `Exported <n> files.` Any `leftOutLocales` appear as `Not written to the TypeScript files: <locales> — export them in another format, or add them to your code:` followed by the snippet with a Copy button. Snippets appear with Copy buttons, and warnings are listed.
- The last target is stored in `meta.lastExport` and preselected next time.

- [ ] **Step 1: Write the failing tests** (mock the dialog; MemoryFs fixture):
  - Write-back writes only the changed file.
  - Duplicates block a single-namespace JSON export with the exact message.
  - Conflicts block write-back.
  - Snippets and left-out locales render.
  - The last target is remembered.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(workspace): export dialog"
  ```

---

### Task 9: Format-free "Create new project"

**Files:**
- Modify: `src/ui/NewProjectWizard.tsx`, `src/ui/StartScreen.tsx`
- Test: `src/ui/NewProjectWizard.test.tsx` (create or extend)

**Behaviour:**
- **Steps:**
  1. Project name.
  2. Base language and target languages (existing locale pickers).
  3. Location: default `<documentDir>/Retrans/<name>` (from `@tauri-apps/api/path` `documentDir()`), with `Choose…` to pick another folder.
- No format step, and no next-i18next or Paraglide files are created.
- **`Create`:**
  - If the folder exists and isn't empty, show `Choose an empty folder.`
  - Otherwise call `createWorkspace(fs, folder, {name, baseLocale, locales})` and open the project.
- The existing `scaffoldProject` stays in the code (used by tests and packages) but is no longer used by the wizard.

- [ ] **Step 1: Write the failing tests:** the default path is `<docs>/Retrans/My App`; a non-empty folder is refused; creating opens a workspace with the chosen languages and a `common` group; no `public/locales` or `project.inlang` is created.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(workspace): format-free new projects"
  ```

---

### Task 10: Translator packages for workspaces, end to end, docs

**Files:**
- Modify: `src/package/build.ts` (for workspaces, include `.retrans/workspace/**`, `.retrans/workspace.json` with `source` removed, and `.retrans/state.json`; leave out the baseline and the TS sources), `README.md`
- Create: `src/test/e2e-workspace.test.ts`

- [ ] **Step 1: Write the end-to-end test** (MemoryFs copy of the `ts-locales` fixture):
  1. Import.
  2. Check that markers are missing and drafts exist.
  3. Accept one draft, translate one marker cell and edit one value.
  4. Save, and check the TS sources are untouched.
  5. Simulate a developer adding `button_export` in the source → sync adds it.
  6. Write-back export: the diff contains only the 3 changed values plus the new key's lines; the marker for an untranslated cell is kept; re-import gives the same values.
  7. Export i18next per-group JSON into another dir and re-open it as a normal next-i18next project: same values for non-duplicate keys.
  8. Build a translator package from the workspace and open it: there is no source, so `sourceAvailable` is false and nothing is marked removed. (Covers Review Focus #1 end to end.)
- [ ] **Step 2: Run it.** Expected: PASS. Fix bugs in earlier tasks if it finds any.
- [ ] **Step 3: Update the README.** Add a "TypeScript translations and workspaces" section covering import, Save vs Export, the three export kinds, sync, the "(EN)" rule, duplicates, and format-free new projects. Add manual checklist items, including a run on a copy of `axons-cms`: import, edit, export back, `git diff` shows only the changed strings.
- [ ] **Step 4: Run full verification.** `pnpm test`, `pnpm exec tsc --noEmit`, `cd src-tauri && cargo test`, `pnpm tauri build --bundles app`. Expected: all pass, and the `.app` stays under 40 MB.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "test(workspace): end-to-end TS round trip; docs"
  ```

---

## Rulings in this plan (cost if wrong)

**Storage:**
- **The workspace is stored as next-i18next-layout JSON under `.retrans/workspace/`**, not as one custom file. Every existing feature then works unchanged, and it stays diff-friendly in git. *Cost: many small files instead of one.*
- **Review status stays in `.retrans/state.json`.** The workspace meta holds no statuses, so there's one source of truth. *Cost: none.*
- **A workspace's `format` stays `next-i18next`** (i18next `{{x}}` placeholders) with a `workspace` flag. This avoids touching every format check, and the UI renames "namespace" to "Group". *Cost: a format-free project meant for Paraglide still uses `{{x}}` placeholders until export converts them.*

**Import:**
- **Locales folder search order:** `src/assets/locales`, `src/locales`, `src/i18n`, `locales`. *Cost: other layouts need the existing locales-path setting.*
- **`@babel/parser` `~8.0.10`** rather than the TypeScript compiler or a Rust parser. It is pure JS, has exact positions and stays offline. *Cost: about 0.5 MB added to the bundle.*
- **The import's base language defaults to `th` when present.** *Cost: the user changes it in the dialog.*

**Export:**
- **A deleted workspace key is removed from the TS files on write-back.** A key "removed in source" is never re-added on write-back unless the user chose `Keep`. *Cost: none.*
- **Paraglide export drops i18next format modifiers, with a warning.** *Cost: formatting hints are lost in that format only.*
