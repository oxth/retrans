# Preferences page, app menus, shortcuts and undo/redo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App-wide settings get their own Preferences page that opens from anywhere. Retrans gets native menus with the usual shortcuts (Settings… ⌘, / Ctrl+,). Undo and redo work per tab.

**Architecture:**
- **Undo history lives in `ProjectSession`.** A step records a "before" image of only what it touches:
  - the cells and review entries of each key touched, captured on first touch inside `put` and the key-structure methods;
  - the key order;
  - the workspace meta (its object is replaced on every change, so a reference is enough).
- **One step per user action.** A step closes when the top-level `batch` or `emit` ends. An explicit group spans a whole Translate-missing run.
- **External changes are never recorded:** source and Figma sync, reload from disk, applying a journal. They run inside `session.external(fn)`.
- **Safe undo:** undo restores only cells still equal to the step's "after" image. Anything changed since (by a sync) is skipped and counted.
- **Language add/remove** is undone by calling the opposite method, since it creates or removes files.
- **Menus** are built in TypeScript with `@tauri-apps/api/menu` and dispatch to store actions.
- **Preferences** is an overlay page held by a store flag.

**Tech Stack:** TypeScript, React 19, Zustand, Vitest/Testing Library, Tauri 2 menu API. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-05-retrans-preferences-menus-undo-design.md`. Owner decisions: Windows uses a menu bar with **File → Settings… (Ctrl+,)**; undo covers edits only.

## Global Constraints

- **Menu copy:**
  - macOS app menu: `Settings…` with ⌘,.
  - Windows: `File → Settings…` with Ctrl+,.
  - The page title is `Preferences`. The project's sidebar page stays `Settings`.
- **Shortcuts** (Tauri accelerators, `CmdOrCtrl`):

  | Item | Accelerator |
  |---|---|
  | New Project… | `CmdOrCtrl+N` |
  | Open Project… | `CmdOrCtrl+O` |
  | Close Tab | `CmdOrCtrl+W` |
  | Save | `CmdOrCtrl+S` |
  | Export… | `CmdOrCtrl+E` |
  | Undo | `CmdOrCtrl+Z` |
  | Redo | `CmdOrCtrl+Shift+Z`, plus `Ctrl+Y` on Windows |
  | Find | `CmdOrCtrl+F` |
  | Next Tab | `Ctrl+Tab` |
  | Previous Tab | `Ctrl+Shift+Tab` |
  | Settings… | `CmdOrCtrl+,` |

- **Undoable**, one step each:
  - a cell edit or clear;
  - mark reviewed;
  - add, rename, move or delete a key;
  - add or remove a language;
  - resolve a conflict (one or all);
  - Set code key / Link to code key;
  - Keep (removed-in-source);
  - a whole Translate-missing run.
- **Not undoable:** sync from TypeScript or Figma, reload from disk, journal restore, save, export, settings changes.
- **History:** per session (per tab), at most **200** steps. A new step clears redo. Closing the tab drops the history.
- **Skipped cells:** when undo skips cells changed since, the tab shows the error `Some changes came from your code or Figma since — those weren't undone.`
- **Text fields:** while an `<input>` or `<textarea>` has focus, Undo/Redo call `document.execCommand("undo"/"redo")` (the field's own history) and do not touch the app history. Cut/Copy/Paste/Select All are native predefined items.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Before each commit: `pnpm test`, `pnpm exec tsc --noEmit`.

## Review Focus

1. **Undo after auto-save has written the edit.** The workspace goes back, the tab becomes dirty, and auto-save writes the old value. Files follow the workspace. Pinned by `undo after a save makes the session dirty again with the old value` (Task 1).
2. **Undo of a cell that a TypeScript or Figma sync changed after the edit.** That cell is left alone, the others in the step are undone, and the message shows. Pinned by `undo skips a cell changed by an external change since` (Task 1).
3. **⌘Z while typing in the cell editor.** It undoes typing in the field only, never an app step. Pinned by `Undo in a focused textarea uses the field's own undo` (Task 3).
4. **Undo of "Take all theirs"** across many cells. One step restores all of them. Pinned by `resolveAllConflicts is one step` (Task 2).
5. **Undo of a key rename, then an edit, then undo twice.** The value and the key name both come back, in order, with no orphan row. Pinned by `rename then edit undoes in reverse order` (Task 1).

---

### Task 1: Undo history in the session

**Files:**
- Create: `src/core/history.ts` (types and the step record helpers)
- Modify: `src/core/session.ts` (recording hooks in `put`, `setKeyOrder`, `setWorkspaceMeta`, state-entry writes, `renameKey`, `moveKey`, `deleteKey`, `insertKey`, `addKey`, `addLanguage`, `removeLanguage`; `batch`/`emit` close steps)
- Test: `src/core/history.test.ts`

**Interfaces:**
- Produces on `ProjectSession`:

```ts
get canUndo(): boolean; get canRedo(): boolean;
undo(): { done: boolean; skipped: number };   // skipped = cells changed since the step, left alone
redo(): { done: boolean; skipped: number };
/** Runs fn without recording (sync, reload, journal). Nested calls fine. */
external<T>(fn: () => T): T;
/** Groups every change until endGroup() into one step (e.g. a Translate-missing run). */
beginGroup(): void; endGroup(): void;
```

- **A step** is `{ before: Image; after: Image; lang?: { added?: string; removed?: string } }`, where `Image` holds:
  - `cells: Map<KeyId, { values: Map<string, MessageValue> | undefined; entries: Record<string, StateEntry> | undefined }>`, for touched keys only, deep-copied;
  - `keyOrder: KeyId[]`;
  - `meta: WorkspaceMeta | null`.
- **Recording:**
  - On the first touch of a key in an open step, copy its values and entries into `before`.
  - When the step closes, read the same keys into `after`.
  - Drop a step with no changes.
  - Cap the history at 200 steps; a new step clears redo.
- **Undo, per touched key:**
  - if the current image equals `after`, restore `before` (no recording while restoring);
  - otherwise skip that key and count it.
  - Restore `keyOrder` and `meta` only when they still equal `after`.
  - Then `emit()` once.
- **Language steps:** undo of an added language calls `removeLanguage(l)`. Undo of a removed one calls `addLanguage(l)` and then restores the cells.

- [ ] **Step 1: Write failing tests:**
  - `undo/redo a cell edit`;
  - `a batch is one step`;
  - `rename then edit undoes in reverse order`;
  - `delete key undo brings the row and values back in place`;
  - `mark reviewed is undoable`;
  - `add language undo removes it; redo adds it back`;
  - `undo after a save makes the session dirty again with the old value`;
  - `undo skips a cell changed by an external change since` (change the cell inside `session.external(() => session.importCell(…))`; expect `skipped === 1`; the other cells in the step are undone);
  - `external changes are not recorded`;
  - `a new edit clears redo`;
  - `history keeps at most 200 steps`;
  - `beginGroup/endGroup makes one step of many edits`;
  - `workspace meta changes (Keep, Figma links) are undone with the step`.
- [ ] **Step 2: Run** `pnpm vitest run src/core/history.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test && pnpm exec tsc --noEmit`. Expected: PASS. The existing tests are unchanged: recording has no visible effect.
- [ ] **Step 5: Commit** with the message `feat(core): per-session undo/redo history`.

---

### Task 2: Mark external changes; one step per Translate-missing run

**Files:**
- Modify: `src/workspace/sync.ts` (the merge in `syncNow` and `resolveSyncConflict`'s baseline-only parts stay recorded; wrap the merge batch in `session.external`), `src/figma/sync.ts` (same), `src/core/session.ts` (`reloadNow`, `applyJournal`, `pinBaseLocaleNow` run as external), `src/ui/runs.ts` (`beginGroup` at start, `endGroup` in `finally`)
- Test: `src/core/history.test.ts` (more cases), `src/ui/runs.test.ts`

**Interfaces:**
- Consumes the Task 1 API.
- `resolveConflict`, `resolveSyncConflict`, `resolveFigmaConflict`, `linkToKey`, `setCodeKey` and `keepKey` stay **recorded**: they are user actions.

- [ ] **Step 1: Write failing tests:**
  - `a TypeScript sync is not an undo step`;
  - `a Figma sync is not an undo step`;
  - `reload from disk is not an undo step`;
  - `resolveAllConflicts is one step` (through the store with three conflicts);
  - in `runs.test.ts`: `a Translate-missing run is one undo step`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test && pnpm exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(core): syncs and reloads are not undo steps; a Translate-missing run is one`.

---

### Task 3: Undo/redo in the app (store, keys, text fields)

**Files:**
- Modify: `src/ui/store.ts` (actions `undo()`, `redo()` on the active tab; on `skipped > 0`, set the tab's error to the constant copy)
- Create: `src/ui/edit-commands.ts`, exporting `runUndo()`, `runRedo()`, `runFind()`. Each decides between the focused field and the app; `runFind` focuses `role="searchbox" name="Search"`.
- Modify: `src/ui/AppShell.tsx` (the existing ⌘S `keydown` effect also handles ⌘Z, ⇧⌘Z and Ctrl+Y through `edit-commands`, so it works without native menus in tests and in the browser)
- Test: `src/ui/undo.test.tsx`

**Interfaces:**
- `useApp.getState().undo(): void`, `redo(): void`.
- `runUndo()`:
  - if `document.activeElement` is an `INPUT` or `TEXTAREA`, call `document.execCommand("undo")`;
  - otherwise call `useApp.getState().undo()`.
  - `runRedo()` works the same way.

- [ ] **Step 1: Write failing tests:**
  - `⌘Z undoes the last cell edit and ⇧⌘Z redoes it`;
  - `Ctrl+Y redoes`;
  - `Undo in a focused textarea uses the field's own undo` (spy on `document.execCommand`; the session value is unchanged);
  - `undo skipping changed cells shows the message`;
  - `each tab has its own history`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test && pnpm exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(ui): undo and redo with ⌘Z / ⇧⌘Z / Ctrl+Y, text fields keep their own undo`.

---

### Task 4: Preferences page

**Files:**
- Create: `src/ui/PreferencesPage.tsx`, `src/ui/PreferencesPage.test.tsx`
- Modify:
  - `src/ui/SettingsPage.tsx`: keeps only project items (locales path, Figma). It loses default view, Machine translation, Startup and Updates, and gains a link `Preferences…` that opens the page.
  - `src/ui/store.ts`: `prefsOpen: boolean`, `openPrefs()`, `closePrefs()`.
  - `src/App.tsx`: render `<PreferencesPage />` over the current page when `prefsOpen`.
  - `src/ui/StartScreen.tsx`: a gear button `Preferences` in the header.

**Interfaces:**
- `PreferencesPage` takes no props. It renders a full-height page titled `Preferences` with a `Done` button (`closePrefs`), and these sections:
  - `Default view`;
  - `Startup` (`StartupSettings`);
  - `Machine translation` (`MtSettings`, which must work with no session; pass `session={null}` and make its project-only parts optional, ledgered);
  - `Updates` (`UpdateSettings`).
- Escape closes it.

- [ ] **Step 1: Write failing tests:**
  - `opens from the start screen gear and closes with Done`;
  - `opens from a project's Settings → Preferences…`;
  - `project Settings shows only project items`;
  - `Escape closes Preferences`;
  - `Machine translation works with no project open`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Move the sections; don't duplicate them.
- [ ] **Step 4: Run** `pnpm test && pnpm exec tsc --noEmit`. Expected: PASS; update existing SettingsPage tests that look for moved sections, and ledger each one.
- [ ] **Step 5: Commit** with the message `feat(ui): Preferences page for app-wide settings; project Settings keeps project items`.

---

### Task 5: Native menus

**Files:**
- Create: `src/platform/menu.ts` (builds and installs the menu; pure `menuSpec(platform, ctx)` plus `installMenu()`), `src/platform/menu.test.ts`
- Modify:
  - `src/App.tsx`: install once on mount, and update enabled states when `activeId` or `canUndo`/`canRedo` change;
  - `src-tauri/capabilities/default.json`: add the `core:menu:*` permissions the API needs. Check them in `src-tauri/gen/schemas/desktop-schema.json`; `core:menu:default` if it exists.

**Interfaces:**
- `export interface MenuItemSpec { id: string; text: string; accelerator?: string; enabled?: boolean; predefined?: "cut" | "copy" | "paste" | "selectAll" | "separator" | "minimize" | "zoom" | "hide" | "quit" }`
- `export function menuSpec(platform: "macos" | "windows", ctx: { hasProject: boolean; canUndo: boolean; canRedo: boolean }): Array<{ text: string; items: MenuItemSpec[] }>`, implementing the spec §2 table:
  - macOS: menus `Retrans`, `File`, `Edit`, `View`, `Window`, `Help`; `Settings…` (`CmdOrCtrl+,`) in `Retrans`.
  - Windows: no `Retrans` or `Window` menu; `Settings…` (`CmdOrCtrl+,`) in `File`, followed by `Exit`.
  - `Redo` is `CmdOrCtrl+Shift+Z`. On Windows, also add a hidden-text duplicate `redo-alt` with `Ctrl+Y` if the API allows a second accelerator; otherwise rely on the Task 3 keydown handler, and ledger which.
  - Project-only items are disabled when `!hasProject`: Save, Close Tab, Export…, Import Figma Files…, Undo, Redo, Find, List/Table view, Next/Previous Tab.
- `export async function installMenu(onAction: (id: string) => void): Promise<(ctx) => Promise<void>>` creates the Tauri menu from `menuSpec(currentPlatform, ctx)` and returns an updater for enabled states.
- **Action ids → behaviour:**

  | Id | Behaviour |
  |---|---|
  | `settings` | `openPrefs` |
  | `new-project` | open the New Project wizard |
  | `open-project` | the Start screen's Open flow |
  | `close-tab` | `closeTab(activeId)` |
  | `save` | `save` |
  | `export` | open the Export dialog |
  | `import-figma` | open Settings → Figma import |
  | `undo` / `redo` | `runUndo` / `runRedo` |
  | `find` | `runFind` |
  | `view-list` / `view-table` | the existing view-mode setter |
  | `next-tab` / `prev-tab` | the tab after or before the active one, wrapping |
  | `check-updates` | the existing update check |
  | `about` | a small About dialog with name and version |
  | `github` | `openUrl("https://github.com/oxth/retrans")` |

  - New Project and Open Project from inside a project first call `showStart()` and then trigger the flow, using a store request flag that StartScreen reads (`startRequest: "new" | "open" | null`).

- [ ] **Step 1: Write failing tests** in `src/platform/menu.test.ts` (pure `menuSpec`):
  - `macOS has Settings… ⌘, in the Retrans menu`;
  - `Windows has File → Settings… Ctrl+, and no Retrans menu`;
  - `project items are disabled on the start screen`;
  - `undo/redo follow canUndo/canRedo`;
  - `every action id has a handler` (import the handler map from `App`'s menu wiring module).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement**, reading the Tauri menu API docs first: `npx ctx7@latest docs /tauri-apps/tauri-docs "menu PredefinedMenuItem accelerator setAsAppMenu setEnabled"`.
- [ ] **Step 4: Run** `pnpm test && pnpm exec tsc --noEmit && cd src-tauri && cargo test`. Expected: PASS.
- [ ] **Step 5: Manual check (owner)** with `pnpm tauri dev` on the Mac:
  - every menu item;
  - ⌘, opens Preferences;
  - ⌘Z/⇧⌘Z in a cell edit and outside it;
  - ⌘W closes the tab;
  - Ctrl+Tab switches tabs.
  - Windows is checked from the CI build.
- [ ] **Step 6: Commit** with the message `feat(ui): native menus with Settings…, Undo/Redo and the usual shortcuts`.

---

## Execution notes

- **Order:** 1 → 2 → 3 → 4 → 5. Task 4 doesn't depend on 1–3 and could go first.
- **Delegation:** Task 1 is the risky core and stays with the controller. Task 4 (moving UI sections) and the pure `menuSpec` part of Task 5 suit Droid.
