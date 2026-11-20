import { useEffect, useRef, useState } from "react";
import type { RowFilter } from "../core/rows";
import { btnPrimary, btnSecondary } from "./Dialog";
import { Icon } from "./Icon";
import { SOURCE_CHANGED } from "./StatusDot";
import { languageWithCode } from "./locales";

export type FilterState = Omit<RowFilter, "locales">;

export interface ToolbarProps {
  filter: FilterState;
  onFilter: (patch: Partial<FilterState>) => void;
  missingCount: number;
  namespaces: string[];
  showNamespaces: boolean;
  /** Workspaces call namespaces "groups". */
  nsLabel?: "Namespace" | "Group";
  targetLocales: string[];
  hidden: Set<string>;
  onToggleLocale: (l: string) => void;
  viewMode: "list" | "table";
  onViewMode: (m: "list" | "table") => void;
  onAddKey?: () => void;
  /** Opens Add language (the same dialog as the Languages page). */
  onAddLanguage?: () => void;
  onTranslateMissing?: () => void;
  /** Translate missing is the screen's main action (nothing unsaved, something missing). */
  translatePrimary?: boolean;
}

const chip = (on: boolean) =>
  `inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-medium ${
    on ? "border-brand-line bg-brand-soft text-brand-ink" : "border-line-strong bg-surface text-fg-2 hover:bg-hover"
  }`;
const field = "rounded-md border border-line-strong bg-surface px-2 py-1 text-sm text-fg hover:border-muted";

export function Toolbar(p: ToolbarProps) {
  const [menu, setMenu] = useState(false);
  const menuBox = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const { filter: f } = p;
  const shown = p.targetLocales.filter((l) => !p.hidden.has(l)).length;

  // The languages menu closes on a press outside it or Escape.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: Event) => !menuBox.current?.contains(e.target as Node) && setMenu(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenu(false);
      menuButton.current?.focus();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2.5">
      <label className="relative flex min-w-48 max-w-md flex-1 items-center">
        <Icon name="search" className="pointer-events-none absolute left-2.5 text-muted" size={15} />
        <input
          type="search"
          aria-label="Search"
          placeholder="Search keys or text…"
          value={f.search}
          onChange={(e) => p.onFilter({ search: e.target.value })}
          className={`${field} w-full py-1.5 pl-8 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-line`}
        />
      </label>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filters">
        <button className={chip(f.missing)} aria-pressed={f.missing} aria-label={`Missing (${p.missingCount})`} onClick={() => p.onFilter({ missing: !f.missing })}>
          <span className="h-2 w-2 rounded-full bg-st-missing" aria-hidden="true" />
          Missing
          <span className={`rounded px-1.5 tabular-nums ${f.missing ? "bg-surface" : "bg-sunken"}`}>{p.missingCount}</span>
        </button>
        <button
          className={chip(f.needsReview)}
          aria-pressed={f.needsReview}
          title="Translations whose base text changed after they were written"
          onClick={() => p.onFilter({ needsReview: !f.needsReview })}
        >
          {SOURCE_CHANGED}
        </button>
        <button className={chip(f.machine)} aria-pressed={f.machine} title="Translations written by AI and not reviewed yet" onClick={() => p.onFilter({ machine: !f.machine })}>
          AI
        </button>
        <button
          className={chip(!!f.tooLong)}
          aria-pressed={!!f.tooLong}
          title="Translations a designer marked too long in the Figma preview"
          onClick={() => p.onFilter({ tooLong: !f.tooLong })}
        >
          Too long
        </button>
        <select aria-label="Status" className={field} value={f.status} onChange={(e) => p.onFilter({ status: e.target.value as FilterState["status"] })}>
          <option value="all">All statuses</option>
          <option value="translated">Not reviewed</option>
          <option value="reviewed">Reviewed</option>
        </select>
        {p.showNamespaces && (
          <select aria-label={p.nsLabel ?? "Namespace"} className={field} value={f.ns} onChange={(e) => p.onFilter({ ns: e.target.value })}>
            <option value="all">{p.nsLabel === "Group" ? "All groups" : "All namespaces"}</option>
            {p.namespaces.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        )}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <div className="relative" ref={menuBox}>
          <button
            ref={menuButton}
            className={`${field} inline-flex items-center gap-1.5`}
            aria-label="Visible languages"
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
          >
            Languages
            {shown < p.targetLocales.length && (
              <span className="rounded bg-brand-soft px-1.5 text-xs font-medium tabular-nums text-brand-ink">
                {shown}/{p.targetLocales.length}
              </span>
            )}
            <Icon name="chevronDown" size={14} className="text-muted" />
          </button>
          {menu && (
            <div role="group" aria-label="Visible languages" className="absolute right-0 z-20 mt-1 w-max min-w-44 max-w-[min(28rem,90vw)] rounded-lg border border-line bg-surface p-1.5 shadow-pop">
              {p.targetLocales.map((l) => (
                <label key={l} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-hover">
                  <input type="checkbox" checked={!p.hidden.has(l)} onChange={() => p.onToggleLocale(l)} />
                  <span className="truncate whitespace-nowrap font-medium">{languageWithCode(l)}</span>
                </label>
              ))}
              {!p.targetLocales.length && <div className="px-2 py-1 text-xs text-muted">No other languages</div>}
              {p.onAddLanguage && (
                <>
                  <div className="my-1 border-t border-line" />
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-hover"
                    onClick={() => {
                      setMenu(false);
                      p.onAddLanguage!();
                    }}
                  >
                    <Icon name="plus" size={14} className="text-muted" />
                    Add language…
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="inline-flex rounded-md border border-line-strong bg-panel p-0.5 text-sm" role="group" aria-label="View mode">
          {(["list", "table"] as const).map((m) => (
            <button
              key={m}
              aria-pressed={p.viewMode === m}
              onClick={() => p.onViewMode(m)}
              className={`inline-flex items-center gap-1.5 rounded px-2.5 py-0.5 capitalize ${
                p.viewMode === m ? "bg-surface font-medium text-fg ring-1 ring-line" : "text-muted hover:text-fg"
              }`}
            >
              <Icon name={m === "list" ? "rows" : "table"} size={14} />
              {m}
            </button>
          ))}
        </div>
        {p.onTranslateMissing && (
          <button className={p.translatePrimary ? btnPrimary : btnSecondary} data-tour="translate" onClick={p.onTranslateMissing}>
            <Icon name="sparkles" size={15} />
            Translate missing…
          </button>
        )}
        <button onClick={p.onAddKey} className={btnSecondary}>
          <Icon name="plus" size={15} />
          Add key
        </button>
      </div>
    </div>
  );
}
