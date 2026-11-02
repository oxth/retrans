import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { StartScreen } from "./ui/StartScreen";
import { AppShell } from "./ui/AppShell";
import { useApp } from "./ui/store";
import { useMt } from "./ui/mt-store";

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

/** Intercepts the window's close request while the open project has unsaved changes. */
function useCloseGuard() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let gone = false;
    try {
      getCurrentWindow()
        .onCloseRequested((e) => {
          const { session, requestClose } = useApp.getState();
          if (session?.isDirty()) {
            e.preventDefault();
            void requestClose("window");
          }
        })
        .then(
          (u) => (gone ? u() : (unlisten = u)),
          () => {},
        );
    } catch {
      /* not running inside Tauri */
    }
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);
}

export default function App() {
  useCloseGuard();
  useEffect(() => {
    void useMt.getState().init();
  }, []);
  const session = useApp((s) => s.session);
  return session ? (
    <>
      <AppShell />
      <RecoveryPrompt />
    </>
  ) : (
    <StartScreen />
  );
}
