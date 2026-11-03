import { useState } from "react";
import type { DetectResult } from "../formats/adapter";
import { useApp } from "./store";

interface Props {
  root: string;
  detected: DetectResult;
  /** Base language remembered in .retrans/state.json when detection can't tell. */
  savedBase?: string | null;
  onCancel(): void;
}

export function OpenProjectDialog({ root, detected, savedBase, onCancel }: Props) {
  const openProject = useApp((s) => s.openProject);
  const [base, setBase] = useState(detected.baseLocale ?? savedBase ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      await openProject(root, detected, { baseLocale: base, localesPath: detected.localesPath });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div role="dialog" aria-label="Open project" className="fixed inset-0 flex items-center justify-center bg-black/30">
      <div className="w-[28rem] rounded-xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold">Open project</h2>
        <p className="mt-1 break-all font-mono text-xs text-gray-500">{root}</p>
        <dl className="mt-4 grid grid-cols-[7rem_1fr] gap-y-1 text-sm">
          <dt className="text-gray-500">Format</dt>
          <dd>{detected.format === "paraglide" ? "Paraglide" : "next-i18next"}</dd>
          <dt className="text-gray-500">Languages</dt>
          <dd>{detected.locales.join(", ") || "none"}</dd>
          <dt className="text-gray-500">Namespaces</dt>
          <dd>{detected.namespaces.filter(Boolean).join(", ") || "none"}</dd>
          <dt className="text-gray-500">Keys</dt>
          <dd>{detected.keyCount} keys</dd>
        </dl>
        {detected.baseLocale === null && (
          <label className="mt-4 block text-sm">
            <span className="text-gray-700">Base language</span>
            <select
              value={base}
              onChange={(e) => setBase(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
            >
              <option value="">Choose…</option>
              {detected.locales.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </label>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
            Cancel
          </button>
          <button
            onClick={open}
            disabled={!base || busy}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            Open
          </button>
        </div>
      </div>
    </div>
  );
}
