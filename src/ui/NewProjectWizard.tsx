import { btnPrimary, btnSecondary, btnGhost, Dialog, inputCls } from "./Dialog";
import { useEffect, useState } from "react";
import { documentDir } from "@tauri-apps/api/path";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { detectProject } from "../formats/detect";
import { destHasFiles } from "../package/extract";
import { createWorkspace } from "../workspace/store";
import { LocalePicker } from "./LocalePicker";
import { useApp } from "./store";

type Step = "name" | "languages" | "location";
const STEPS: Step[] = ["name", "languages", "location"];

/** The name as a folder name: characters invalid in folder names removed, then trimmed. */
const folderName = (name: string) => name.replace(/[/\\:*?"<>|]/g, "").trim();

export function NewProjectWizard({ onCancel }: { onCancel(): void }) {
  const { fs, openProject } = useApp();
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [base, setBase] = useState<string[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [docs, setDocs] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    documentDir().then((d) => setDocs(d.replace(/\\/g, "/").replace(/\/$/, "")), () => setDocs(null));
  }, []);

  const dirName = folderName(name);
  const folder = chosen ?? (docs !== null && dirName ? `${docs}/Retrans/${dirName}` : null);
  const idx = STEPS.indexOf(step);
  const canNext = step === "name" ? dirName !== "" : step !== "languages" || base.length === 1;

  const choose = async () => {
    try {
      const p = await pickFolder({ directory: true });
      if (typeof p === "string") setChosen(p.replace(/\\/g, "/"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const create = async () => {
    if (!folder) return;
    setBusy(true);
    setError(null);
    try {
      if (await destHasFiles(fs, folder)) {
        setError("Choose an empty folder.");
        setBusy(false);
        return;
      }
      await createWorkspace(fs, folder, { name: name.trim(), baseLocale: base[0], locales: targets });
      const d = await detectProject(fs, folder);
      if (!d) throw new Error("Could not open the new project.");
      await openProject(folder, d, { baseLocale: d.baseLocale ?? base[0], localesPath: d.localesPath });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog title="New project" onClose={onCancel}>
      <div>
        <div className="-mt-2 flex items-center gap-3">
          <div className="flex flex-1 gap-1" aria-hidden="true">
            {STEPS.map((s, i) => (
              <span key={s} className={`h-1 flex-1 rounded-full ${i <= idx ? "bg-brand" : "bg-sunken"}`} />
            ))}
          </div>
          <p className="text-xs text-muted">Step {idx + 1} of {STEPS.length}</p>
        </div>
        <div className="mt-4">
          {step === "name" && (
            <label className="block text-sm">
              Project name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={`${inputCls} mt-1`}
              />
            </label>
          )}
          {step === "languages" && (
            <div className="space-y-4">
              <div>
                <p className="mb-1 text-sm font-medium">Base language</p>
                <LocalePicker label="Search base language" selected={base} onChange={(b) => { setBase(b); setTargets((t) => t.filter((x) => !b.includes(x))); }} />
              </div>
              <div>
                <p className="mb-1 text-sm font-medium">Target languages</p>
                <LocalePicker label="Search target languages" multiple selected={targets} exclude={base} onChange={setTargets} />
              </div>
            </div>
          )}
          {step === "location" && (
            <div className="text-sm">
              <p className="mb-1 font-medium">Location</p>
              {folder ? (
                <p className="break-all font-mono text-xs text-muted">{folder}</p>
              ) : (
                <p className="text-xs text-muted">Choose a folder for the project.</p>
              )}
              <button onClick={choose} className={`${btnSecondary} mt-2`}>
                Choose…
              </button>
            </div>
          )}
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-6 flex justify-between">
          <button onClick={onCancel} className={btnGhost}>
            Cancel
          </button>
          <div className="flex gap-2">
            {idx > 0 && (
              <button onClick={() => setStep(STEPS[idx - 1])} className={btnGhost}>
                Back
              </button>
            )}
            {step !== "location" ? (
              <button
                onClick={() => setStep(STEPS[idx + 1])}
                disabled={!canNext}
                className={btnPrimary}
              >
                Next
              </button>
            ) : (
              <button
                onClick={create}
                disabled={!folder || busy}
                className={btnPrimary}
              >
                Create
              </button>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
