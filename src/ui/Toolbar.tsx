import { useState } from "react";
import type { RowFilter } from "../core/rows";

export type FilterState = Omit<RowFilter, "locales">;

export interface ToolbarProps {
  filter: FilterState;
  onFilter: (patch: Partial<FilterState>) => void;
  missingCount: number;
  namespaces: string[];
  showNamespaces: boolean;
  targetLocales: string[];
  hidden: Set<string>;
  onToggleLocale: (l: string) => void;
  viewMode: "list" | "table";
  onViewMode: (m: "list" | "table") => void;
  onAddKey?: () => void;
  onTranslateMissing?: () => void;
}

const chip = (on: boolean) =>
  `rounded-full border px-3 py-1 text-xs whitespace-nowrap ${on ? "border-amber-500 bg-amber-100 text-amber-800" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`;
const field = "rounded-md border border-gray-300 bg-white px-2 py-1 text-sm";

export function Toolbar(p: ToolbarProps) {
  const [menu, setMenu] = useState(false);
  const { filter: f } = p;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 p-3">
      <input
        type="search"
        aria-label="Search"
        placeholder="Search keys or text…"
        value={f.search}
        onChange={(e) => p.onFilter({ search: e.target.value })}
        className={`${field} min-w-40 flex-1`}
      />
      <button className={chip(f.missing)} aria-pressed={f.missing} onClick={() => p.onFilter({ missing: !f.missing })}>
        Missing ({p.missingCount})
      </button>
      <button className={chip(f.needsReview)} aria-pressed={f.needsReview} onClick={() => p.onFilter({ needsReview: !f.needsReview })}>
        Needs review
      </button>
      <button className={chip(f.machine)} aria-pressed={f.machine} onClick={() => p.onFilter({ machine: !f.machine })}>
        Machine
      </button>
      <select aria-label="Status" className={field} value={f.status} onChange={(e) => p.onFilter({ status: e.target.value as FilterState["status"] })}>
        <option value="all">All statuses</option>
        <option value="untranslated">Untranslated</option>
        <option value="translated">Translated</option>
        <option value="reviewed">Reviewed</option>
      </select>
      {p.showNamespaces && (
        <select aria-label="Namespace" className={field} value={f.ns} onChange={(e) => p.onFilter({ ns: e.target.value })}>
          <option value="all">All namespaces</option>
          {p.namespaces.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      )}
      <div className="relative">
        <button className={field} aria-haspopup="true" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
          Languages ▾
        </button>
        {menu && (
          <div role="menu" aria-label="Visible languages" className="absolute right-0 z-20 mt-1 min-w-36 rounded-md border border-gray-200 bg-white p-2 shadow-lg">
            {p.targetLocales.map((l) => (
              <label key={l} className="flex items-center gap-2 py-0.5 text-sm">
                <input type="checkbox" checked={!p.hidden.has(l)} onChange={() => p.onToggleLocale(l)} />
                {l}
              </label>
            ))}
            {!p.targetLocales.length && <div className="text-xs text-gray-500">No other languages</div>}
          </div>
        )}
      </div>
      <div className="inline-flex overflow-hidden rounded-md border border-gray-300 text-sm" role="group" aria-label="View mode">
        {(["list", "table"] as const).map((m) => (
          <button
            key={m}
            aria-pressed={p.viewMode === m}
            onClick={() => p.onViewMode(m)}
            className={`px-3 py-1 capitalize ${p.viewMode === m ? "bg-indigo-600 text-white" : "hover:bg-gray-50"}`}
          >
            {m}
          </button>
        ))}
      </div>
      {p.onTranslateMissing && (
        <button className={field} onClick={p.onTranslateMissing}>Translate missing…</button>
      )}
      <button onClick={p.onAddKey} className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium text-white">+ Key</button>
    </div>
  );
}
