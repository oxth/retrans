import { openUrl } from "@tauri-apps/plugin-opener";
import { runFind, runRedo, runUndo } from "./edit-commands";
import { useApp } from "./store";

const app = () => useApp.getState();

/** The tab after (or before) the active one, wrapping around. */
function stepTab(delta: 1 | -1): void {
  const { tabs, activeId, switchTab } = app();
  if (!tabs.length) return;
  const i = tabs.findIndex((t) => t.id === activeId);
  switchTab(tabs[(i + delta + tabs.length) % tabs.length].id);
}

/** What each menu item does (ids from platform/menu.ts). */
export const MENU_ACTIONS: Record<string, () => void> = {
  settings: () => app().openPrefs(),
  "check-updates": () => app().openPrefs(), // the Updates section has Check for updates
  "new-project": () => {
    app().showStart();
    app().requestUi("new-project");
  },
  "open-project": () => {
    app().showStart();
    app().requestUi("open-project");
  },
  "close-tab": () => {
    const id = app().activeId;
    if (id) void app().closeTab(id);
  },
  save: () => void app().save(),
  "import-figma": () => app().requestUi("import-figma"),
  export: () => app().requestUi("export"),
  undo: runUndo,
  redo: runRedo,
  find: runFind,
  "view-list": () => app().requestUi("view-list"),
  "view-table": () => app().requestUi("view-table"),
  "next-tab": () => stepTab(1),
  "prev-tab": () => stepTab(-1),
  github: () => void openUrl("https://github.com/oxth/retrans").catch(() => {}),
};
