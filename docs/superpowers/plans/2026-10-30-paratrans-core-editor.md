# Paratrans Core Editor Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Mac/Windows desktop app that opens or creates next-i18next and Paraglide projects. It shows every key across every language in a Tolgee-style List/Table view, tracks review status, and saves back with minimal diffs.

**Architecture:** Tauri 2 shell with a thin Rust layer (file I/O, atomic writes, folder watching). All format and editing logic lives in pure TypeScript under `src/core` and `src/formats`, behind an `Fs` interface so it's unit-tested against an in-memory file system. Files are edited as *text* with `jsonc-parser` edits (never re-serialized), which is what guarantees minimal diffs. The React UI reads a `ProjectSession` object through a small Zustand store.

**Tech Stack:** Tauri 2, Rust (`notify-debouncer-mini`), React 18 + TypeScript + Vite, pnpm, Vitest + Testing Library (jsdom), Tailwind CSS, Zustand, `@tanstack/react-virtual`, `jsonc-parser`, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-store`.

**Spec:** `docs/superpowers/specs/2026-10-30-paratrans-design.md`

**Scope of this plan:** spec §5–§8 and §11 (core editor). Not in this plan:
- **Plan 2, local machine translation:** spec §9.
- **Plan 3, translator packages and distribution:** spec §8.6 zip export/import and §10 (GitHub Actions, auto-update).

This plan's end state is a working app you can run with `pnpm tauri dev` and build locally.

## Global Constraints

- Platforms: macOS and Windows. Paths are handled as forward-slash strings everywhere in TS; Rust accepts them on Windows.
- A save that touches nothing must change nothing on disk. Only files whose text changed are written.
- Untranslated keys are **omitted** from a language's file, never written as `""`.
- Preserve key order, indentation (spaces/tabs and width), line endings (LF/CRLF), and the presence or absence of a final newline. New keys go at the end of their parent object.
- Paraglide: preserve `$schema` in message files. In `settings.json`, only ever modify the `locales` array.
- Never edit `next-i18next.config.*` or `next.config.*`. Show a copyable `locales` snippet instead.
- Writes are atomic (temp file + rename).
- Review status lives in `.paratrans/state.json` (sorted keys, 2-space indent, LF, final newline).
- Status rules: hand edit → Translated (`machine=false`); accept machine suggestion → Translated (`machine=true`); mark reviewed → Reviewed; edit a Reviewed cell → Translated; base text change → **needs review** for every other locale whose stored hash no longer matches; clear → Untranslated.
- No network use in this plan.
- UI follows Tolgee's layout and workflow, with Paratrans's own name and look. Copy no Tolgee branding or assets.
- Must stay smooth at 5,000 keys × 10 languages.

## Review Focus

1. **A malformed JSON file in one locale:** open the project anyway, list the file under load errors, and make it read-only. Never write to it (Task 5 test `malformed file is reported and never written`).
2. **Literal dotted keys inside nested files** (`{"a.b": "x"}` inside an object): edits must land on that exact key, not create `a → b` (Task 5 test `edits a literal dotted segment in place`).
3. **Thai, emoji, and characters that need escaping** (`"`, `\`, newline): written as readable UTF-8 and correctly escaped, never `\u0e01` (Task 3 test `writes Thai and escapes quotes`).
4. **Renaming or adding a key that collides with a prefix** (`home.title` is text and the user adds `home.title.sub`, or adds `home` when `home.title` exists): rejected with a clear error, and nothing changes (Task 8 test `rejects prefix collisions`).
5. **A file changed on disk after load but before the watcher fired, then saved:** the save must detect it, merge, and not overwrite the other person's change (Task 10 test `save detects stale snapshot and merges`).

---

## File Structure

```
src-tauri/src/lib.rs            Tauri builder, plugin + command registration
src-tauri/src/fs_cmds.rs        read/write_atomic/list/remove/mkdirp/exists commands
src-tauri/src/watch.rs          folder watcher emitting "fs-changed"
src/platform/fs.ts              Fs interface + joinPath/normalizePath
src/platform/tauri-fs.ts        Fs via invoke()
src/platform/memory-fs.ts       Fs in memory (tests) + loadFixtureDir()
src/platform/prefs.ts           recent projects + per-project view mode (plugin-store)
src/core/json-text.ts           style detection + text-level set/remove
src/core/model.ts               shared types + keyId helpers
src/core/hash.ts                FNV-1a hashText
src/core/plurals.ts             i18next plural suffix logic
src/core/placeholders.ts        extract/compare variables
src/core/state-file.ts          .paratrans/state.json parse/serialize/reconcile
src/core/status.ts              cellMeta + status transitions
src/core/session.ts             ProjectSession (values, ops, dirty tracking, save)
src/core/merge.ts               3-way cell merge for external changes
src/core/recovery.ts            crash-recovery journal
src/core/rows.ts                filtered/grouped rows for the views
src/formats/adapter.ts          FormatAdapter interface, DetectResult
src/formats/next-i18next.ts     next-i18next adapter
src/formats/paraglide.ts        Paraglide adapter
src/formats/detect.ts           detectProject()
src/formats/scaffold.ts         createProject() for the New Project wizard
src/ui/store.ts                 Zustand store wrapping the session
src/ui/StartScreen.tsx, NewProjectWizard.tsx, OpenProjectDialog.tsx
src/ui/AppShell.tsx, Sidebar.tsx, Toolbar.tsx
src/ui/ListView.tsx, TableView.tsx, CellEditor.tsx, StatusDot.tsx, Warnings.tsx
src/ui/KeyDialogs.tsx, LanguagesPage.tsx, ConflictDialog.tsx, SettingsPage.tsx
src/test/fixtures/...           fixture projects (see Tasks 5, 6)
```

