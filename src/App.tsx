import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { StartScreen } from "./ui/StartScreen";
import { AppShell } from "./ui/AppShell";
import { startUnsavedSync, useApp } from "./ui/store";
import { useMt } from "./ui/mt-store";
import { UpdateBanner } from "./ui/UpdateBanner";
import { TabBar } from "./ui/TabBar";
import { UnsavedPrompt } from "./ui/UnsavedPrompt";

function RecoveryPrompt() {
  const { recovery, restoreRecovery, discardRecovery } = useApp();
  if (!recovery) return null;
  const when = new Date(recovery.journal.savedAt).toLocaleString();
  return (
    <div role="dialog" aria-label="Restore unsaved changes" className="fixed inset-0 flex items-center justify-center bg-black/30">
      <div className="w-96 rounded-xl bg-white p-6 shadow-xl">
        <p className="text-sm">Restore unsaved changes from {when}?</p>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={() => void discardRecovery()} className="rounded-md px-3 py-1.5 text-sm hover:bg-gray-100">Discard</button>
          <button onClick={restoreRecovery} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white">Restore</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Routes every way of quitting through one prompt listing the tabs with unsaved changes: the
 * window's close button (intercepted here) and Cmd+Q / the app menu's Quit (Rust holds the exit
 * back while `set_unsaved` says so, and emits "quit-requested").
 */
function useQuitGuard() {
  useEffect(() => {
    const stopSync = startUnsavedSync();
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
      for (const u of unlisteners) u();
    };
  }, []);
}

export default function App() {
  useQuitGuard();
  useEffect(() => {
    void useMt.getState().init();
  }, []);
  const session = useApp((s) => s.session);
  const activeId = useApp((s) => s.activeId);
  const hasTabs = useApp((s) => s.tabs.length > 0);
  // One window-high column: the update banner and tab bar take their rows and the page fills the rest.
  return (
    <div className="flex h-screen flex-col">
      <UpdateBanner />
      {hasTabs && <TabBar />}
      {session ? (
        <>
          {/* Keyed by tab: dialogs and the cell being edited don't follow you to another tab. */}
          <AppShell key={activeId ?? "untabbed"} />
          <RecoveryPrompt />
        </>
      ) : (
        <StartScreen />
      )}
      {/* Here, not in a tab: quitting from the start screen can still list other tabs. */}
      <UnsavedPrompt />
    </div>
  );
}
