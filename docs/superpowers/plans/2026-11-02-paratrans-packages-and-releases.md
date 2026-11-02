# Retrans Translator Packages and Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Let a developer send a translator a zip that opens as a normal project.
- Merge the translator's work back with a per-cell diff.
- Ship free macOS and Windows installers from GitHub Actions with in-app updates.
- Make the Windows translation engine fast on any x64 CPU.

**Architecture:**
- **Zip handling (Rust, two commands):** `zip_write` and `zip_read` move UTF-8 text entries in and out of `.zip` files, with path and size checks.
- **Package logic (TS, `src/package/`):** builds the file list, writes a manifest, extracts packages, and computes the import diff. It runs on the existing `Fs` abstraction, so it is tested with `MemoryFs`.
- **Three-way import:** the manifest stores a per-cell snapshot (value hash + status) from the moment of export. Import compares mine and theirs against that snapshot.
- **Releases:** a tag-triggered `tauri-action` workflow builds unsigned installers plus updater artifacts, signed with a free Tauri update key, onto a draft GitHub Release. The app checks `latest.json` from GitHub.
- **Windows engine:** builds llama.cpp with `dynamic-backends`, so every CPU variant ships as a DLL and ggml picks the best one at runtime.

**Tech Stack:**
- Existing: Tauri 2, React 19, TS 6, Vitest 5, Zustand, `llama-cpp-2` 0.1.160.
- New (Rust): `zip` 9 (deflate only).
- New (JS): `@tauri-apps/plugin-updater` 2.x, `@tauri-apps/plugin-process` 2.x.
- CI: GitHub Actions with `tauri-apps/tauri-action@v1`.

**Spec:** `docs/superpowers/specs/2026-10-30-paratrans-design.md` §8.6 (translator package), §7.1 (manifest detection), §10 (distribution), §9.3 (Windows engine), §11 (quality bar).

## Global Constraints

**Cost and network:**
- Free only: no paid services, signing certificates or hosting. Releases are hosted on GitHub Releases.
- The only network use is model downloads (Plan 2) and update checks/downloads (this plan). There is no telemetry.

**Package file format:**
- A package is a `.zip` that **is a complete, openable project**. It holds:
  - the locale files in their normal layout;
  - `.retrans/state.json`;
  - Paraglide `project.inlang/settings.json`, or a copy of the next-i18next config;
  - `.retrans/package.json` (the manifest).
- Manifest path: exactly `.retrans/package.json`.
- Manifest key `retransPackage: 1`.

**Status rules on import:**
- The translator's Reviewed and `machine` flags travel with their values.
- Nothing is ever marked Reviewed except by a person: a status entry carried in from a package counts as the translator's decision.

**Files and config:**
- Untranslated cells stay omitted from files. Saves stay minimal-diff (existing session save path).
- Retrans never edits JS/TS config (`next-i18next.config.*` is copied byte-for-byte into packages, never rewritten).

**Installers:**
- Unsigned for OS purposes.
- Updater artifacts are signed with the Tauri updater key, whose private part lives only in GitHub secrets and the developer's machine and is **never committed**.

**Verification:**
- `pnpm test`, `pnpm exec tsc --noEmit`, and `cargo test` (in `src-tauri`) pass after every task.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Branch:** work on `feat/packages-releases`, created from `main`.

**Exact copy:**

| Where | Text |
|---|---|
| Export blocked by unsaved changes | `Save your changes first.` |
| Export blocked by unreadable `state.json` | `Fix .retrans/state.json before exporting.` |
| Package from another project | `This package came from a different project. Matching keys will still be merged.` |
| Folder with no project | `Couldn't find translation files here.` |
| Damaged zip | `This file isn't a Retrans package or project.` |
| Update banner | `Retrans <version> is available.` with buttons `Install and restart` / `Later` |

## Review Focus

1. **Translator re-exports from the package project.**
   - The manifest's baseline must stay the *developer's* original export snapshot.
   - If it were recomputed, every translator edit would look unchanged and the import would drop it.
   - Tested in Task 3.
2. **Hostile or odd zips.** Covers `../evil`, absolute paths, `C:\x`, oversized entries, non-UTF-8 entries, `__MACOSX/` and `.DS_Store` junk, and nested folders.
   - Expected: nothing is ever written outside the target folder.
   - Junk entries are skipped.
   - Bad files fail with `This file isn't a Retrans package or project.`
   - Tested in Tasks 2 and 4.
3. **The developer changed things after exporting.**
   - Same cell edited on both sides → conflict.
   - Key deleted → reported as skipped.
   - Language added → untouched.
   - Base text edited by the translator → ignored and reported.
   - Tested in Task 5.
4. **Wrong or missing manifest.**
   - Package from another project → warning, merge still offered.
   - Plain project folder (no manifest) → values-only merge, where any differing value is a conflict.
   - Tested in Task 5.
5. **Offline or broken update endpoint.**
   - The update check fails silently: no error banner, a console warning only.
   - The manual "Check for updates" shows `Couldn't check for updates.`
   - Tested in Task 7.

---

## File Structure