---

### Task 1: Scaffold the app

**Files:**
- Create: the project via `create-tauri-app`, plus `vitest.config.ts`, `src/test/setup.ts`, `.gitignore`, `src/test/smoke.test.ts`

**Interfaces:**
- Produces: scripts `pnpm test` (Vitest, run once), `pnpm tauri dev`, `pnpm tauri build`.

- [ ] **Step 1: Prerequisites.** Rust isn't installed on the dev Mac. **Ask the user before installing**, then run `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`, and confirm with `cargo --version`.
- [ ] **Step 2:** `git init` in `/Users/olaf/Works/oxth/paratrans`. Scaffold in place with `pnpm create tauri-app@latest . --template react-ts --manager pnpm --identifier com.paratrans.app` (app name `Paratrans`). Keep the existing `docs/` and `.superpowers/`.
- [ ] **Step 3:** Add dev dependencies: `vitest @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom tailwindcss @tailwindcss/vite`. Add dependencies: `zustand @tanstack/react-virtual jsonc-parser @tauri-apps/plugin-dialog @tauri-apps/plugin-store`. Add the Rust crates `tauri-plugin-dialog`, `tauri-plugin-store`, and `notify-debouncer-mini = "0.4"`. Register both plugins in `lib.rs`, and add their permissions to `src-tauri/capabilities/default.json`.
- [ ] **Step 4:** In `vitest.config.ts`, set the environment to `jsdom`, setup file `src/test/setup.ts` (imports jest-dom), and include `src/**/*.test.ts(x)`. Set `"test": "vitest run"` in package.json. Add `.superpowers/`, `node_modules/`, `dist/`, and `src-tauri/target/` to `.gitignore`.
- [ ] **Step 5:** Write `smoke.test.ts`, asserting `1 + 1 === 2`. Run `pnpm test` (expect PASS) and `cd src-tauri && cargo check` (expect it to finish without errors).
- [ ] **Step 6:** Run `pnpm tauri dev` and confirm a window opens. Then close it.
- [ ] **Step 7: Commit:** `git add -A && git commit -m "chore: scaffold Tauri + React app"`

### Task 2: File system layer (Rust commands + TS `Fs`)

**Files:**
- Create: `src-tauri/src/fs_cmds.rs`, `src/platform/fs.ts`, `src/platform/tauri-fs.ts`, `src/platform/memory-fs.ts`, `src/platform/memory-fs.test.ts`
- Modify: `src-tauri/src/lib.rs` (register the commands)

**Interfaces:**
- Produces (TS):
  ```ts
  export interface Fs {
    readText(path: string): Promise<string>;           // throws FsError{code:"NotFound"} if missing
    writeTextAtomic(path: string, content: string): Promise<void>; // creates parent dirs
    exists(path: string): Promise<boolean>;
    listFiles(root: string, maxDepth: number): Promise<string[]>;  // files only, relative, "/"-separated, sorted
    remove(path: string): Promise<void>;
    mkdirp(path: string): Promise<void>;
  }
  export class FsError extends Error { code: "NotFound" | "Io" }
  export function normalizePath(p: string): string;   // "\" → "/", collapse "//", strip trailing "/"
  export function joinPath(...parts: string[]): string;
  export class MemoryFs implements Fs { constructor(files?: Record<string,string>); snapshot(): Record<string,string>; writes: string[] }
  export function loadFixtureDir(absDir: string, mountAt?: string): MemoryFs; // node:fs, tests only
  ```
- Produces (Rust commands): `read_text(path) -> String`, `write_text_atomic(path, content)`, `path_exists(path) -> bool`, `list_files(root, max_depth) -> Vec<String>`, `remove_path(path)`, `mkdirp(path)`. Errors come back as `{code, message}`.

- [ ] **Step 1: Write failing tests** in `memory-fs.test.ts`:
  - `writeTextAtomic then readText round-trips`
  - `readText missing throws NotFound`
  - `listFiles returns sorted relative paths and respects maxDepth` (files `a/b/c.json` and `x.json`; depth 1 → `["x.json"]`; depth 3 → both)
  - `joinPath normalizes backslashes` (`joinPath("C:\\p", "a/b.json") === "C:/p/a/b.json"`)
  - `writes records each written path`
- [ ] **Step 2:** Run `pnpm test src/platform`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `fs.ts` and `memory-fs.ts`.
- [ ] **Step 4:** Run `pnpm test src/platform`. Expected: PASS.
- [ ] **Step 5:** Implement `fs_cmds.rs`. `write_text_atomic` writes `<path>.paratrans-tmp` in the same folder, flushes, then renames over the target. Use `std::fs::rename`, which replaces the target on both macOS and Windows. Add a `#[cfg(test)]` test `atomic_write_replaces_existing` using `std::env::temp_dir()`. Run `cargo test` and expect PASS.
- [ ] **Step 6:** Implement `tauri-fs.ts` by mapping each method to `invoke` from `@tauri-apps/api/core`, and mapping error codes to `FsError`.
- [ ] **Step 7: Commit:** `feat: file system layer`

### Task 3: Text-level JSON editing

