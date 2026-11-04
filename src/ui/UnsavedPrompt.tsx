import { btnGhost, btnPrimary, Dialog } from "./Dialog";
import { LEGACY_TAB, useApp } from "./store";

export function UnsavedPrompt() {
  const prompt = useApp((s) => s.closePrompt);
  const answer = useApp((s) => s.answerClosePrompt);
  const tabs = useApp((s) => s.tabs);
  const session = useApp((s) => s.session);
  if (!prompt) return null;
  const ids = prompt.then === "project" ? [] : prompt.tabs;
  const doing = prompt.then === "proceed" ? "updating" : prompt.then === "quit" ? "quitting" : "closing";

  if (ids.length >= 2) {
    const names = ids.map((id) => (id === LEGACY_TAB ? (session?.data.root.split("/").pop() ?? "") : tabs.find((t) => t.id === id)?.name ?? ""));
    return (
      <Dialog title={`Save changes before ${doing}?`} onClose={() => void answer("cancel")}>
        <p className="text-sm">These projects have unsaved changes:</p>
        <ul className="mt-2 list-disc pl-5 text-sm">
          {names.map((n, i) => (
            <li key={ids[i]}>{n}</li>
          ))}
        </ul>
        <div className="mt-5 flex justify-end gap-2">
          <button className={btnGhost} onClick={() => void answer("cancel")}>Cancel</button>
          <button className={btnGhost} onClick={() => void answer("discard")}>Don't save</button>
          <button className={btnPrimary} onClick={() => void answer("save")}>Save all</button>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog title="Unsaved changes" onClose={() => void answer("cancel")}>
      <p className="text-sm">You have unsaved changes. Save them before {doing}?</p>
      <div className="mt-5 flex justify-end gap-2">
        <button className={btnGhost} onClick={() => void answer("cancel")}>Cancel</button>
        <button className={btnGhost} onClick={() => void answer("discard")}>Discard</button>
        <button className={btnPrimary} onClick={() => void answer("save")}>Save</button>
      </div>
    </Dialog>
  );
}
