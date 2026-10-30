import type { ProjectSession } from "../core/session";

export type Page = "translations" | "languages" | "settings";

const NAV: Array<{ page: Page; label: string }> = [
  { page: "translations", label: "Translations" },
  { page: "languages", label: "Languages" },
  { page: "settings", label: "Settings" },
];

export function Sidebar({ session, stats, page, onPage, onClose }: { session: ProjectSession; stats: Map<string, { done: number; total: number }>; page: Page; onPage: (p: Page) => void; onClose: () => void }) {
  const name = session.data.root.split("/").filter(Boolean).pop() ?? session.data.root;
  const item = (on: boolean) =>
    `block w-full rounded-md px-2 py-1.5 text-left text-sm ${on ? "bg-indigo-100 font-semibold text-indigo-800" : "text-gray-600 hover:bg-gray-100"}`;
  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-gray-200 bg-gray-50 p-3" aria-label="Sidebar">
      <div className="mb-3 truncate text-sm font-bold" title={name}>{name}</div>
      <nav className="space-y-0.5">
        {NAV.map((n) => (
          <button key={n.page} className={item(page === n.page)} aria-current={page === n.page ? "page" : undefined} onClick={() => onPage(n.page)}>
            {n.label}
          </button>
        ))}
        <button className={`${item(false)} cursor-not-allowed opacity-50`} disabled title="Coming soon">
          Import / Export <span className="text-[10px]">(coming soon)</span>
        </button>
      </nav>
      <div className="mt-5 space-y-2 text-xs text-gray-500">
        {session.data.locales.map((l) => {
          const s = stats.get(l) ?? { done: 0, total: 0 };
          const pct = s.total ? Math.round((s.done / s.total) * 100) : 100;
          return (
            <div key={l}>
              <div className="flex justify-between">
                <span className="font-semibold uppercase">{l}</span>
                <span>{pct}%</span>
              </div>
              <div className="mt-0.5 h-1.5 rounded bg-gray-200">
                <div
                  role="progressbar"
                  aria-label={`${l} completion`}
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  data-tone={pct < 80 ? "amber" : "green"}
                  className={`h-full rounded ${pct < 80 ? "bg-amber-500" : "bg-green-500"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <button onClick={onClose} className="mt-auto rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
        Close project
      </button>
    </aside>
  );
}