```
src/package/
  manifest.ts      PackageManifest type, parse/serialize, snapshot of current cells
  build.ts         buildPackage(): the file list for a package (pure, Fs-based)
  extract.ts       safeEntryPath(), extractPackage(): write zip entries into an empty folder
  diff.ts          diffPackage(), applyImport()
src/platform/zip.ts  zipWrite/zipRead wrappers over the Rust commands
src/platform/updates.ts  checkForUpdate / installUpdate wrappers (plugin-updater + plugin-process)
src/ui/SharePage.tsx       sidebar page "Import / Export"
src/ui/ImportDialog.tsx    diff review + apply
src/ui/UpdateBanner.tsx    update available banner
src-tauri/src/zip_cmds.rs
src-tauri/tauri.release.conf.json   release-only config (createUpdaterArtifacts)
.github/workflows/ci.yml, .github/workflows/release.yml
```

Modified:
- `src/core/state-file.ts`: `project.id`
- `src/core/session.ts`: `importCell`, `setProjectSetting({ id })`
- `src/formats/detect.ts`: manifest first
- `src/ui/Sidebar.tsx`, `src/ui/AppShell.tsx`: new page
- `src/ui/StartScreen.tsx`: open package
- `src/ui/SettingsPage.tsx`: updates section
- `src/platform/prefs.ts`: `autoCheckUpdates`
- `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`
- `src-tauri/src/mt/engine.rs`: Windows backend loading
- `README.md`

---

### Task 1: Project id and manifest

**Files:**
- Create: `src/package/manifest.ts`
- Modify: `src/core/state-file.ts`, `src/core/session.ts` (`setProjectSetting`)
- Test: `src/package/manifest.test.ts`, `src/core/state-file.test.ts`

**Interfaces:**
- **`state-file.ts`:**
  - `StateFile.project` gains `id?: string`.
  - `parseState` keeps a string `id`; `serializeState` writes it.
  - Update the doc comment: `project` holds explicit user choices plus the project's stable id.
- **`session.ts`:** `setProjectSetting(patch: { localesPath?: string | undefined; id?: string })`. Setting `id` marks the state touched, like the existing localesPath path.
- **`manifest.ts`:**
  - `MANIFEST_PATH = ".retrans/package.json"`.
  - `interface CellSnapshot { v: string; s?: "translated" | "reviewed"; m?: true }` — `v` is `hashValue(value)`, with `hashValue(undefined)` for missing.
  - `interface PackageManifest { retransPackage: 1; format: Format; baseLocale: string; locales: string[]; localesPath: string; exportedAt: string; sourceProjectId: string; baseline: Record<KeyId, Record<string, CellSnapshot>> }`. `locales` holds the target locales only; the base is always included in the files.
  - `parseManifest(text: string | null): PackageManifest | null`. Returns null for missing or invalid input, or when `retransPackage !== 1`. It never throws.
  - `serializeManifest(m): string`. Sorted keys, 2-space indent, trailing newline (same style as `serializeState`).
  - `snapshotCells(session: ProjectSession, locales: string[]): PackageManifest["baseline"]`. For every key in `session.data.keyOrder` and every given locale, it records `{ v, s?, m? }` from `session.value` and `session.state.entries`. `s`/`m` are present only when a state entry exists. Cells that are missing **and** have no entry are omitted, to keep the file small.

- [ ] **Step 1: Write the failing tests.**

```ts
it("round-trips project.id through state.json", () => {
  const { state } = parseState('{"version":1,"project":{"id":"p-1"},"entries":{}}');
  expect(state.project.id).toBe("p-1");
  expect(serializeState(state)).toContain('"id": "p-1"');
});
it("parses a valid manifest and rejects others", () => {
  const m = { retransPackage: 1, format: "next-i18next", baseLocale: "en", locales: ["th"], localesPath: "public/locales", exportedAt: "2026-11-02T00:00:00.000Z", sourceProjectId: "p-1", baseline: {} };
  expect(parseManifest(JSON.stringify(m))).toEqual(m);
  expect(parseManifest(serializeManifest(m as PackageManifest))).toEqual(m);
  expect(parseManifest(null)).toBeNull();
  expect(parseManifest("{")).toBeNull();
  expect(parseManifest(JSON.stringify({ ...m, retransPackage: 2 }))).toBeNull();
  expect(parseManifest(JSON.stringify({ ...m, format: "xliff" }))).toBeNull();
});
it("snapshots values and statuses for the given locales", async () => {
  // en {a:"A", b:"B"}, th {a:"เอ"} with state th/a reviewed
  const snap = snapshotCells(session, ["th"]);
  expect(snap[keyId("common", "a")].th).toEqual({ v: hashValue({ kind: "text", text: "เอ" }), s: "reviewed" });
  expect(snap[keyId("common", "b")]).toBeUndefined();   // missing and no entry
});
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS, and the existing state-file and session tests stay green.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(package): project id and package manifest"
  ```

---

### Task 2: Zip commands (Rust)

