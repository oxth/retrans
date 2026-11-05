import { useState } from "react";
import { localesSnippet } from "../formats/next-i18next";
import type { ProjectSession } from "../core/session";
import { btnGhost, btnPrimary, Dialog, inputCls, btnSecondary, btnDanger } from "./Dialog";
import { LocalePicker } from "./LocalePicker";
import { localeLabel } from "./locales";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function LanguagesPage({ session, stats }: { session: ProjectSession; stats: Map<string, { done: number; total: number }> }) {
  const { locales, baseLocale, format } = session.data;
  const isWs = !!session.workspace;
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [ns, setNs] = useState("");
  const [error, setError] = useState<string | null>(null);

  const showSnippet = () => {
    setCopied(false);
    // A workspace has no next-i18next config to update.
    setSnippet(format === "next-i18next" && !isWs ? localesSnippet(session.data.locales) : null);
  };
  const addNs = () => {
    try {
      session.addNamespace(ns.trim());
      setNs("");
      setError(null);
    } catch (e) {
      setError(msg(e));
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-muted">The languages in this project and how complete each one is.</p>
        <button className={btnPrimary} onClick={() => setAdding(true)}>Add language</button>
      </div>
      <ul className="divide-y divide-line rounded-md border border-line">
        {locales.map((l) => {
          const s = stats.get(l) ?? { done: 0, total: 0 };
          const pct = s.total ? Math.round((s.done / s.total) * 100) : 100;
          return (
            <li key={l} className="flex items-center gap-3 px-3 py-2 text-sm">
              <div className="w-48">
                <span className="font-mono font-semibold">{l}</span>{" "}
                <span className="text-muted">{localeLabel(l)}{l === baseLocale ? " (base)" : ""}</span>
              </div>
              <div className="h-1.5 flex-1 rounded bg-sunken">
                <div className={`h-full rounded ${pct < 80 ? "bg-warn-solid" : "bg-ok-solid"}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="w-24 text-right text-xs text-muted">{s.done} / {s.total} ({pct}%)</div>
              <button
                aria-label={`Remove ${l}`}
                disabled={l === baseLocale}
                title={l === baseLocale ? "The base language can't be removed" : undefined}
                className="rounded px-2 py-1 text-xs text-danger hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => setRemoving(l)}
              >
                Remove
              </button>
            </li>
          );
        })}
      </ul>

      {snippet && (
        <div className="mt-4 rounded-md border border-brand-line bg-brand-soft p-3 text-sm">
          <div className="mb-2 font-medium">Update your next-i18next config:</div>
          <pre data-testid="config-snippet" className="overflow-auto rounded bg-surface p-2 font-mono text-xs">{snippet}</pre>
          <div className="mt-2 flex gap-2">
            <button
              className={btnSecondary}
              onClick={() => {
                navigator.clipboard.writeText(snippet).then(
                  () => setCopied(true),
                  (e) => setError(`Could not copy: ${msg(e)}`),
                );
              }}
            >
              Copy
            </button>
            {copied && <span className="self-center text-xs text-ok">Copied</span>}
            <button className={btnGhost} onClick={() => setSnippet(null)}>Dismiss</button>
          </div>
        </div>
      )}

      {format === "next-i18next" && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold">{isWs ? "Groups" : "Namespaces"}</h2>
          <div className="mb-2 text-xs text-muted">{session.data.namespaces.join(", ")}</div>
          <div className="flex gap-2">
            <input aria-label={isWs ? "New group" : "New namespace"} className={inputCls} value={ns} onChange={(e) => { setNs(e.target.value); setError(null); }} />
            <button className={btnSecondary + " whitespace-nowrap"} disabled={!ns.trim()} onClick={addNs}>{isWs ? "Add group" : "Add namespace"}</button>
          </div>
        </div>
      )}
      {error && <div role="alert" className="mt-3 text-xs text-danger">{error}</div>}

      {adding && <AddLanguageDialog session={session} onClose={() => setAdding(false)} onAdded={showSnippet} />}
      {removing && (
        <Dialog title="Remove language" onClose={() => setRemoving(null)}>
          <p className="text-sm">
            Remove <span className="font-mono font-semibold">{removing}</span>? Its translation files will be deleted when you save.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setRemoving(null)}>Cancel</button>
            <button
              className={btnDanger}
              onClick={() => {
                try {
                  session.removeLanguage(removing);
                  showSnippet();
                } catch (e) {
                  setError(msg(e));
                }
                setRemoving(null);
              }}
            >
              Remove
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function AddLanguageDialog({ session, onClose, onAdded }: { session: ProjectSession; onClose: () => void; onAdded: () => void }) {
  const [sel, setSel] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title="Add language" onClose={onClose}>
      <LocalePicker label="Language" selected={sel} exclude={session.data.locales} onChange={setSel} />
      {error && <div role="alert" className="mt-2 text-xs text-danger">{error}</div>}
      <div className="mt-4 flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose}>Cancel</button>
        <button
          className={btnPrimary}
          disabled={!sel.length}
          onClick={() => {
            try {
              session.addLanguage(sel[0]);
              onAdded();
              onClose();
            } catch (e) {
              setError(msg(e));
            }
          }}
        >
          Add
        </button>
      </div>
    </Dialog>
  );
}
