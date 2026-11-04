import { useApp } from "./store";

/** One tab per open project, an unsaved dot, a spinner while background work runs, and "+" for another project. */
export function TabBar() {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeId);
  const activeSession = useApp((s) => s.session);
  useApp((s) => s.version); // re-render when the active tab's dirty state may have changed
  const notice = useApp((s) => s.notice);
  const { switchTab, showStart, closeTab } = useApp.getState();

  return (
    <div className="shrink-0 border-b border-gray-200 bg-gray-50">
      <div className="flex items-end overflow-x-auto" role="tablist" aria-label="Open projects">
        {tabs.map((t) => {
          const active = t.id === activeId;
          const session = active ? activeSession : t.snap?.session;
          const dirty = !!session?.isDirty();
          return (
            <div
              key={t.id}
              className={`group flex shrink-0 items-center border-r border-gray-200 ${
                active ? "border-b-2 border-b-indigo-600 bg-white" : "hover:bg-gray-100"
              }`}
            >
              <button
                role="tab"
                aria-selected={active}
                title={t.root}
                className={`flex max-w-56 items-center gap-1.5 py-1.5 pl-3 pr-1 text-sm ${active ? "font-medium text-gray-900" : "text-gray-600"}`}
                onClick={() => switchTab(t.id)}
              >
                <span className="truncate">{t.name}</span>
                {dirty && <span aria-label="Unsaved changes" className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />}
                {t.busy > 0 && (
                  <span
                    aria-label="Working"
                    className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-indigo-300 border-t-indigo-600"
                  />
                )}
              </button>
              <button
                aria-label={`Close tab ${t.name}`}
                className="mr-1 rounded px-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
                onClick={() => void closeTab(t.id)}
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          aria-label="Open another project"
          title="Open another project"
          className={`shrink-0 px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-800 ${activeId === null ? "bg-white" : ""}`}
          onClick={showStart}
        >
          +
        </button>
      </div>
      {notice && (
        <div className="flex items-center justify-between gap-2 border-t border-amber-200 bg-amber-50 px-3 py-1.5 text-sm text-amber-800">
          <span>{notice}</span>
          <button className="text-amber-700 hover:underline" onClick={() => useApp.setState({ notice: null })}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