**Files:**
- Create: `src-tauri/src/zip_cmds.rs`, `src/platform/zip.ts`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`

**Interfaces:**
- **Rust:**
  - `#[derive(Serialize, Deserialize)] pub struct ZipEntry { pub path: String, pub text: String }`
  - Command `zip_write(dest: String, entries: Vec<ZipEntry>) -> Result<(), String>`. Deflate; writes `dest.retrans-tmp`, then renames (atomic, same as `fs_cmds`).
  - Command `zip_read(src: String) -> Result<Vec<ZipEntry>, String>`.
  - Pure helper `pub fn clean_entry_path(raw: &str) -> Option<String>`:
    - Converts `\` to `/`.
    - Returns None for empty names, absolute names (`/x`, `C:/x`, `//x`), any `..` segment, and directory entries (trailing `/`).
    - Returns None for anything under `__MACOSX/`, and for names whose last segment is `.DS_Store`.
    - Strips a leading `./`.
- **`zip_read` rules:**
  - Entries for which `clean_entry_path` gives None are skipped.
  - More than `MAX_ENTRIES = 5000` entries, any entry over `MAX_ENTRY_BYTES = 20 * 1024 * 1024` uncompressed, a total over `MAX_TOTAL_BYTES = 200 * 1024 * 1024`, or any kept entry that isn't valid UTF-8 → `Err("This file isn't a Retrans package or project.")`.
  - The same error is returned when the file isn't a zip.
- **Cargo:** `zip = { version = "9", default-features = false, features = ["deflate"] }`.
- **`src/platform/zip.ts`:**
  - `zipWrite(dest: string, entries: Array<{ path: string; text: string }>): Promise<void>`
  - `zipRead(src: string): Promise<Array<{ path: string; text: string }>>`
  - Both use `invoke`. A string rejection becomes an `Error` with that message.

- [ ] **Step 1: Write the failing tests.** Inline `#[cfg(test)]`, with `tempfile`.
  - `round_trips_utf8_entries`: write `[("a/b.json","{\"x\":\"ไทย\"}"), (".retrans/package.json","{}")]`, then read → equal (order kept), and no `.retrans-tmp` left behind.
  - `clean_entry_path_rules`:
    - `"./a.json"` → `"a.json"`
    - `"a\\b.json"` → `"a/b.json"`
    - None for `"../x"`, `"a/../../x"`, `"/etc/x"`, `"C:/x"`, `"dir/"`, `"__MACOSX/a.json"`, `"x/.DS_Store"`.
  - `skips_junk_and_unsafe_entries`: a zip built directly with the `zip` crate (bypassing `zip_write`), containing `../evil.json`, `__MACOSX/._a`, and `ok.json` → read returns only `ok.json`.
  - `rejects_non_utf8_and_non_zip`: an entry with bytes `[0xff, 0xfe]` → Err with the exact message; a file containing `hello` → Err with the exact message.
  - `rejects_oversized_entry`: an entry of `MAX_ENTRY_BYTES + 1` bytes → Err. (Build it with a highly compressible `vec![b'a'; n]` so the test stays fast.)
- [ ] **Step 2: Run them and confirm they fail.** Run `cd src-tauri && cargo test zip_cmds`.
- [ ] **Step 3: Implement.** Register both commands in `lib.rs`. Check entry sizes against the header's uncompressed size **and** while reading, using `take(MAX_ENTRY_BYTES + 1)`, because the header can lie.
- [ ] **Step 4: Run all checks.** `cargo test`, `pnpm test`, `pnpm exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(package): safe zip read/write commands"
  ```

---

### Task 3: Building a package (export)

**Files:**
- Create: `src/package/build.ts`
- Test: `src/package/build.test.ts`

**Interfaces:**
- Consumes: Task 1 (`MANIFEST_PATH`, `parseManifest`, `serializeManifest`, `snapshotCells`, `project.id`), `setAt` from `src/core/json-text.ts`, `STATE_PATH`, `serializeState`, `session.files`, `session.state`, `session.isDirty()`, `session.stateMalformed`, `session.fs`, `session.data`.
- Produces:
  - `class ExportError extends Error {}`
  - `buildPackage(session: ProjectSession, opts: { locales: string[]; now: Date }): Promise<Array<{ path: string; text: string }>>`
  - `packageFileName(projectName: string, now: Date): string` → `${projectName}-translation-YYYY-MM-DD.zip`

**`buildPackage` rules:**
- **Refusals, checked first:**
  - `session.isDirty()` → `ExportError("Save your changes first.")`.
  - `session.stateMalformed` → `ExportError("Fix .retrans/state.json before exporting.")`.
  - `session.state.project.id` is missing → `ExportError("Save your changes first.")`. The UI (Task 6) assigns an id and saves before calling this.
- **Locales:** `included = [baseLocale, ...opts.locales filtered to project targets]`.
- **Locale files:**
  - Every `session.files` entry whose `locale` is in `included`.
  - Text is the loaded text (equal to disk, since the session is clean); paths are root-relative `relPath`.
- **`.retrans/state.json`:** `serializeState` of the state, with `entries` filtered to the included locales and `project` copied unchanged.
- **Paraglide:** `project.inlang/settings.json` read via `session.fs`, with its `locales` array replaced by `included` using `setAt` (minimal edit).
- **next-i18next:** each existing `next-i18next.config.{js,mjs,cjs,ts}` at the root, copied byte-for-byte.
- **Manifest `.retrans/package.json`:**
  - The project has no manifest of its own: `sourceProjectId = project.id`, `baseline = snapshotCells(session, opts.locales)`, `exportedAt = opts.now.toISOString()`, plus format, base, locales and localesPath from the session.
  - **The project was itself opened from a package** (a valid manifest exists at `MANIFEST_PATH` on disk): copy that manifest's `sourceProjectId`, `baseline`, `baseLocale` and `localesPath`. Set `locales` to the requested locales filtered to those of the original manifest. Update only `exportedAt`. This is how a translator sends work back without destroying the baseline (Review Focus #1).
