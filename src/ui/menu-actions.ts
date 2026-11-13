import { openUrl } from "@tauri-apps/plugin-opener";
import { reportBug, requestFeature, showLogFile } from "./bug-report";
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

/**
 * While a dialog (or Settings) is open, menu items do nothing: their shortcuts would otherwise
 * act on the project behind it (the native menu takes the key before the page sees it).
 */
const guarded = (actions: Record<string, () => void>): Record<string, () => void> =>
  Object.fromEntries(
    Object.entries(actions).map(([id, fn]) => [id, () => (document.querySelector('[role="dialog"]') ? undefined : fn())]),
  );

/** What each menu item does (ids from platform/menu.ts). */
export const MENU_ACTIONS: Record<string, () => void> = guarded({
  settings: () => app().openPrefs(),
  "check-updates": () => app().openPrefs("about"), // About has Check for updates
  "whats-new": () => app().openWhatsNew(),
  "report-bug": () => void reportBug().catch((e) => console.warn("Report a bug failed", e)),
  "request-feature": () => void requestFeature().catch((e) => console.warn("Request a feature failed", e)),
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
});

// Not guarded: it doesn't touch the project, so it works with Settings or a dialog open too.
MENU_ACTIONS["show-log"] = () => void showLogFile().catch((e) => console.warn("Showing the log failed", e));
