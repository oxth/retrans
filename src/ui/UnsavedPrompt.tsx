import { btnGhost, btnPrimary, Dialog } from "./Dialog";
import { useApp } from "./store";

export function UnsavedPrompt() {
  const prompt = useApp((s) => s.closePrompt);
  const answer = useApp((s) => s.answerClosePrompt);
  if (!prompt) return null;
  return (
    <Dialog title="Unsaved changes" onClose={() => void answer("cancel")}>
      <p className="text-sm">
        You have unsaved changes. Save them before {prompt.then === "proceed" ? "updating" : "closing"}?
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button className={btnGhost} onClick={() => void answer("cancel")}>Cancel</button>
        <button className={btnGhost} onClick={() => void answer("discard")}>Discard</button>
        <button className={btnPrimary} onClick={() => void answer("save")}>Save</button>
      </div>
    </Dialog>
  );
}