**Files:**
- Create: `src/core/json-text.ts`, `src/core/json-text.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface JsonStyle { indent: string; eol: "\n" | "\r\n"; finalNewline: boolean }
  export const DEFAULT_STYLE: JsonStyle;  // 2 spaces, "\n", true
  export function detectStyle(text: string): JsonStyle;
  export function parseJson(text: string): { value: unknown; error?: string };  // strict; error message on invalid
  export function setAt(text: string, path: string[], value: unknown, style: JsonStyle): string;
  export function removeAt(text: string, path: string[], style: JsonStyle): string; // also removes parents left empty (not the root)
  export function emptyDocument(style: JsonStyle): string; // "{}" + (finalNewline ? eol : "")
  ```

- [ ] **Step 1: Write failing tests:**
  - `detects tab indent, CRLF, no final newline`
  - `setAt on existing key changes only that line` (a 5-key file; after the edit, the diff is exactly one line)
  - `setAt appends new key at end of parent` (nested `{"a":{"x":"1"}}` + `["a","y"]` → `y` after `x`)
  - `setAt creates missing parent objects`
  - `removeAt removes emptied parents` (`{"a":{"b":"1"},"c":"2"}` remove `["a","b"]` → `{"c":"2"}` text, style kept)
  - `writes Thai and escapes quotes` (value `ยินดี "x" \ \n🙂` is written as raw Thai/emoji with `\"`, `\\`, `\n`; contains no `\u0e`)
  - `preserves CRLF and tab indent on insert`
  - `round-trip with no edits returns identical text`
- [ ] **Step 2:** Run `pnpm test src/core/json-text`. Expected: FAIL.
- [ ] **Step 3: Implement** with `jsonc-parser`'s `modify(text, path, value, { formattingOptions: { insertSpaces, tabSize, eol } })` + `applyEdits`. Get `insertSpaces` and `tabSize` from `style.indent`. After applying edits, restore `finalNewline` (add or strip one trailing `eol`). `parseJson` must reject comments and trailing commas: use `jsonc-parser`'s `parse` with `allowTrailingComma: false` and report errors, then confirm with `JSON.parse`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: minimal-diff JSON text editing`

### Task 4: Model, hashing, plurals, and placeholders

**Files:**
- Create: `src/core/model.ts`, `src/core/hash.ts`, `src/core/plurals.ts`, `src/core/placeholders.ts`, and tests `hash.test.ts`, `plurals.test.ts`, `placeholders.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // model.ts
  export type Format = "next-i18next" | "paraglide";
  export type Status = "untranslated" | "translated" | "reviewed";
  export type MessageValue = { kind: "text"; text: string } | { kind: "complex"; raw: unknown };
  export type KeyId = string;                      // `${ns}::${key}`; ns is "" for Paraglide; key is dotted
  export function keyId(ns: string, key: string): KeyId;
  export function parseKeyId(id: KeyId): { ns: string; key: string };
  export type CellMap = Map<KeyId, Map<string, MessageValue>>;  // locale → value; absent = untranslated
  export interface ProjectData {
    format: Format; root: string; baseLocale: string; locales: string[]; // base first
    namespaces: string[];                          // [""] for Paraglide
    keyOrder: KeyId[];                             // base-file order, then keys only in other locales
    values: CellMap;
  }
  export interface CellMeta { status: Status; needsReview: boolean; machine: boolean }
  export interface Warning { kind: "placeholder-missing" | "placeholder-extra" | "orphan"; names?: string[] }
  export function valuesEqual(a?: MessageValue, b?: MessageValue): boolean;
  // hash.ts
  export function hashText(s: string): string;     // FNV-1a 32-bit, 8 lowercase hex chars
  export function hashValue(v: MessageValue | undefined): string; // text → hashText(text); complex → hashText(JSON.stringify(raw)); undefined → ""
  // plurals.ts
  export const PLURAL_CATEGORIES: readonly ["zero","one","two","few","many","other"];
  export function splitPlural(key: string): { base: string; category: string } | null;
  export function pluralCategories(locale: string): string[];  // Intl.PluralRules(...).resolvedOptions().pluralCategories, in PLURAL_CATEGORIES order
  export function isApplicable(data: ProjectData, id: KeyId, locale: string): boolean;
  export function expandPluralKeys(data: ProjectData): KeyId[]; // for each base plural group, add the missing category keys some locale needs
  // placeholders.ts
  export function extractPlaceholders(format: Format, text: string): string[]; // sorted, with duplicates
  export function comparePlaceholders(format: Format, base: string, target: string): { missing: string[]; extra: string[] };
  ```

- [ ] **Step 1: Write failing tests:**
  - `hashText("") === "811c9dc5"` and `hashText("a") === "e40c292c"`
  - `splitPlural("cart.items_one")` → `{base:"cart.items", category:"one"}`; `splitPlural("user_name")` → `null`
  - `pluralCategories("th")` → `["other"]`; `"en"` → `["one","other"]`; `"ru"` → `["one","few","many","other"]`
  - `isApplicable`: for next-i18next, `items_one` is applicable for `en` and not for `th`; any non-plural key is applicable everywhere; every key is applicable for Paraglide
  - `expandPluralKeys` adds `items_few` and `items_many` when `ru` is a locale and the base has `items_one` + `items_other`
  - next-i18next placeholders: `"Hi {{name}}, {{ date, datetime }} $t(common.ok)"` → `["$t(common.ok)","date","name"]`
  - Paraglide placeholders: `"Hi {name} {count}"` → `["count","name"]`
  - `comparePlaceholders` reports `missing:["name"]` and `extra:["amount"]` correctly
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** next-i18next regexes: `/\{\{\s*([^,}\s]+)[^}]*\}\}/g` and `/\$t\([^)]*\)/g`. Paraglide: `/\{\s*([A-Za-z_][\w]*)\s*\}/g`. A key counts as a plural variant only when its category suffix is in `PLURAL_CATEGORIES` **and** another key in its group has `_other`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: core model, hashing, plurals, placeholders`

