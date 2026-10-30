import { StartScreen } from "./ui/StartScreen";
import { useApp, useSessionVersion } from "./ui/store";

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

// Task 13 replaces this with the real translation screen.
function ProjectPlaceholder() {
  useSessionVersion();
  const { session, closeProject } = useApp();
  if (!session) return null;
  const name = session.data.root.split("/").filter(Boolean).pop();
  return (
    <main className="p-8">
      <h1 className="text-xl font-semibold">{name}</h1>
      <p className="mt-2 text-gray-500">Translations coming in the next task</p>
      <button onClick={() => void closeProject()} className="mt-4 rounded-md border border-gray-300 px-3 py-1.5 text-sm">Close project</button>
      <RecoveryPrompt />
    </main>
  );
}

export default function App() {
  const session = useApp((s) => s.session);
  return session ? <ProjectPlaceholder /> : <StartScreen />;
}
