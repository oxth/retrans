# Retrans — Preferences page, app menus, shortcuts, undo/redo — Design

Date: 2026-11-05
Status: Draft for owner review
Extends: `docs/superpowers/specs/2026-11-04-retrans-v0.2-additions-design.md` (ships in v0.2.0).

**Owner's request (2026-11-05):** "split the setting page to a dedicate page and have a context menu in mac call preference but for windows i'm not sure how it call and could you bind the shortcut key like to preference, undo, redo something like this".

## Intent
- Settings that belong to the app, not to one project, get their own page that opens from anywhere, including the start screen.
- Retrans gets real menus with the usual shortcuts, so it feels like a native app.
- Undo and redo work for edits.

## 1. Preferences page (app-wide) vs project Settings
- **Preferences** is a new dedicated page, shown over whatever is open (start screen or a project) with a Back/close control. It holds what is the same for every project:
  - default view;
  - Startup (reopen projects or show the start screen);
  - Updates;
  - Machine translation (model, download, licence; and the AI providers in Part D).
- **Project Settings** (the existing sidebar page) keeps only what belongs to the open project:
  - locales path;
  - Figma folder and modes;
  - later, the per-project provider override and the project's custom instructions (Part D).
- **Naming** *(my call)*:
  - On macOS the menu item is **Settings…** (⌘,). Apple renamed "Preferences…" to "Settings…" in macOS 13, and current apps use "Settings…". The page itself is titled **Preferences**, so it doesn't clash with the project's Settings page.
  - On Windows the common name is **Settings** (VS Code, Office use "Options"); see §2.

## 2. Menus
Built with Tauri's menu API (`@tauri-apps/api/menu`). macOS uses its standard app menu; Windows shows a menu bar at the top of the window.

| Menu | Items (macOS shortcut / Windows shortcut) |
|---|---|
| **Retrans** (macOS only) | About Retrans · **Settings… ⌘,** · Check for Updates… · Hide · Quit ⌘Q |
| **File** | New Project… ⌘N / Ctrl+N · Open Project… ⌘O / Ctrl+O · Close Tab ⌘W / Ctrl+W · Save ⌘S / Ctrl+S · Import Figma Files… · Export… ⌘E / Ctrl+E · *(Windows only:)* **Settings… Ctrl+,** · Exit |
| **Edit** | **Undo ⌘Z / Ctrl+Z** · **Redo ⇧⌘Z / Ctrl+Y (and Ctrl+Shift+Z)** · Cut · Copy · Paste · Select All · Find ⌘F / Ctrl+F (focuses Search) |
| **View** | List view · Table view · Next Tab ⌃Tab · Previous Tab ⌃⇧Tab |
| **Window** (macOS) | Minimize · Zoom |
| **Help** | Retrans on GitHub |

- **Context:** items that need an open project (Save, Close Tab, Export, Import Figma Files, Undo, Redo) are disabled on the start screen.
- **Text fields:** while typing in a text field, Cut, Copy, Paste and Select All act on the field (native items). Undo and redo act on the field's own text first; see §3.

## 3. Undo / redo
- **Scope:** per tab, one history per open project. Closing the tab clears it. Up to 200 steps *(my call)*.
- **What is undoable** (one step each):
  - a cell edit, or clearing a cell;
  - marking reviewed;
  - add, rename or delete a key;
  - add a language;
  - resolve a conflict;
  - Set code key / Link to code key;
  - a whole **Translate missing** run (one step for the run);
  - "Take all theirs" / "Keep all mine".
- **What is not undoable:** changes that came from outside (sync from TypeScript or Figma, files changed on disk), and Save/Export. Undo never rewrites a file directly. It changes the workspace back, and auto-save then writes the result like any edit.
- **When a sync changed the same cell after an edit:** undo of that edit is skipped, with a short note ("Changed since — not undone"), so undo never overwrites what came in from code or Figma.
- **In a text field:** ⌘Z / Ctrl+Z first undoes typing inside the field, as usual. Once the field has nothing left to undo, or isn't focused, it undoes the last app step.
- **Implementation sketch** (left to the builder to refine): the session already groups changes in `batch()` and emits once per change. Each top-level change records the cells and meta it touched, before and after, as one history step. Undo applies the "before" values through the same session methods.

## Anti-goals
- Undo that silently reverts a change made in code or in Figma.
- Shortcuts that steal ⌘Z or ⌘C from a text field.
- Two different "Settings" pages with the same name.

## Quality bar
- Every menu item works and has the shortcut listed, on both platforms (manual check on the Mac; CI builds Windows).
- Undo/redo tests:
  - each undoable action;
  - redo after undo;
  - the history clears on a new edit after undo;
  - per-tab histories;
  - an undo skipped because a sync changed the cell;
  - a Translate-missing run undone as one step.
- Preferences opens from the start screen, from a project, and with ⌘, / Ctrl+,.

## Questions for the owner
1. **Windows:** a menu bar in the window with **File → Settings… (Ctrl+,)** (recommended; it's what VS Code does). The alternative is no menu bar on Windows, with just a gear button and Ctrl+,.
2. **Undo scope:** is the list in §3 what you expect? In particular, should undo also cover **Save**? My call is no: files always follow the workspace through auto-save.