### Task 5: next-i18next adapter

**Files:**
- Create: `src/formats/adapter.ts`, `src/formats/next-i18next.ts`, `src/formats/next-i18next.test.ts`
- Create fixtures:
  - `src/test/fixtures/next-nested/`: `next-i18next.config.js` with `i18n: { defaultLocale: 'en', locales: ['en','th'] }`; `public/locales/en/common.json` (nested, 2 spaces, LF, including plurals `items_one`/`items_other` and a literal key `"a.b"` inside the object `"lit"`); `public/locales/th/common.json` (missing some keys); `public/locales/en/checkout.json`
  - `src/test/fixtures/next-flat-crlf/`: no config file; flat dotted keys, tab indent, CRLF, no final newline
  - `src/test/fixtures/next-broken/`: same as `next-nested`, but `th/common.json` contains invalid JSON

**Interfaces:**
- Produces:
  ```ts
  // adapter.ts
  export interface DetectResult {
    format: Format; baseLocale: string | null;   // null → the UI asks the user to pick
    locales: string[]; namespaces: string[]; localesPath: string; // relative to root, e.g. "public/locales"; "" for Paraglide
    keyCount: number;
  }
  export interface ProjectOptions { baseLocale: string; localesPath: string }
  export interface LoadedFile {
    relPath: string; locale: string; ns: string;
    text: string; style: JsonStyle; readOnly: boolean;  // readOnly = failed to parse
    shape: "nested" | "flat";
    segIndex: Map<string, string[]>;               // dotted key → actual JSON path in this file
  }
  export interface FileError { relPath: string; message: string }
  export interface LoadResult { data: ProjectData; files: LoadedFile[]; errors: FileError[] }
  export interface FormatAdapter {
    format: Format;
    detect(fs: Fs, root: string): Promise<DetectResult | null>;
    load(fs: Fs, root: string, opts: ProjectOptions): Promise<LoadResult>;
    filePath(opts: ProjectOptions, locale: string, ns: string): string;           // relative
    jsonPath(file: LoadedFile, key: string): string[];                            // segIndex hit, else nested → key.split("."), flat → [key]
    encode(v: MessageValue): unknown;                                             // text → string, complex → raw
    newFileStyle(files: LoadedFile[]): { style: JsonStyle; shape: "nested" | "flat"; prefix?: Record<string, unknown> }; // copy base locale file's style
    onLocalesChanged(fs: Fs, root: string, locales: string[]): Promise<{ configSnippet?: string }>;
  }
  export const nextI18nextAdapter: FormatAdapter;
  ```

- [ ] **Step 1: Write failing tests:**
  - `detect reads defaultLocale and locales from config statically` → `baseLocale "en"`, `locales ["en","th"]`, `namespaces ["checkout","common"]`, `localesPath "public/locales"`
  - `detect without config infers locales from folders and returns baseLocale null` (`next-flat-crlf`)
  - `detect returns null for a folder with neither config nor public/locales`
  - `load builds dotted keys, keyOrder follows base file order`
  - `load leaves untranslated th keys absent (not "")`
  - `flat file shape detected and jsonPath returns [key]`
  - `edits a literal dotted segment in place`: `jsonPath(file, "lit.a.b")` returns `["lit","a.b"]`
  - `malformed file is reported and never written`: `errors` has `th/common.json`, the file is `readOnly`, and other files load
  - `onLocalesChanged returns snippet and writes nothing`: snippet `locales: ['en', 'th', 'ja'],`, and `MemoryFs.writes` is empty
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Static config parsing: regex `defaultLocale:\s*['"]([^'"]+)` and `locales:\s*\[([^\]]*)\]`. If `localePath` is a string literal, use it relative to the root; otherwise use `public/locales`. Never `eval` or `require` the config. Folder names under `localesPath` are the source of truth for locales; the config only supplies the base locale. Shape is `nested` if any top-level value is an object; otherwise `flat` if any key contains `"."`; otherwise follow the base file's shape. Build `segIndex` by walking the parsed tree with `seg.join(".")` as the key.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: next-i18next adapter`

### Task 6: Paraglide adapter

**Files:**
- Create: `src/formats/paraglide.ts`, `src/formats/paraglide.test.ts`, `src/formats/detect.ts`, `src/formats/detect.test.ts`
- Create fixture `src/test/fixtures/paraglide/`: `project.inlang/settings.json` exactly as in the Paraglide example (`$schema`, `baseLocale "en"`, `locales ["en","th"]`, `modules`, `plugin.inlang.messageFormat.pathPattern "./messages/{locale}.json"`); `messages/en.json` with `$schema`, a simple message with `{username}`, a nested object, and a complex array message using `match`; `messages/th.json` partially translated

**Interfaces:**
- Consumes: `FormatAdapter`, `DetectResult`, and others from Task 5.
- Produces: `export const paraglideAdapter: FormatAdapter;` and `export async function detectProject(fs: Fs, root: string): Promise<DetectResult | null>`, which tries Paraglide first, then next-i18next.

