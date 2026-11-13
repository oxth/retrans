import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { currentPlatform } from "../platform/menu";
import { Icon } from "./Icon";
import { useApp } from "./store";

/**
 * macOS draws the window's traffic lights over this bar (titleBarStyle Overlay in tauri.conf.json),
 * so the tabs sit in the title bar. Elsewhere the native title bar stays and this is a plain row.
 */
export const inTitleBar = currentPlatform() === "macos";

/** Full screen hides the traffic lights, so the space kept for them can go. */
function useFullscreen(): boolean {
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!inTitleBar) return;
    let stop = () => {};
    let live = true;
    try {
      const w = getCurrentWindow();
      const check = () => void w.isFullscreen().then((f) => live && setFull(f), () => {});
      check();
      w.onResized(check).then((un) => (live ? (stop = un) : un()), () => {});
    } catch {
      /* not running inside Tauri */
    }
    return () => {
      live = false;
      stop();
    };
  }, []);
  return full;
}

/** One tab per open project, an unsaved dot, a spinner while background work runs, and "+" for another project. */
export function TabBar() {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeId);
  const activeSession = useApp((s) => s.session);
  useApp((s) => s.version); // re-render when the active tab's dirty state may have changed
  const notice = useApp((s) => s.notice);
  const { switchTab, showStart, closeTab } = useApp.getState();
  const fullscreen = useFullscreen();
  // Empty parts of the bar move the window (and double-click zooms it), like a native title bar.
  const drag = inTitleBar ? { "data-tauri-drag-region": "" } : {};

  return (
    <div className="shrink-0 border-b border-line bg-panel">
      <div {...drag} className={`flex h-10 items-center gap-1 pr-1.5 ${inTitleBar && !fullscreen ? "pl-[78px]" : "pl-1.5"}`}>
        <div {...drag} className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="Open projects">
          {tabs.map((t) => {
            const active = t.id === activeId;
            const session = active ? activeSession : t.snap?.session;
            const dirty = !!session?.isDirty();
            return (
              <div
                key={t.id}
                className={`group flex h-7 shrink-0 items-center rounded-md ${active ? "bg-surface shadow-sm ring-1 ring-line" : "hover:bg-hover"}`}
              >
                <button
                  role="tab"
                  aria-selected={active}
                  title={t.root}
                  className={`flex max-w-56 items-center gap-1.5 py-1 pl-3 pr-1 text-sm ${active ? "font-medium text-fg" : "text-muted hover:text-fg"}`}
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
                  className={`mr-1 rounded p-0.5 text-muted hover:bg-sunken hover:text-fg focus-visible:opacity-100 ${active ? "opacity-70 group-hover:opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                  onClick={() => void closeTab(t.id)}
                >
                  <Icon name="x" size={13} />
                </button>
              </div>
            );
          })}
          {/* The start screen is a tab of its own, like a browser's new tab. */}
          {activeId === null && (
            <div className="group flex h-7 shrink-0 items-center rounded-md bg-surface shadow-sm ring-1 ring-line">
              <span role="tab" aria-selected="true" className={`py-1 pl-3 text-sm font-medium text-fg ${tabs.length ? "pr-1" : "pr-3"}`}>
                New Tab
              </span>
              {tabs.length > 0 && (
                <button
                  aria-label="Close New Tab"
                  className="mr-1 rounded p-0.5 text-muted opacity-70 hover:bg-sunken hover:text-fg group-hover:opacity-100"
                  onClick={() => switchTab(tabs[tabs.length - 1].id)}
                >
                  <Icon name="x" size={13} />
                </button>
              )}
            </div>
          )}
          <button
            aria-label="Open another project"
            title="Open another project"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
            onClick={showStart}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
        <button
          aria-label="Open settings"
          title={`Settings (${navigator.userAgent.includes("Mac") ? "⌘," : "Ctrl+,"})`}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-hover hover:text-fg"
          onClick={() => useApp.getState().openPrefs()}
        >
          <Icon name="settings" size={16} />
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
