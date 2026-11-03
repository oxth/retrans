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
    <div role="dialog" aria-label="New project" className="fixed inset-0 flex items-center justify-center bg-black/30">
      <div className="w-[32rem] rounded-xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold">New project</h2>
        <p className="text-xs text-gray-500">Step {idx + 1} of {STEPS.length}</p>
        <div className="mt-4">
          {step === "name" && (
            <label className="block text-sm">
              Project name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
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
                <p className="break-all font-mono text-xs text-gray-600">{folder}</p>
              ) : (
                <p className="text-xs text-gray-500">Choose a folder for the project.</p>
              )}
              <button onClick={choose} className="mt-2 rounded-md border border-gray-300 px-3 py-1.5 hover:bg-gray-50">
                Choose…
              </button>
            </div>
          )}
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
        <div className="mt-6 flex justify-between">
          <button onClick={onCancel} className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
            Cancel
          </button>
          <div className="flex gap-2">
            {idx > 0 && (
              <button onClick={() => setStep(STEPS[idx - 1])} className="rounded-md px-3 py-1.5 text-sm hover:bg-gray-100">
                Back
              </button>
            )}
            {step !== "location" ? (
              <button
                onClick={() => setStep(STEPS[idx + 1])}
                disabled={!canNext}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                Next
              </button>
            ) : (
              <button
                onClick={create}
                disabled={!folder || busy}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                Create
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