- **Ordering:** entries are sorted by path.

- [ ] **Step 1: Write the failing tests** (MemoryFs projects, as in `src/mt/batch.test.ts`):
  - `"next-i18next: includes base + chosen locales, config copy, filtered state and manifest"`
    - Project `en`, `th`, `ja`, with `next-i18next.config.js`. Export `["th"]`.
    - Paths equal `[".retrans/package.json", ".retrans/state.json", "next-i18next.config.js", "public/locales/en/common.json", "public/locales/th/common.json"]`.
    - The config text is byte-identical.
    - `state.json` has no `ja` entries.
    - The manifest has `locales: ["th"]`, `sourceProjectId` equal to the project id, and a baseline for `th` cells.
  - `"paraglide: settings.json lists only the included locales and keeps the rest byte-identical"`.
  - `"refuses while dirty, with malformed state, or without a project id"`: exact messages.
  - `"re-export from a package project keeps the original baseline and source id"`:
    1. Write a manifest with `baseline: {X}` and `sourceProjectId: "dev-1"` into the project.
    2. Edit a `th` cell, then save.
    3. `buildPackage` → the manifest's `baseline` equals `X`, `sourceProjectId` is `"dev-1"`, and `exportedAt` is the new time.
  - `"packageFileName"`: `packageFileName("shop", new Date("2026-11-02T10:00:00Z"))` is `"shop-translation-2026-11-02.zip"`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(package): build translator packages"
  ```

---

### Task 4: Opening a package (detection and extract)

**Files:**
- Create: `src/package/extract.ts`
- Modify: `src/formats/detect.ts`, `src/ui/StartScreen.tsx`
- Test: `src/package/extract.test.ts`, `src/formats/detect.test.ts` (create if absent), `src/ui/StartScreen.test.tsx`

**Interfaces:**
- **`extract.ts`:**
  - `safeEntryPath(raw: string): string | null`. Same rules as Rust's `clean_entry_path` (defense in depth).
  - `extractPackage(fs: Fs, entries: Array<{ path: string; text: string }>, dest: string): Promise<void>`:
    - Refuses with `Error("Choose an empty folder.")` when `dest` exists and `fs.listFiles(dest, 1)` is non-empty.
    - Writes each safe entry with `mkdirp` + `writeTextAtomic`, and skips unsafe ones.
    - Requires at least one entry to be a locale file or the manifest. Otherwise it throws `Error("This file isn't a Retrans package or project.")` before writing anything.
- **`detect.ts`:** `detectProject(fs, root)` first reads `MANIFEST_PATH`. If `parseManifest` gives a manifest:
  - Run that format's adapter `detect`.
  - If it returns a result, override `baseLocale` with `manifest.baseLocale` when that is in `result.locales`.
  - If it returns null, throw `Error("This file isn't a Retrans package or project.")`.
  - Without a manifest, behaviour is unchanged.
- **StartScreen:**
  - New button `Open translator package…`. It picks a `.zip` via plugin-dialog `open({ filters: [{ name: "Retrans package", extensions: ["zip"] }] })`.
  - Then a folder via `open({ directory: true, title: "Choose where to put the project" })`.
  - Extract into `<folder>/<zip file name without .zip>`, then follow the normal open-project flow on that path.
  - Errors show in the start screen's existing error area.

- [ ] **Step 1: Write the failing tests:**
  - `extractPackage`:
    - writes nested files;
    - skips `../evil.json` (and nothing appears outside `dest`);
    - refuses a non-empty `dest`;
    - refuses entries that hold only `README.txt`.
  - `detectProject`:
    - A next-i18next package without a config file (so detection returns `baseLocale: null`) uses the manifest's `baseLocale: "en"`.
    - A manifest pointing at a missing layout throws the exact message.
    - A Paraglide project with no manifest behaves exactly as before.
  - StartScreen: clicking `Open translator package…` with mocked dialogs and a mocked `zipRead` extracts to `<folder>/shop-translation-2026-11-02`, and the open flow starts with that root.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(package): open translator packages"
  ```

---

### Task 5: Import diff and apply (logic)

**Files:**
- Create: `src/package/diff.ts`
- Modify: `src/core/session.ts` (`importCell`)
- Test: `src/package/diff.test.ts`

**Interfaces:**
- **`session.ts`:** `importCell(id: KeyId, locale: string, value: MessageValue | undefined, entry: StateEntry | undefined): void`. Requires the cell, then:
  - `value` undefined → clear the value and the state entry.
  - Otherwise put the value, then:
    - with an `entry`: set `state.entries[id][locale] = { ...entry }`;
    - without one: `recordEdit(..., machine=false)`.

  Then mark the state touched and emit.
