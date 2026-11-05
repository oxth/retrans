import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { StartScreen } from "./ui/StartScreen";
import { AppShell } from "./ui/AppShell";
import { startAutosave, startUnsavedSync, useApp } from "./ui/store";
import { useMt } from "./ui/mt-store";
import { UpdateBanner } from "./ui/UpdateBanner";
import { TabBar } from "./ui/TabBar";
import { launch, startTabPersistence } from "./ui/restore";
import { UnsavedPrompt } from "./ui/UnsavedPrompt";
import { PreferencesPage } from "./ui/PreferencesPage";

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
  useEffect(() => {
    void useMt.getState().init();
    // Reopen last session's tabs (or not, per Settings → Startup), then keep the saved list current.
    const stop = startTabPersistence();
    void launch().catch((e) => console.warn("reopening tabs failed", e));
    return stop;
  }, []);
  const session = useApp((s) => s.session);
  const activeId = useApp((s) => s.activeId);
  const hasTabs = useApp((s) => s.tabs.length > 0);
  const prefsOpen = useApp((s) => s.prefsOpen);
  // One window-high column: the update banner and tab bar take their rows and the page fills the rest.
  return (
    <div className="flex h-screen flex-col">
      <UpdateBanner />
      {hasTabs && <TabBar />}
      {session ? (
        <>
          {/* Keyed by tab: dialogs and the cell being edited don't follow you to another tab. */}
          <AppShell key={activeId ?? "untabbed"} />
        </>
      ) : (
        <StartScreen />
      )}
      {prefsOpen && <PreferencesPage />}
      {/* Here, not in a tab: quitting from the start screen can still list other tabs. */}
      <UnsavedPrompt />
    </div>
  );
}
