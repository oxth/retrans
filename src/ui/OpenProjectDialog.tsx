import { btnPrimary, btnGhost, Dialog, inputCls } from "./Dialog";
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
    <Dialog title="Open project" onClose={onCancel}>
      <div>
        <p className="-mt-2 break-all font-mono text-xs text-muted">{root}</p>
        <dl className="mt-4 grid grid-cols-[7rem_1fr] gap-y-1 text-sm">
          <dt className="text-muted">Format</dt>
          <dd>{detected.format === "paraglide" ? "Paraglide" : "next-i18next"}</dd>
          <dt className="text-muted">Languages</dt>
          <dd>{detected.locales.join(", ") || "none"}</dd>
          <dt className="text-muted">{detected.workspace ? "Groups" : "Namespaces"}</dt>
          <dd>{detected.namespaces.filter(Boolean).join(", ") || "none"}</dd>
          <dt className="text-muted">Keys</dt>
          <dd>{detected.keyCount} keys</dd>
        </dl>
        {detected.baseLocale === null && (
          <label className="mt-4 block text-sm">
            <span className="text-fg-2">Base language</span>
            <select
              value={base}
              onChange={(e) => setBase(e.target.value)}
              className={`${inputCls} mt-1`}
            >
              <option value="">Choose…</option>
              {detected.locales.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </label>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onCancel} className={btnGhost}>
            Cancel
          </button>
          <button
            onClick={open}
            disabled={!base || busy}
            className={btnPrimary}
          >
            Open
          </button>
        </div>
      </div>
    </Dialog>
  );
}
