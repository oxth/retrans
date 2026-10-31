import { useState } from "react";
import { localesSnippet } from "../formats/next-i18next";
import type { ProjectSession } from "../core/session";
import { btnGhost, btnPrimary, Dialog, inputCls } from "./Dialog";
import { LocalePicker } from "./LocalePicker";
import { localeLabel } from "./locales";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function LanguagesPage({ session, stats }: { session: ProjectSession; stats: Map<string, { done: number; total: number }> }) {
  const { locales, baseLocale, format } = session.data;
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [ns, setNs] = useState("");
  const [error, setError] = useState<string | null>(null);

  const showSnippet = () => {
    setCopied(false);
    setSnippet(format === "next-i18next" ? localesSnippet(session.data.locales) : null);
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
    <div className="mx-auto w-full max-w-2xl overflow-auto p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Languages</h1>
        <button className={btnPrimary} onClick={() => setAdding(true)}>Add language</button>
      </div>
      <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
        {locales.map((l) => {
          const s = stats.get(l) ?? { done: 0, total: 0 };
          const pct = s.total ? Math.round((s.done / s.total) * 100) : 100;
          return (
            <li key={l} className="flex items-center gap-3 px-3 py-2 text-sm">
              <div className="w-48">
                <span className="font-mono font-semibold">{l}</span>{" "}
                <span className="text-gray-500">{localeLabel(l)}{l === baseLocale ? " (base)" : ""}</span>
              </div>
              <div className="h-1.5 flex-1 rounded bg-gray-200">
                <div className={`h-full rounded ${pct < 80 ? "bg-amber-500" : "bg-green-500"}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="w-24 text-right text-xs text-gray-500">{s.done} / {s.total} ({pct}%)</div>
              <button
                aria-label={`Remove ${l}`}
                disabled={l === baseLocale}
                title={l === baseLocale ? "The base language can't be removed" : undefined}
                className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => setRemoving(l)}
              >
                Remove
              </button>
            </li>
          );
        })}
      </ul>

      {snippet && (
        <div className="mt-4 rounded-md border border-indigo-200 bg-indigo-50 p-3 text-sm">
          <div className="mb-2 font-medium">Update your next-i18next config:</div>
          <pre data-testid="config-snippet" className="overflow-auto rounded bg-white p-2 font-mono text-xs">{snippet}</pre>
          <div className="mt-2 flex gap-2">
            <button
              className={btnGhost + " border border-gray-300"}
              onClick={() => {
                navigator.clipboard.writeText(snippet).then(
                  () => setCopied(true),
                  (e) => setError(`Could not copy: ${msg(e)}`),
                );
              }}
            >
              Copy
            </button>
            {copied && <span className="self-center text-xs text-green-700">Copied</span>}
            <button className={btnGhost} onClick={() => setSnippet(null)}>Dismiss</button>
          </div>
        </div>
      )}

      {format === "next-i18next" && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold">Namespaces</h2>
          <div className="mb-2 text-xs text-gray-500">{session.data.namespaces.join(", ")}</div>
          <div className="flex gap-2">
            <input aria-label="New namespace" className={inputCls} value={ns} onChange={(e) => { setNs(e.target.value); setError(null); }} />
            <button className={btnGhost + " border border-gray-300 whitespace-nowrap"} disabled={!ns.trim()} onClick={addNs}>Add namespace</button>
          </div>
        </div>
      )}
      {error && <div role="alert" className="mt-3 text-xs text-red-600">{error}</div>}

      {adding && <AddLanguageDialog session={session} onClose={() => setAdding(false)} onAdded={showSnippet} />}
      {removing && (
        <Dialog title="Remove language" onClose={() => setRemoving(null)}>
          <p className="text-sm">
            Remove <span className="font-mono font-semibold">{removing}</span>? Its translation files will be deleted when you save.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setRemoving(null)}>Cancel</button>
            <button
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white"
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
      {error && <div role="alert" className="mt-2 text-xs text-red-600">{error}</div>}
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
