import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { StartScreen } from "./ui/StartScreen";
import { AppShell } from "./ui/AppShell";
import { startAutosave, startUnsavedSync, useApp } from "./ui/store";
import { useMt } from "./ui/mt-store";
import { UpdateAvailableToast } from "./ui/UpdateAvailableToast";
import { TabBar } from "./ui/TabBar";
import { installMenu } from "./platform/menu";
import { MENU_ACTIONS } from "./ui/menu-actions";
import { launch, startTabPersistence } from "./ui/restore";
import { UnsavedPrompt } from "./ui/UnsavedPrompt";
import { SettingsDialog } from "./ui/SettingsDialog";
import { startLogging } from "./ui/bug-report";
import { UpdateToast, useAnnounceUpdate } from "./ui/UpdateToast";
import { WhatsNew } from "./ui/WhatsNew";

/**
 * Routes every way of quitting through one prompt listing the tabs with unsaved changes: the
 * window's close button (intercepted here) and Cmd+Q / the app menu's Quit (Rust holds the exit
 * back while `set_unsaved` says so, and emits "quit-requested").
 */
function useQuitGuard() {
  useEffect(() => {
    const stopSync = startUnsavedSync();
    const stopAutosave = startAutosave();
    const unlisteners: Array<() => void> = [];
    let gone = false;
    const keep = (u: () => void) => (gone ? u() : unlisteners.push(u));
    try {
      getCurrentWindow()
        .onCloseRequested((e) => {
          if (useApp.getState().dirtyTabs().length === 0) return;
          e.preventDefault();
          void useApp.getState().requestClose("window");
        })
        .then(keep, () => {});
      listen("quit-requested", () => void useApp.getState().requestClose("window")).then(keep, () => {});
    } catch {
      /* not running inside Tauri */
    }
    return () => {
      gone = true;
      stopSync();
      stopAutosave();
      for (const u of unlisteners) u();
    };
  }, []);
}

export default function App() {
  useQuitGuard();
  useAnnounceUpdate();
  useEffect(() => startLogging(), []);
  useEffect(() => {
    void useMt.getState().init();
    // The native menu (File, Edit, View…; Settings… ⌘, / Ctrl+,), its items enabled per screen.
    let stopMenu = () => {};
    const ctxOf = () => {
      const s = useApp.getState().session;
      return { hasProject: !!s, canUndo: !!s?.canUndo, canRedo: !!s?.canRedo };
    };
    installMenu((id) => MENU_ACTIONS[id]?.(), ctxOf()).then(
      (update) => {
        let last = JSON.stringify(ctxOf());
        stopMenu = useApp.subscribe(() => {
          const next = ctxOf();
          if (JSON.stringify(next) === last) return;
          last = JSON.stringify(next);
          void update(next).catch(() => {});
        });
      },
      () => {}, // not running inside Tauri (tests, browser)
    );
    // Reopen last session's tabs (or not, per Settings → Startup), then keep the saved list current.
    const stop = startTabPersistence();
    void launch().catch((e) => console.warn("reopening tabs failed", e));
    return () => {
      stop();
      stopMenu();
    };
  }, []);
  const session = useApp((s) => s.session);
  const activeId = useApp((s) => s.activeId);
  const prefsOpen = useApp((s) => s.prefsOpen);
  const whatsNewOpen = useApp((s) => s.whatsNewOpen);
  // One window-high column: the tab bar takes its row and the page fills the rest.
  return (
    <div className="flex h-screen flex-col">
      {/* Always shown: it has Settings, and on macOS it is the title bar (the traffic lights sit on it). */}
      <TabBar />
      {/* Update news, bottom-right over the page (nothing moves); both at once stack. Fixed, so its place here doesn't matter. */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-30 flex flex-col items-end gap-2">
        <UpdateToast />
        <UpdateAvailableToast />
      </div>
      {session ? (
        <>
          {/* Keyed by tab: dialogs and the cell being edited don't follow you to another tab. */}
          <AppShell key={activeId ?? "untabbed"} />
        </>
      ) : (
        <StartScreen />
      )}
      {prefsOpen && <SettingsDialog />}
      {whatsNewOpen && <WhatsNew />}
      {/* Here, not in a tab: quitting from the start screen can still list other tabs. */}
      <UnsavedPrompt />
    </div>
  );
}