- **`diff.ts`:**
  - `interface ImportItem { id: KeyId; locale: string; kind: "new" | "changed" | "status" | "conflict"; mine?: MessageValue; theirs?: MessageValue; theirsEntry?: StateEntry }`
  - `interface ImportDiff { items: ImportItem[]; skipped: Array<{ id: KeyId; locale: string; reason: "unknown-key" | "unknown-locale" | "base-locale" }>; otherProject: boolean; hasManifest: boolean }`
  - `openIncoming(entries: Array<{ path: string; text: string }>): Promise<{ session: ProjectSession; manifest: PackageManifest | null }>`. Loads the entries into a fresh `MemoryFs` at root `/incoming`, then runs `detectProject` and `ProjectSession.open`.
    - The base comes from the manifest, else from detection.
    - If neither gives a base, use the current project's base when it's among the detected locales.
    - No detection result → throw `Error("Couldn't find translation files here.")`.
  - `openIncomingFolder(fs: Fs, root: string)`: same contract on a real folder (a plain folder import).
  - `diffPackage(current: ProjectSession, incoming: ProjectSession, manifest: PackageManifest | null): ImportDiff`
  - `applyImport(current: ProjectSession, diff: ImportDiff, picks: Map<string, "mine" | "theirs">): number`. The pick key is `${id}|${locale}`. It returns the number of cells changed. Conflicts with no pick keep mine.

**Diff rules** (per key in the incoming project × incoming locale):
- **Base locale:** skip with `base-locale` when the incoming base value differs from the current one.
- **Unknown locale:** a locale not in the current project → `unknown-locale`, once per locale (id `""`).
- **Unknown key:** a key not in the current project → `unknown-key`, per key and locale, only when the incoming cell has a value.
- **Signatures:**
  - `sig(value, entry) = hashValue(value) + "|" + (entry?.s ?? "") + "|" + (entry?.m ? "m" : "")`.
  - `snap` is the manifest baseline cell, or `{ v: hashValue(undefined) }`. Its signature is `snap.v + "|" + (snap.s ?? "") + "|" + (snap.m ? "m" : "")`.
- **With a manifest:** `mineChanged = sig(mine) !== snapSig` and `theirsChanged = sig(theirs) !== snapSig`.
  - `!theirsChanged` → nothing.
  - `valuesEqual(mine, theirs)` and the status differs and `!mineChanged` → `status`.
  - The values are equal in any other case → nothing.
  - `theirsChanged && !mineChanged` → `new` when mine is missing, otherwise `changed` (this also covers a translator who cleared the cell).
  - Both changed with different values → `conflict`.
- **Without a manifest (values only, no entries carried):**
  - theirs missing or equal → nothing;
  - mine missing → `new`;
  - otherwise → `conflict`.
- **Other project:** `otherProject = !!manifest && manifest.sourceProjectId !== current.state.project.id`.
- **Apply:** applying "theirs" calls `importCell(id, locale, theirs, theirsEntry)`.

- [ ] **Step 1: Write the failing tests.** Build "dev" and "package" sessions from MemoryFs. Produce the package with `buildPackage` from Task 3, then edit both sides:
  - `"translator fills a missing cell → new, with their reviewed status"`: apply → value set and `meta.status === "reviewed"`.
  - `"translator's machine flag travels"`.
  - `"translator only marks reviewed → status item"`.
  - `"both edited the same cell differently → conflict; picks decide; default keeps mine"`.
  - `"dev edited a cell the translator didn't touch → nothing"`.
  - `"dev deleted a key after export → skipped unknown-key"`.
  - `"translator changed base text → skipped base-locale and never applied"`.
  - `"dev added a language after export → its cells untouched"`.
  - `"package from another project → otherProject true"`.
  - `"no manifest → values only: missing→new, differing→conflict, no status carried"`.
  - `"applyImport returns the count and leaves the session dirty for a normal save"`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(package): three-way import diff and apply"
  ```

---

### Task 6: Import / Export page

**Files:**
- Create: `src/ui/SharePage.tsx`, `src/ui/ImportDialog.tsx`
- Modify: `src/ui/Sidebar.tsx` (`Page` gains `"share"`, label `Import / Export`, placed between Languages and Settings), `src/ui/AppShell.tsx`
- Test: `src/ui/SharePage.test.tsx`

**Interfaces:**
- Consumes: `buildPackage`, `packageFileName`, `ExportError` (Task 3), `zipWrite`/`zipRead` (Task 2), `openIncoming`/`openIncomingFolder`/`diffPackage`/`applyImport` (Task 5), `useApp().save()`, `session.setProjectSetting({ id })`, plugin-dialog `save`/`open`.

**`SharePage` behaviour:**
- **"Export for translator" section:**
  - A checkbox per target locale, all checked by default, and an `Export…` button.
  - While dirty, the button is disabled and the note `Save your changes first.` shows.
  - **On click:**
    1. If there is no `project.id`, set `crypto.randomUUID()` via `setProjectSetting`, then `await useApp.getState().save()`.
    2. `buildPackage`.
    3. `save({ defaultPath: packageFileName(name, new Date()), filters: [{ name: "Retrans package", extensions: ["zip"] }] })`.
    4. `zipWrite`.
  - **Result:** `Exported <file name>.` in a `role="status"` region. An `ExportError` message shows in a `role="alert"` region.
  - **Copy for package projects:** when the project was opened from a package (it has a manifest), the section title reads `Send back to the developer` and the button reads `Export…`.
- **"Import translator work" section:**
  - `Import package (.zip)…` → `zipRead` → `openIncoming`.
  - `Import folder…` → `openIncomingFolder(tauriFs, folder)`.
  - Either path then runs `diffPackage` and opens `ImportDialog`.

**`ImportDialog` (shared `Dialog`):**
- **Header counts:** `<n> new`, `<n> changed`, `<n> status only`, `<n> conflicts`, `<n> skipped`.
- **Warnings:** shows the exact `otherProject` copy when it applies. Shows `No package info: only values are merged.` when there is no manifest.
- **List:** a scrollable list of items with key path, locale, mine → theirs (`(empty)` for missing). Conflicts get radio buttons `Keep mine` / `Use theirs`, plus buttons `Use theirs for all conflicts` and `Keep mine for all`.
- **Buttons:** `Apply` → `applyImport` → closes, then shows `Imported <count> changes. Review and save.` on the page. `Cancel` closes.
- **Nothing to import:** `Nothing to import.` with a single `Close` button.

- [ ] **Step 1: Write the failing tests** (mock plugin-dialog and `../platform/zip`; MemoryFs sessions):
  - The export button is disabled with the note when dirty.
  - Export assigns an id and saves when missing, then calls `zipWrite` with the dialog path and entries that include `.retrans/package.json`.
  - Export shows the `ExportError` message.
  - Importing a package shows the counts; picking `Use theirs` on a conflict, then `Apply`, updates the session and shows the status line.
  - The other-project warning and the no-manifest note render.
  - The sidebar shows `Import / Export` and navigates.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(package): import/export page and import review dialog"
  ```