- [ ] **Step 1: Write failing tests:**
  - `detect reads baseLocale/locales/pathPattern`
  - `$schema is not a key and is preserved after an edit`
  - `array value loads as complex and round-trips untouched`
  - `nested message object becomes dotted keys`
  - `onLocalesChanged updates only the locales array in settings.json` (all other bytes identical; `configSnippet` undefined)
  - `filePath substitutes {locale} into pathPattern` (`"messages/th.json"`)
  - `detectProject picks paraglide when project.inlang exists, next-i18next otherwise, null for empty folder`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Strip the leading `./` from `pathPattern`. If `pathPattern` is an array, use its first entry and note that in `DetectResult` via the `localesPath` string. A value is complex if it's an array. Update `settings.json` with `setAt(text, ["locales"], locales, style)`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: paraglide adapter and project detection`

### Task 7: State file and status rules

**Files:**
- Create: `src/core/state-file.ts`, `src/core/status.ts`, and tests for each

**Interfaces:**
- Produces:
  ```ts
  // state-file.ts
  export interface StateEntry { s: "translated" | "reviewed"; h: string; m?: true }
  export interface StateFile {
    version: 1;
    project: { baseLocale: string; localesPath?: string };
    entries: Record<KeyId, Record<string, StateEntry>>;
  }
  export const STATE_PATH = ".paratrans/state.json";
  export function parseState(text: string | null, fallback: StateFile["project"]): StateFile; // invalid/missing → empty entries
  export function serializeState(s: StateFile): string;  // recursively sorted keys, 2-space, LF, final newline
  export function reconcile(s: StateFile, data: ProjectData): StateFile; // drop keys/locales no longer present or untranslated; never base locale
  // status.ts
  export function cellMeta(data: ProjectData, s: StateFile, id: KeyId, locale: string): CellMeta;
  export function recordEdit(data: ProjectData, s: StateFile, id: KeyId, locale: string, machine: boolean): void;
  export function recordReviewed(data: ProjectData, s: StateFile, id: KeyId, locale: string): void;
  export function recordCleared(s: StateFile, id: KeyId, locale: string): void;
  export function renameInState(s: StateFile, from: KeyId, to: KeyId): void;
  ```

- [ ] **Step 1: Write failing tests:**
  - `missing value → untranslated`
  - `value without entry → translated, not needsReview`
  - `recordEdit stores s=translated, h=hash of base, m only when machine`
  - `recordReviewed → reviewed; editing again → translated`
  - `base text change → needsReview for others, cleared by recordReviewed`
  - `base locale cells never get entries; meta is translated/untranslated with needsReview false`
  - `serializeState is stable and sorted` (two different insertion orders → identical text)
  - `reconcile prunes deleted keys and removed locales`
  - `parseState tolerates invalid JSON` (returns empty entries)
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** `needsReview` is `entry !== undefined && entry.h !== hashValue(base value)`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: review status state file`

### Task 8: ProjectSession (editing and saving)

**Files:**
- Create: `src/core/session.ts`, `src/core/session.test.ts`

**Interfaces:**
- Consumes: the adapters (Tasks 5–6), json-text (Task 3), state (Task 7), plurals and placeholders (Task 4).
- Produces:
  ```ts
  export class KeyError extends Error { code: "exists" | "prefix-collision" | "invalid" }
  export interface SaveResult { written: string[]; deleted: string[]; stale: string[] } // stale: on-disk text differs from snapshot; nothing written (Task 10 handles it)
  export class ProjectSession {
    static async open(fs: Fs, root: string, d: DetectResult, opts: ProjectOptions): Promise<ProjectSession>;
    readonly fs: Fs; readonly adapter: FormatAdapter; readonly opts: ProjectOptions;
    data: ProjectData; state: StateFile; files: LoadedFile[]; errors: FileError[];
    subscribe(fn: () => void): () => void;          // fires after every mutation
    version: number;                                 // increments per mutation
    value(id: KeyId, locale: string): MessageValue | undefined;
    meta(id: KeyId, locale: string): CellMeta;
    warnings(id: KeyId, locale: string): Warning[];
    stats(): Map<string, { done: number; total: number }>;  // applicable cells only; done = has value
    setText(id: KeyId, locale: string, text: string | null, opts?: { machine?: boolean }): void; // "" or null = clear
    setComplex(id: KeyId, locale: string, raw: unknown): void;
    markReviewed(id: KeyId, locale: string): void;
    addKey(ns: string, key: string, baseText: string, opts?: { plural?: boolean }): KeyId; // plural → creates base categories
    renameKey(id: KeyId, newKey: string): KeyId;
    deleteKey(id: KeyId): void;                      // deletes plural siblings too when id is a group's _other
    addLanguage(locale: string): { configSnippet?: string };
    removeLanguage(locale: string): void;            // never the base locale
    addNamespace(ns: string): void;                  // next-i18next only
    isDirty(): boolean;
    dirtyCells(): Array<{ id: KeyId; locale: string }>;
    save(): Promise<SaveResult>;
  }
  ```

- [ ] **Step 1: Write failing tests** against `loadFixtureDir` copies of the Task 5–6 fixtures:
  - `open then save with no edits writes nothing` (`MemoryFs.writes` is empty), for every fixture
  - `editing one value changes exactly one line in one file`
  - `clearing a value removes the key from that locale file (no "")`
  - `addKey adds to the base file only; other locales stay absent`
  - `rejects prefix collisions` (`addKey("common","home.title.sub")` when `home.title` is text → `KeyError("prefix-collision")`; `addKey("common","home")` → the same; data unchanged)
  - `renameKey moves values in every locale and moves state entries`
  - `deleteKey removes from all locale files and state`
  - `addLanguage creates files copying base style; for paraglide updates settings.json; for next returns snippet`
  - `removeLanguage deletes its files and refuses baseLocale`
  - `addNamespace creates {} files for every locale`
  - `state.json written only when entries changed`
  - `readOnly (malformed) files are never written; edits to their cells throw`
  - `editing base text marks other locales needsReview`
  - `save returns stale when a file on disk changed since load` (change the file via `fs.writeTextAtomic` behind the session's back → `stale` lists it; that file is not overwritten)
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep `diskValues: CellMap`, a snapshot of the values as loaded or last saved. Dirty cells = cells where `valuesEqual(current, disk)` is false. Pending creates and deletes are tracked for language and namespace changes.

  `save()` runs in this order:
  1. Re-read every file it's about to modify. If the text differs from `LoadedFile.text`, add it to `stale` and skip it.
  2. For each target file, fold the dirty cells into its text with `setAt`/`removeAt`, using `adapter.jsonPath` and `adapter.encode`.
  3. Write only the files whose text changed, create pending files, and delete pending removals.
  4. Write `state.json` only if `serializeState(reconcile(...))` differs from what's on disk.
  5. Update the snapshots.

  Collision rule: a key `k` collides if any existing key in the same namespace equals `k`, starts with `k + "."`, or `k` starts with an existing key `+ "."`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: project session with minimal-diff save`

