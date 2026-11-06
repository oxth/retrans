import type { ProjectSession } from "../core/session";
import { sectionLabel } from "./Dialog";
import { Icon, type IconName } from "./Icon";
import { SOURCE_CHANGED } from "./StatusDot";

export type Page = "translations" | "languages" | "share";

const NAV: Array<{ page: Page; label: string; icon: IconName }> = [
  { page: "translations", label: "Translations", icon: "list" },
  { page: "languages", label: "Languages", icon: "languages" },
  { page: "share", label: "Import / Export", icon: "share" },
];

export const PAGE_LABEL = Object.fromEntries(NAV.map((n) => [n.page, n.label])) as Record<Page, string>;

export function Sidebar({
  session,
  stats,
  page,
  onPage,
}: {
  session: ProjectSession;
  stats: Map<string, { done: number; total: number }>;
  page: Page;
  onPage: (p: Page) => void;
}) {
  const name = session.data.root.split("/").filter(Boolean).pop() ?? session.data.root;
  const base = session.data.baseLocale;
  const item = (on: boolean) =>
    `flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm ${
      on ? "bg-brand-soft font-semibold text-brand-ink" : "text-fg-2 hover:bg-hover hover:text-fg"
    }`;
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-panel" aria-label="Sidebar">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <Icon name="folder" size={16} className="text-brand" />
        <div className="min-w-0 truncate text-sm font-semibold" title={session.data.root}>{name}</div>
      </div>
      <nav className="space-y-0.5 p-2">
        {NAV.map((n) => (
          <button key={n.page} className={item(page === n.page)} aria-current={page === n.page ? "page" : undefined} onClick={() => onPage(n.page)}>
            <Icon name={n.icon} size={16} className={page === n.page ? "text-brand" : "text-muted"} />
            {n.label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-3 pt-3">
        <div className={sectionLabel}>Progress</div>
        <div className="mt-2.5 space-y-3 text-xs">
          {session.data.locales.map((l) => {
            const s = stats.get(l) ?? { done: 0, total: 0 };
            const pct = s.total ? Math.round((s.done / s.total) * 100) : 100;
            return (
              <div key={l}>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5">
                    <span className="font-semibold uppercase text-fg">{l}</span>
                    {l === base && <span className="rounded bg-sunken px-1 text-[11px] text-muted">base</span>}
                  </span>
                  <span className="tabular-nums text-muted">{pct}%</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-sunken">
                  <div
                    role="progressbar"
                    aria-label={`${l} completion`}
                    aria-valuenow={pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    data-tone={pct < 80 ? "amber" : "green"}
                    className={`h-full rounded-full ${pct < 80 ? "bg-warn-solid" : "bg-ok-solid"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <section aria-label="Status key" className="mt-6">
          <div className={sectionLabel}>Status key</div>
          <ul className="mt-2 space-y-1.5 text-xs text-fg-2">
            <li className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-st-missing" aria-hidden="true" />Missing</li>
            <li className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-st-translated" aria-hidden="true" />Not reviewed</li>
            <li className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-st-reviewed" aria-hidden="true" />Reviewed</li>
            <li className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-st-reviewed ring-2 ring-warn-solid ring-offset-1 ring-offset-panel" aria-hidden="true" />
              {SOURCE_CHANGED}
            </li>
          </ul>
          <dl className="mt-2.5 space-y-1.5 text-[11px] leading-4 text-muted">
            <div>
              <dt className="inline font-medium text-fg-2">Not reviewed:</dt> <dd className="inline">translated, but nobody has checked it yet.</dd>
            </div>
            <div>
              <dt className="inline font-medium text-fg-2">{SOURCE_CHANGED}:</dt>{" "}
              <dd className="inline">the base text was edited after this was translated, so it may be out of date.</dd>
            </div>
            <div>
              Click <span className="font-medium text-fg-2">✓ Review</span> on a translation, or press ⌘⇧R while it's selected, to mark it reviewed.
            </div>
          </dl>
        </section>
      </div>
    </aside>
  );
}
