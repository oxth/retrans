import { Icon } from "./Icon";
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
    <div className="shrink-0 border-b border-line bg-panel">
      <div className="flex items-end overflow-x-auto" role="tablist" aria-label="Open projects">
        {tabs.map((t) => {
          const active = t.id === activeId;
          const session = active ? activeSession : t.snap?.session;
          const dirty = !!session?.isDirty();
          return (
            <div
              key={t.id}
              className={`group relative flex shrink-0 items-center border-r border-line ${
                active ? "bg-surface" : "hover:bg-hover"
              }`}
            >
              {active && <span aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 bg-brand" />}
              <button
                role="tab"
                aria-selected={active}
                title={t.root}
                className={`flex max-w-56 items-center gap-1.5 py-2 pl-3 pr-1 text-sm ${active ? "font-medium text-fg" : "text-muted hover:text-fg"}`}
                onClick={() => switchTab(t.id)}
              >
                <span className="truncate">{t.name}</span>
                {dirty && <span aria-label="Unsaved changes" className="h-2 w-2 shrink-0 rounded-full bg-warn-solid" />}
                {t.busy > 0 && (
                  <span
                    aria-label="Working"
                    className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-brand-line border-t-brand"
                  />
                )}
              </button>
              <button
                aria-label={`Close tab ${t.name}`}
                className={`mr-1.5 rounded p-1 text-muted hover:bg-sunken hover:text-fg ${active ? "" : "opacity-60 group-hover:opacity-100"}`}
                onClick={() => void closeTab(t.id)}
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          );
        })}
        <button
          aria-label="Open another project"
          title="Open another project"
          className={`flex shrink-0 items-center self-stretch px-3 text-muted hover:bg-hover hover:text-fg ${activeId === null ? "bg-surface text-fg" : ""}`}
          onClick={showStart}
        >
          <Icon name="plus" size={15} />
        </button>
      </div>
      {notice && (
        <div className="flex items-center gap-2 border-t border-warn-line bg-warn-soft px-3 py-1.5 text-sm text-warn">
          <Icon name="alert" size={15} />
          <span className="flex-1">{notice}</span>
          <button className="rounded px-1.5 font-medium text-warn hover:underline" onClick={() => useApp.setState({ notice: null })}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
