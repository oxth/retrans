import { useState } from "react";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import type { Format } from "../core/model";
import { createProject } from "../formats/scaffold";
import { LocalePicker } from "./LocalePicker";
import { useApp } from "./store";

type Step = "format" | "languages" | "namespace" | "location";

export function NewProjectWizard({ onCancel }: { onCancel(): void }) {
  const { fs, openProject } = useApp();
  const [format, setFormat] = useState<Format>("next-i18next");
  const [step, setStep] = useState<Step>("format");
  const [base, setBase] = useState<string[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [namespace, setNamespace] = useState("common");
  const [folder, setFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const steps: Step[] = format === "next-i18next"
    ? ["format", "languages", "namespace", "location"]
    : ["format", "languages", "location"];
  const idx = steps.indexOf(step);
  const canNext = step !== "languages" || base.length === 1;

  const choose = async () => {
    try {
      const p = await pickFolder({ directory: true });
      if (typeof p === "string") setFolder(p.replace(/\\/g, "/"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const create = async () => {
    if (!folder) return;
    setBusy(true);
    setError(null);
    try {
      const d = await createProject(fs, {
        format, root: folder, baseLocale: base[0], locales: targets,
        namespace: format === "next-i18next" ? namespace : undefined,
      });
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
        <p className="text-xs text-gray-500">Step {idx + 1} of {steps.length}</p>
        <div className="mt-4">
          {step === "format" && (
            <fieldset className="space-y-2 text-sm">
              <legend className="sr-only">Format</legend>
              {(["next-i18next", "paraglide"] as const).map((f) => (
                <label key={f} className="flex items-center gap-2">
                  <input type="radio" name="format" checked={format === f} onChange={() => setFormat(f)} />
                  {f === "paraglide" ? "Paraglide" : "next-i18next"}
                </label>
              ))}
            </fieldset>
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
          {step === "namespace" && (
            <label className="block text-sm">
              Namespace
              <input
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
              />
            </label>
          )}
          {step === "location" && (
            <div className="text-sm">
              <button onClick={choose} className="rounded-md border border-gray-300 px-3 py-1.5 hover:bg-gray-50">
                Choose folder…
              </button>
              {folder && <p className="mt-2 break-all font-mono text-xs text-gray-600">{folder}</p>}
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
              <button onClick={() => setStep(steps[idx - 1])} className="rounded-md px-3 py-1.5 text-sm hover:bg-gray-100">
                Back
              </button>
            )}
            {step !== "location" ? (
              <button
                onClick={() => setStep(steps[idx + 1])}
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
                Create project
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