### Task 9: Create new project

**Files:**
- Create: `src/formats/scaffold.ts`, `src/formats/scaffold.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface NewProjectInput { format: Format; root: string; baseLocale: string; locales: string[]; namespace?: string } // namespace defaults "common"
  export async function createProject(fs: Fs, input: NewProjectInput): Promise<DetectResult>; // throws if root already contains a detectable project
  ```

- [ ] **Step 1: Write failing tests:**
  - `next-i18next creates public/locales/{locale}/common.json as "{}\n" and a minimal next-i18next.config.js`. The config text is exactly:
    ```js
    /** @type {import('next-i18next').UserConfig} */
    module.exports = {
      i18n: {
        defaultLocale: 'en',
        locales: ['en', 'th'],
      },
    }
    ```
    The config isn't overwritten if one already exists.
  - `paraglide creates settings.json and messages/{locale}.json with $schema`. `settings.json` matches the Task 6 fixture shape with the given locales, and messages are `{"$schema": "https://inlang.com/schema/inlang-message-format"}` with 2-space indent and a final newline.
  - `created project round-trips through detectProject and ProjectSession.open`
  - `refuses a folder that already contains a project`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: new project scaffolding`

### Task 10: External changes, watcher, and crash recovery

**Files:**
- Create: `src/core/merge.ts`, `src/core/merge.test.ts`, `src/core/recovery.ts`, `src/core/recovery.test.ts`, `src-tauri/src/watch.rs`
- Modify: `src/core/session.ts` (add `reloadFromDisk`, `resolveConflict`, `toJournal`, `applyJournal`), `src-tauri/src/lib.rs`

**Interfaces:**
- Produces:
  ```ts
  // merge.ts
  export interface Conflict { id: KeyId; locale: string; mine?: MessageValue; theirs?: MessageValue }
  export function mergeCells(base: CellMap, mine: CellMap, theirs: CellMap): { merged: CellMap; conflicts: Conflict[] };
  // session.ts additions
  reloadFromDisk(): Promise<Conflict[]>;   // re-load via adapter; new disk = theirs; snapshot = base; current = mine
  resolveConflict(c: Conflict, pick: "mine" | "theirs"): void;
  toJournal(): Journal; applyJournal(j: Journal): void;
  // recovery.ts
  export interface Journal { root: string; savedAt: string; locales: string[]; namespaces: string[]; cells: Array<[KeyId, string, MessageValue | null]>; state: StateFile }
  export function journalPath(appDataDir: string, root: string): string; // `${appDataDir}/recovery/${hashText(root)}.json`
  export async function writeJournal(fs: Fs, path: string, j: Journal): Promise<void>;
  export async function readJournal(fs: Fs, path: string): Promise<Journal | null>;
  export async function clearJournal(fs: Fs, path: string): Promise<void>;
  ```
  Rust: `watch_dir(root: String)` emits the event `"fs-changed"` with payload `Vec<String>` (changed paths), debounced 300 ms; `unwatch_dir()`. Only one watch is active at a time.

- [ ] **Step 1: Write failing tests:**
  - `mergeCells`: only theirs changed → theirs is taken; only mine changed → mine is kept; both changed to the same value → no conflict; both changed differently → conflict; theirs deleted while mine is unchanged → deleted
  - `reloadFromDisk applies a git-pull-style change silently when there are no local edits`
  - `reloadFromDisk returns a conflict when the same cell was edited both locally and on disk`
  - `save detects stale snapshot and merges`: after `save()` reports `stale`, `reloadFromDisk()` and then `save()` write both changes, and the other person's edit survives
  - `journal round-trip restores unsaved edits` (`toJournal` → new session → `applyJournal` → same dirty cells)
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the TS. Implement `watch.rs` with `notify_debouncer_mini::new_debouncer(Duration::from_millis(300), ...)` in recursive mode. Ignore paths under `node_modules`, `.git`, and any path ending in `.paratrans-tmp`. Keep the debouncer in a `Mutex<Option<...>>` in Tauri state.
- [ ] **Step 4:** Run `pnpm test` and `cargo test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: external change merge, watcher, recovery journal`

### Task 11: View rows (search, filters, plural grouping)

**Files:**
- Create: `src/core/rows.ts`, `src/core/rows.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RowFilter {
    search: string; ns: string | "all"; locales: string[];   // visible target locales
    missing: boolean; needsReview: boolean; machine: boolean; status: Status | "all";
  }
  export interface Row { id: KeyId; ns: string; key: string; pluralGroup?: string; pluralCategory?: string }
  export function buildRows(s: ProjectSession, f: RowFilter): Row[];
  export function nextMissing(s: ProjectSession, rows: Row[], from: { id: KeyId; locale: string }, locales: string[]): { id: KeyId; locale: string } | null; // row-major, wraps around
  ```

- [ ] **Step 1: Write failing tests:**
  - `search matches key or any visible value, case-insensitive (Thai too)`
  - `missing filter keeps rows with any visible applicable untranslated cell; non-applicable plural cells don't count`
  - `needsReview / machine / status filters`
  - `plural variants are adjacent and carry pluralGroup/category`
  - `nextMissing wraps and skips non-applicable cells`
  - `buildRows over 5,000 keys × 10 locales runs under 100 ms` (generated in-memory session; `performance.now()`)
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: row building and filters`

### Task 12: Start screen, open project, and New Project wizard (UI)

**Files:**
- Create: `src/ui/store.ts`, `src/platform/prefs.ts`, `src/ui/StartScreen.tsx`, `src/ui/OpenProjectDialog.tsx`, `src/ui/NewProjectWizard.tsx`, `src/ui/StartScreen.test.tsx`
- Modify: `src/App.tsx`, `src/main.tsx`, `src/index.css` (Tailwind)

**Interfaces:**
- Consumes: `detectProject`, `createProject`, `ProjectSession.open`, recovery helpers.
- Produces:
  ```ts
  // store.ts
  interface AppState {
    fs: Fs; session: ProjectSession | null; version: number;
    openProject(root: string, d: DetectResult, opts: ProjectOptions): Promise<void>;  // also starts watcher, checks journal
    closeProject(): Promise<void>;
  }
  export const useApp: UseBoundStore<StoreApi<AppState>>;
  export function useSessionVersion(): number;  // re-render hook
  // prefs.ts
  export async function getRecent(): Promise<Array<{ root: string; name: string; format: Format }>>; // max 10, newest first
  export async function addRecent(e: { root: string; name: string; format: Format }): Promise<void>;
  export async function getViewMode(root: string): Promise<"list" | "table">;   // default "list"
  export async function setViewMode(root: string, m: "list" | "table"): Promise<void>;
  ```

- [ ] **Step 1: Write failing component tests** (MemoryFs injected through the store; `@tauri-apps/plugin-dialog` mocked):
  - `Open shows a detection summary (format, languages, namespaces, key count) before opening`
  - `asks for the base language when detect returns baseLocale null`
  - `shows "No next-i18next or Paraglide project found" for an empty folder`
  - `wizard creates a project and opens it`. The wizard steps are: format → base language + target languages (searchable list built from `Intl.supportedValuesOf` where available, otherwise a built-in list of ~100 common locale codes with `Intl.DisplayNames` labels) → namespace (next-i18next only, default `common`) → location (folder picker)
  - `recent projects list opens on click`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Opening checks the recovery journal: if one exists, ask "Restore unsaved changes from <time>?" with Restore and Discard. Start `watch_dir`, and on an `fs-changed` event call `reloadFromDisk()`; conflicts are handled in Task 15.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then run `pnpm tauri dev` and check by hand: open `src/test/fixtures/next-nested`, and create a Paraglide project in a temp folder.
- [ ] **Step 5: Commit:** `feat: start screen, open and create project`

### Task 13: App shell and the List/Table views

**Files:**
- Create: `src/ui/AppShell.tsx`, `src/ui/Sidebar.tsx`, `src/ui/Toolbar.tsx`, `src/ui/ListView.tsx`, `src/ui/TableView.tsx`, `src/ui/StatusDot.tsx`, `src/ui/Warnings.tsx`, `src/ui/views.test.tsx`

**Interfaces:**
- Consumes: `buildRows`, `RowFilter`, `ProjectSession`, and prefs.
- Produces: `<AppShell/>` with a page state of `"translations" | "languages" | "settings"`. Import/Export is a disabled sidebar item marked "coming soon" until Plan 3.

**Layout (see the mockup `.superpowers/brainstorm/*/content/translations-layout.html`):**
- **Sidebar:** project name, nav items, and a per-locale completion bar from `stats()`. The bar is amber below 80%, green otherwise.
- **Toolbar:** search, a Missing chip showing its count, Needs review, Machine, a status select, a namespace select (next-i18next only), a visible-languages menu, the List/Table toggle (persisted with `setViewMode`), and "+ Key".
- **List view:** a virtualized row per key. On the left, the key and namespace, plus a "plural · one" badge for variants and a "complex" badge for complex messages. On the right, the visible locales stacked as `[code] [StatusDot] value`. Missing cells show red "Missing — click to translate". Non-applicable plural cells show a grey "not used in <lang>".
- **Table view:** virtualized rows. The Key and base locale columns are pinned, with one column per visible target locale.
- **StatusDot:** red, yellow, or green, with an orange ring when `needsReview` and a small "AI" mark when `machine`. Clicking it marks the cell reviewed, except for base locale and empty cells.
- **Warnings:** an amber icon with a tooltip listing missing or extra placeholders, or "orphan: not in base language."

- [ ] **Step 1: Write failing component tests:**
  - `toggle switches between list and table and persists per project`
  - `missing chip count equals rows with missing cells and filters on click`
  - `missing cells render "Missing" and plural non-applicable cells render "not used"`
  - `clicking a yellow dot marks reviewed (green)`
  - `placeholder warning shows names`
  - `sidebar bars reflect stats`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Use `useVirtualizer` with dynamic row measurement for List view.
- [ ] **Step 4:** Run the tests. Expected: PASS. Run `pnpm tauri dev` against a generated 5,000-key fixture (a script in `src/test/gen-large-fixture.ts`, run with `pnpm tsx`) and confirm scrolling and filtering feel instant.
- [ ] **Step 5: Commit:** `feat: app shell with list and table views`

### Task 14: In-place editing and keyboard flow

**Files:**
- Create: `src/ui/CellEditor.tsx`, `src/ui/CellEditor.test.tsx`
- Modify: `src/ui/ListView.tsx`, `src/ui/TableView.tsx`

**Interfaces:**
- Produces: `<CellEditor id locale initial onCommit(text) onCancel() onNextMissing()/>`. For complex values, it opens a raw JSON textarea that only commits when the JSON is valid and is an array.

- [ ] **Step 1: Write failing tests:**
  - `Enter commits via setText`
  - `Shift+Enter inserts newline`
  - `Esc cancels without change`
  - `Tab commits and focuses next missing cell (wraps)`
  - `committing "" clears to untranslated`
  - `complex editor rejects invalid JSON with an inline error`
  - `editing a reviewed cell turns it yellow`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. The textarea auto-grows. Clicking a cell starts editing it. Mark reviewed with Cmd/Ctrl+Shift+R while a cell is focused.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: in-place editing with keyboard flow`

### Task 15: Keys, languages, saving, and conflicts (UI)

**Files:**
- Create: `src/ui/KeyDialogs.tsx`, `src/ui/LanguagesPage.tsx`, `src/ui/ConflictDialog.tsx`, `src/ui/SettingsPage.tsx`, `src/ui/manage.test.tsx`
- Modify: `src/ui/AppShell.tsx`, `src/ui/store.ts`, `src-tauri/src/lib.rs` (close-requested handling)

**Interfaces:**
- Consumes: the session ops from Task 8, conflicts from Task 10, and the journal from Task 10.

**Behavior:**
- **"+ Key" dialog:** namespace, key, base text, and a "plural" checkbox. `KeyError` messages appear inline: "Key already exists", or "Conflicts with existing key <x>".
- **Key row menu:** Rename and Delete (the delete confirmation names how many languages are affected).
- **Languages page:** a list of locales with progress; Add language (searchable picker); Remove (with confirmation, disabled for the base locale); Add namespace. After adding or removing a next-i18next language, show a panel: "Update your next-i18next config:" followed by the snippet and a Copy button.
- **Save:** Cmd/Ctrl+S calls `save()`. If `stale` is non-empty, it calls `reloadFromDisk()`, shows the ConflictDialog if needed, then saves again. The title bar shows a "• Unsaved" dot while dirty.
- **Recovery:** on every mutation, write the journal (debounced 1 s) to `journalPath(appDataDir(), root)`, and clear it after a successful save.
- **Closing with unsaved changes:** intercept the window's close-requested event and ask Save, Discard, or Cancel.
- **Watcher-triggered conflicts:** show the ConflictDialog listing each conflict with Mine and Theirs (both values side by side), plus "Keep all mine" and "Take all theirs".
- **Settings page:** for this plan, only the default view mode and the project's locales path override (stored in `state.json` `project.localesPath`, which takes effect on reopen).
- **Load errors:** a banner reading "N files couldn't be read and are read-only," with a details list.

- [ ] **Step 1: Write failing component tests:**
  - `add key dialog shows prefix collision error`
  - `rename and delete update the views`
  - `adding a next-i18next language shows the copyable snippet`
  - `Cmd+S saves and clears the unsaved dot`
  - `stale save opens ConflictDialog and resolving then saving writes both changes`
  - `load error banner lists the malformed file`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: key/language management, saving, conflicts`

### Task 16: End-to-end check and local build

**Files:**
- Create: `README.md` (what Paratrans is, dev setup, how to run the tests, and the unsigned first-launch steps for macOS and Windows from spec §10)

- [ ] **Step 1:** Run `pnpm test` and `cd src-tauri && cargo test`. Expected: all pass.
- [ ] **Step 2: Manual pass with `pnpm tauri dev`** on a copy of each fixture:
  - Open the project.
  - Fill a missing Thai cell, using Tab to reach it.
  - Mark it reviewed.
  - Change the English text and confirm Thai shows needs review.
  - Add, rename, and delete a key.
  - Add the language `ja`.
  - Save.
  - Run `git diff` in the fixture copy and confirm only the intended lines changed.
  - Edit a file in a text editor while the app is open and confirm the app picks up the change.
  - Kill the app with unsaved edits, reopen it, and confirm the restore prompt appears.
- [ ] **Step 3:** Run `pnpm tauri build` and confirm a `.dmg` is produced on macOS. The Windows build is verified in Plan 3's CI.
- [ ] **Step 4: Commit:** `docs: README and v1 core verification`
