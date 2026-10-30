import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { buildRows } from "../core/rows";
import { getViewMode, setViewMode } from "../platform/prefs";
import { ListView } from "./ListView";
import { type Page, Sidebar } from "./Sidebar";
import { useApp, useSessionVersion } from "./store";
import { TableView } from "./TableView";
import { type FilterState, Toolbar } from "./Toolbar";

const INITIAL: FilterState = { search: "", ns: "all", missing: false, needsReview: false, machine: false, status: "all" };

export function AppShell() {
  const version = useSessionVersion();
  const session = useApp((s) => s.session);
  const error = useApp((s) => s.error);
  const closeProject = useApp((s) => s.closeProject);
  const [page, setPage] = useState<Page>("translations");
  const [filter, setFilter] = useState<FilterState>(INITIAL);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [viewMode, setMode] = useState<"list" | "table">("list");
  const root = session?.data.root;

  useEffect(() => {
    if (!root) return;
    let live = true;
    getViewMode(root).then(
      (m) => live && setMode(m),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [root]);

  const onViewMode = useCallback(
    (m: "list" | "table") => {
      setMode(m);
      if (root) void setViewMode(root, m).catch(() => {});
    },
    [root],
  );

  const deferredSearch = useDeferredValue(filter.search);
  const targets = useMemo(
    () => (session ? session.data.locales.filter((l) => l !== session.data.baseLocale) : []),
    [session, version],
  );
  const visible = useMemo(() => targets.filter((l) => !hidden.has(l)), [targets, hidden]);
  const rowFilter = useMemo(() => ({ ...filter, search: deferredSearch, locales: visible }), [filter, deferredSearch, visible]);
  const rows = useMemo(() => (session ? buildRows(session, rowFilter) : []), [session, version, rowFilter]);
  const missingCount = useMemo(
    () => (session ? buildRows(session, { ...rowFilter, missing: true }).length : 0),
    [session, version, rowFilter],
  );

  if (!session) return null;
  const toggleLocale = (l: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (!n.delete(l)) n.add(l);
      return n;
    });

  return (
    <div className="flex h-screen bg-white text-gray-900">
      <Sidebar session={session} page={page} onPage={setPage} onClose={() => void closeProject()} />
      <main className="flex min-w-0 flex-1 flex-col">
        {error && (
          <div role="alert" className="flex items-center justify-between gap-3 bg-red-50 px-4 py-2 text-sm text-red-700">
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => useApp.setState({ error: null })}>✕</button>
          </div>
        )}
        {page === "translations" ? (
          <>
            <Toolbar
              filter={filter}
              onFilter={(p) => setFilter((f) => ({ ...f, ...p }))}
              missingCount={missingCount}
              namespaces={session.data.namespaces}
              showNamespaces={session.data.format === "next-i18next"}
              targetLocales={targets}
              hidden={hidden}
              onToggleLocale={toggleLocale}
              viewMode={viewMode}
              onViewMode={onViewMode}
            />
            <div className="min-h-0 flex-1">
              {viewMode === "list" ? (
                <ListView session={session} rows={rows} locales={visible} />
              ) : (
                <TableView session={session} rows={rows} locales={visible} />
              )}
            </div>
          </>
        ) : (
          <div className="p-8 text-gray-500">Coming in the next step</div>
        )}
      </main>
    </div>
  );
}