---

### Task 7: In-app updates

**Files:**
- Create: `src/platform/updates.ts`, `src/ui/UpdateBanner.tsx`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`, `src-tauri/tauri.conf.json`, `package.json`, `src/platform/prefs.ts`, `src/ui/SettingsPage.tsx`, `src/App.tsx`
- Test: `src/ui/UpdateBanner.test.tsx`

**Interfaces:**
- **Rust:** `tauri-plugin-updater = "2"` and `tauri-plugin-process = "2"`, both registered.
- **Capabilities:** add `updater:default` and `process:allow-restart`.
- **JS dependencies:** `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`.
- **`tauri.conf.json`:** `plugins.updater = { pubkey: "REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY", endpoints: ["https://github.com/REPLACE_OWNER/REPLACE_REPO/releases/latest/download/latest.json"] }`. Task 9 replaces both placeholders with real values. Do **not** set `bundle.createUpdaterArtifacts` here (local builds have no signing key).
- **`updates.ts`:**
  - `interface AvailableUpdate { version: string; notes?: string; install(onProgress?: (done: number, total: number) => void): Promise<void> }`
  - `checkForUpdate(): Promise<AvailableUpdate | null>` wraps `check()`. `install` calls `downloadAndInstall`, then `relaunch()`.
- **`prefs.ts`:** `getAutoCheckUpdates(): Promise<boolean>` (default `true`) and `setAutoCheckUpdates(on: boolean)`.
- **`UpdateBanner`:**
  - Mounted once in `App`. On mount, when auto-check is on, it calls `checkForUpdate()` once.
  - Errors (offline, placeholder key, dev build) → `console.warn` only, and nothing is shown.
  - When an update is found: a top banner with `Retrans <version> is available.` and buttons `Install and restart` / `Later`.
  - While installing: a progress text `Downloading… <percent>%`. An install failure shows `Update failed. Try again later.`
- **Settings:** a section `<h2>Updates</h2>` with:
  - a checkbox `Check for updates automatically`;
  - a button `Check for updates` showing `You're up to date.`, `Retrans <version> is available.` (with `Install and restart`), or `Couldn't check for updates.`

- [ ] **Step 1: Write the failing tests** (mock `../platform/updates` and prefs):
  - The banner appears with the version.
  - `Later` hides it.
  - `Install and restart` calls `install`.
  - A rejected check renders nothing (and the console.warn is captured).
  - With auto-check off, no check runs.
  - The Settings button shows each of the three outcomes.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Run `pnpm test`, `tsc` and `cargo test`. Expected: PASS. `cargo build` must succeed with the placeholder pubkey; the updater only validates it at check time.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(updates): in-app update check and install"
  ```

---

### Task 8: Windows engine — all CPU variants

