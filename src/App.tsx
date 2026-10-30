import { StartScreen } from "./ui/StartScreen";
import { AppShell } from "./ui/AppShell";
import { useApp } from "./ui/store";

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

export default function App() {
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
