import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { currentPlatform } from "../platform/menu";
import { Icon } from "./Icon";
import { updateUnseen, useApp } from "./store";

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

/** A tab being dragged: how far it has moved, the tabs' places when the drag began, and where it would land. */
interface TabDrag {
  id: string;
  startX: number;
  dx: number;
  moved: boolean;
  rects: Array<{ id: string; left: number; width: number }>;
  from: number;
  to: number;
}

/** A press only becomes a drag past this many pixels, so a click still just switches tabs. */
const DRAG_START = 5;
/** The tab list's gap-1, so neighbours move by a whole tab plus its gap. */
const TAB_GAP = 4;

/** One tab per open project, an unsaved dot, a spinner while background work runs, and "+" for another project. */
export function TabBar() {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeId);
  const activeSession = useApp((s) => s.session);
  useApp((s) => s.version); // re-render when the active tab's dirty state may have changed
  const notice = useApp((s) => s.notice);
  const { switchTab, showStart, closeTab } = useApp.getState();
  const fullscreen = useFullscreen();
  const updateDot = useApp(updateUnseen);
  // Empty parts of the bar move the window (and double-click zooms it), like a native title bar.
  const drag = inTitleBar ? { "data-tauri-drag-region": "" } : {};

  // Dragging a tab reorders it, like a browser. Pointer events, not HTML drag and drop, which the
  // webview's own file-drop handling can swallow.
  const [moving, setMoving] = useState<TabDrag | null>(null);
  const movingRef = useRef<TabDrag | null>(null);
  const startDrag = (e: React.PointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0 || (e.target as Element).closest("[data-tab-close]")) return;
    const list = e.currentTarget.parentElement;
    if (!list) return;
    const rects = [...list.querySelectorAll<HTMLElement>("[data-tab-id]")].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.tabId!, left: r.left, width: r.width };
    });
    const from = rects.findIndex((r) => r.id === id);
    if (from < 0 || rects.length < 2) return;
    movingRef.current = { id, startX: e.clientX, dx: 0, moved: false, rects, from, to: from };
    const move = (ev: PointerEvent) => {
      const d = movingRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      if (!d.moved && Math.abs(dx) < DRAG_START) return;
      // It lands after every other tab whose middle its own middle has passed.
      const me = d.rects[d.from];
      const middle = me.left + me.width / 2 + dx;
      const to = d.rects.filter((r, i) => i !== d.from && r.left + r.width / 2 < middle).length;
      movingRef.current = { ...d, dx, moved: true, to };
      setMoving(movingRef.current);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      const d = movingRef.current;
      movingRef.current = null;
      setMoving(null);
      if (d?.moved && d.to !== d.from) useApp.getState().moveTab(d.id, d.to);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  /** Where a tab is drawn during a drag: the dragged one follows the pointer, the ones it passes make room. */
  const shift = (i: number): number => {
    if (!moving) return 0;
    if (i === moving.from) return moving.dx;
    const room = moving.rects[moving.from].width + TAB_GAP;
    if (moving.from < moving.to && i > moving.from && i <= moving.to) return -room;
    if (moving.from > moving.to && i >= moving.to && i < moving.from) return room;
    return 0;
  };

  return (
    <div className="shrink-0 border-b border-line bg-panel">
      <div {...drag} className={`flex h-10 items-center gap-1 pr-1.5 ${inTitleBar && !fullscreen ? "pl-[78px]" : "pl-1.5"}`}>
        <div {...drag} className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="Open projects">
          {tabs.map((t, i) => {
            const active = t.id === activeId;
            const dragged = moving?.id === t.id;
            const dx = shift(i);
            const session = active ? activeSession : t.snap?.session;
            const dirty = !!session?.isDirty();
            return (
              <div
                key={t.id}
                data-tab-id={t.id}
                onPointerDown={(e) => startDrag(e, t.id)}
                style={dx ? { transform: `translateX(${dx}px)` } : undefined}
                className={`group relative flex h-7 shrink-0 items-center rounded-md ${active ? "bg-surface ring-1 ring-line" : "hover:bg-hover"} ${
                  dragged ? "z-10 cursor-grabbing shadow-pop" : moving ? "transition-transform duration-150 motion-reduce:transition-none" : ""
                }`}
              >
                <button
                  role="tab"
                  aria-selected={active}
                  title={t.root}
                  className={`flex max-w-56 items-center gap-1.5 py-1 pl-3 pr-1 text-sm ${active ? "font-medium text-fg" : "text-muted hover:text-fg"}`}
                  onClick={() => switchTab(t.id)}
                >
                  <span className="truncate">{t.name}</span>
                  {dirty && <span role="img" aria-label="Unsaved changes" className="h-2 w-2 shrink-0 rounded-full bg-warn-solid" />}
                  {t.busy > 0 && (
                    <span
                      role="img"
                      aria-label="Working"
                      className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-brand-line border-t-brand"
                    />
                  )}
                </button>
                <button
                  data-tab-close
                  aria-label={`Close tab ${t.name}`}
                  className={`mr-1 rounded p-1.5 text-muted hover:bg-sunken hover:text-fg focus-visible:opacity-100 ${active ? "opacity-70 group-hover:opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                  onClick={() => void closeTab(t.id)}
                >
                  <Icon name="x" size={13} />
                </button>
              </div>
            );
          })}
          {/* The start screen is a tab of its own, like a browser's new tab. */}
          {activeId === null && (
            <div className="group flex h-7 shrink-0 items-center rounded-md bg-surface ring-1 ring-line">
              <span role="tab" aria-selected="true" className={`py-1 pl-3 text-sm font-medium text-fg ${tabs.length ? "pr-1" : "pr-3"}`}>
                New Tab
              </span>
              {tabs.length > 0 && (
                <button
                  aria-label="Close New Tab"
                  className="mr-1 rounded p-1.5 text-muted opacity-70 hover:bg-sunken hover:text-fg group-hover:opacity-100"
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
          aria-label={updateDot ? "Open settings (update available)" : "Open settings"}
          data-tour="settings"
          title={`${updateDot ? "A new version is available. " : ""}Settings (${navigator.userAgent.includes("Mac") ? "⌘," : "Ctrl+,"})`}
          className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-hover hover:text-fg"
          // With an update waiting, go straight to About, where it can be installed.
          onClick={() => useApp.getState().openPrefs(updateDot ? "about" : undefined)}
        >
          <Icon name="settings" size={16} />
          {updateDot && <span aria-hidden="true" data-testid="update-dot" className="absolute right-1 top-1 h-2 w-2 rounded-full bg-brand ring-2 ring-panel" />}
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