**Files:**
- Modify: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/src/mt/engine.rs`, `src-tauri/tauri.conf.json` (Windows resources)
- Test: inline in `engine.rs`

**Decision:**
- On Windows only, build `llama-cpp-2` with `features = ["dynamic-backends"]` (which implies shared libraries).
- llama.cpp then builds `GGML_CPU_ALL_VARIANTS` as separate `ggml-cpu-*.dll` files, and ggml loads the best one for the user's CPU at runtime.
- This fixes the SSE2-only baseline parked in Plan 2.
- macOS stays exactly as it is (static, Metal).

**Interfaces and rules:**
- **Cargo:** the existing `[target.'cfg(not(target_os = "macos"))'.dependencies]` entry becomes `llama-cpp-2 = { version = "0.1.160", default-features = false, features = ["dynamic-backends"] }`.
  - Add `llama-cpp-sys-2 = "0.1.160"` as a direct dependency under the same target, so `build.rs` receives `DEP_LLAMA_BACKENDS_DIR`.
  - Confirm the env-var name by reading `llama-cpp-sys-2`'s `build.rs` (`cargo:backends_dir=`).
- **`build.rs`:**
  - On Windows, copy every `.dll` from the backends dir, and the shared `llama.dll`/`ggml*.dll` from the sys crate's output, into `src-tauri/llama-dlls/`. Add that folder to `.gitignore`.
  - Keep the macOS `link_clang_runtime_on_macos`. While there, harden it as deferred in Plan 2: prefer `xcrun --find clang`, fall back to `clang`, and print `cargo:warning` when the runtime dir or `libclang_rt.osx.a` is missing.
- **`tauri.conf.json`:** `bundle.windows`-compatible resources mapping `"llama-dlls/*.dll"` into the install root, next to the exe. Use the Tauri v2 resources map form `{ "llama-dlls/": "./" }` or the equivalent glob that the Tauri CLI accepts. Verify by listing the NSIS install tree in CI (Task 9).
- **`engine.rs`:** on Windows, before the first `LlamaBackend::init()`, call `llama_cpp_2::llama_backend::load_backends_from_path(<dir of current_exe>)`. Gate it with `#[cfg(target_os = "windows")]`.
- **Smoke test:**
  - Add `#[test] #[ignore] fn generates_with_tiny_model()`. It reads `RETRANS_SMOKE_MODEL` and runs `generate` with prompt `"Once upon a time"`, `addBos=true`, `maxTokens=16`, no stop strings.
  - It asserts the output is non-empty and that no error occurred.
  - Model (CI only): `https://huggingface.co/ggml-org/test-model-stories260K/resolve/479896ec924af6d40fd419ab8f4d1eb2101de00d/stories260K-f32.gguf`, size `1185376`, SHA-256 `270cba1bd5109f42d03350f60406024560464db173c0e387d91f0426d3bd256d`.

- [ ] **Step 1: Write the smoke test.** Add `generates_with_tiny_model` as above. Locally on macOS, download the 1.2 MB model to the scratch dir, verify its SHA-256, then run `RETRANS_SMOKE_MODEL=<path> cargo test generates_with_tiny_model -- --ignored`. Expected: PASS.
- [ ] **Step 2: Implement the Windows-only changes.** Everything Windows-specific is `cfg`-gated or target-gated, so macOS builds are unaffected.
- [ ] **Step 3: Verify on macOS.** Run `cargo test` and `pnpm tauri build --bundles app`. Expected: success, and the `.app` stays under 40 MB.
- [ ] **Step 4: Commit.**
  ```bash
  git commit -m "feat(mt): Windows engine with runtime CPU variant selection"
  ```

The Windows build itself is verified by Task 9's CI. If it fails there, fix it in Task 9's loop.

---

### Task 9: CI and release workflows

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `src-tauri/tauri.release.conf.json`
- Modify: `src-tauri/tauri.conf.json` (real pubkey and endpoint), `README.md` (Releasing)

**Step 0 — the user's part. Stop and ask before doing any of this; it creates public things and secrets:**
1. Create a **public** GitHub repository. Public repos get unlimited free Actions minutes; private repos bill macOS minutes at 10×.
2. `git remote add origin <url>`.
3. Generate the update key: `pnpm tauri signer generate -w ~/.tauri/retrans.key`. Keep the password.
4. Add the repo secrets `TAURI_SIGNING_PRIVATE_KEY` (the key file's content) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
5. Paste the public key (`~/.tauri/retrans.key.pub` content) into the conversation. It is safe to share.

Then replace both placeholders in `tauri.conf.json`. The OWNER/REPO come from `git remote get-url origin`.

**`ci.yml`:**
- On push and pull_request. Matrix `macos-latest` and `windows-latest`.
- Steps:
  1. checkout
  2. pnpm (`pnpm/action-setup`) + node LTS with pnpm cache
  3. `dtolnay/rust-toolchain@stable`
  4. `swatinem/rust-cache@v2` (workspace `./src-tauri -> target`)
  5. `pnpm install --frozen-lockfile`
  6. `pnpm test`
  7. `pnpm exec tsc --noEmit`
  8. `cargo test` (in `src-tauri`)
  9. Download the stories260K model from Task 8 with its SHA-256 check, then `cargo test generates_with_tiny_model -- --ignored` with `RETRANS_SMOKE_MODEL` set.
- On Windows, after `cargo test`: `pnpm tauri build --bundles nsis`, then list the bundle folder to confirm the `ggml-cpu-*.dll` files are in the installer payload. Use `7z l` on the NSIS exe; 7-Zip is preinstalled on Windows runners.

**`release.yml`:**
- On push of tags `v*`, with `permissions: contents: write`.
- Matrix:
  - `macos-latest` with `--target aarch64-apple-darwin`
  - `macos-latest` with `--target x86_64-apple-darwin`
  - `windows-latest` with no args
- Same setup as CI, with the Rust targets for macOS. Then `tauri-apps/tauri-action@v1`:
  - `tagName: v__VERSION__`
  - `releaseName: "Retrans v__VERSION__"`
  - `releaseDraft: true`
  - `prerelease: false`
  - `updaterJsonPreferNsis: true`
  - `args: "${{ matrix.args }} --config src-tauri/tauri.release.conf.json"`
  - env `GITHUB_TOKEN`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `tauri.release.conf.json` is `{ "bundle": { "createUpdaterArtifacts": true } }`.

**README "Releasing" section:**
1. Bump `version` in `src-tauri/tauri.conf.json` and `package.json`.
2. Run the manual checklist on a real Mac and a real Windows machine (spec §11).
3. `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. Wait for the draft release.
5. Edit its notes, then publish. Publishing is what makes `latest.json` reach users.

Also document key safety: never commit the key, and losing it means existing installs can't auto-update.

- [ ] **Step 1: Ask the user for Step 0.** Wait until it's done, then fill in the pubkey and endpoint.
- [ ] **Step 2: Write the two workflows and the release config.**
- [ ] **Step 3: Push and watch CI.** Ask the user before the first push to the remote. Then run `git push -u origin feat/packages-releases` and watch with `gh run watch`.
  - Expected: both CI jobs green, including the Windows smoke test and the DLL listing.
  - If they fail, fix and push again. Up to 5 rounds; each fix is a commit with the usual review.
  - **Ruling allowed:** if the macOS `x86_64` cross build can't be made green within the loop, drop that matrix entry, note "Apple Silicon only for now" in the README, and record the ruling.
- [ ] **Step 4: Write the README section.**
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "ci: test matrix and tagged release workflow with updater artifacts"
  ```

The first real release (tag push) is the user's call after merge. It is not part of this plan.

---

### Task 10: End-to-end package round trip and docs

**Files:**
- Create: `src/test/e2e-package.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the end-to-end test** (MemoryFs, fixture `src/test/fixtures/next-nested`):
  1. The developer opens the project, sets an id, saves, and `buildPackage` exports `["th"]`.
  2. `extractPackage` puts it in `/translator/pkg`; `detectProject` + open (the manifest is honoured).
  3. The translator fills two missing `th` cells, marks one Reviewed, and saves.
  4. The translator runs `buildPackage` (re-export), and the baseline is kept.
  5. Meanwhile the developer edits one *other* `th` cell and one cell the translator also changed.
  6. `openIncoming` + `diffPackage` → exactly 2 `new` (one carrying the translator's `reviewed` entry), 0 `status`, and 1 `conflict`. Assert the exact ids.
  7. `applyImport` with the conflict picked as `theirs`, then save.
  8. Check the result:
     - the developer's file holds the translator's values;
     - the Reviewed status is kept in `state.json`;
     - the developer's other edit survives;
     - `en` files are byte-identical to the fixture.
- [ ] **Step 2: Run it.** Run `pnpm test src/test/e2e-package.test.ts`. Expected: PASS. Fix bugs in earlier tasks if it finds any.
- [ ] **Step 3: Update the README.**
  - **Translator workflow:** a "Working with a translator" section covering export → send zip → translator opens it (`Open translator package…`), translates, uses `Send back to the developer` → developer `Import package (.zip)…` → reviews → Save.
  - **Manual checklist, new items:**
    - export / open / re-export / import with a conflict;
    - an update banner appears against a draft-free test release (after the first real release);
    - Windows: suggestions work on a non-AVX2 machine if one is available, otherwise on any machine.
- [ ] **Step 4: Run full verification.** `pnpm test`, `pnpm exec tsc --noEmit`, `cd src-tauri && cargo test`, `pnpm tauri build --bundles app`. Expected: all pass, and the `.app` stays under 40 MB.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "test(package): end-to-end translator round trip; docs"
  ```

---

## Rulings in this plan (cost if wrong)

**Translator packages:**
- **A package must come from a saved project with a stable id.** Export saves first (assigning an id) and refuses while there are unsaved edits. *Cost: one extra save before the first export.*
- **The baseline is a per-cell hash + status snapshot inside the manifest**, not a copy of all values. *Cost: a larger manifest for huge projects (about 100 bytes per cell).*
- **A translator's re-export keeps the original baseline.** Without that, three-way import is impossible. *Cost: a translator who wants to start a fresh package for someone else must get a new export from the developer.*
- **Plain folder import (no manifest) needs a detectable project layout**, and any differing value is a conflict. *Cost: a loose folder of JSON files must be placed in the normal layout first.*
- **Keys and languages the developer's project doesn't have are reported and skipped**, never added. *Cost: a translator can't introduce keys through a package.*
- **Opening a package extracts it into a folder the translator picks.** The app never edits files inside a zip. *Cost: one extra folder prompt.*

**Releases:**
- **Updates check automatically on launch (on by default, can be turned off),** using GitHub's `releases/latest/download/latest.json`. Releases are drafts until the developer publishes them. *Cost: one request to GitHub per launch.*
- **Updater artifacts are only built in the release workflow** (`--config tauri.release.conf.json`), so local builds need no signing key. *Cost: none.*

**Windows engine:**
- **Windows uses dynamic CPU backends; macOS stays static.** *Cost: about 10 extra DLLs in the Windows installer, which may push the Windows installer size up. Task 9 reports the number.*
