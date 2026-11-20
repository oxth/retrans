import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState } from "react";
import { Cell } from "./Cell";
import { RowMenu } from "./RowMenu";
import { isRemovedInSource, type ViewProps, isFigmaRow, NoCodeKeyBadge, NoMatches } from "./ListView";
import { RowWarnings } from "./Warnings";
import { duplicateGroups } from "../workspace/actions";
import { languageWithCode, localeLabel } from "./locales";

const KEY_W = 220;
const COL_W = 260;
/** Fixed height of the sticky header (two lines: name, then code); the virtualizer needs it as scrollMargin. */
const HEADER_H = 44;
const MIN_W = 120;
const MAX_W = 900;
/** Column widths the user dragged, by column ("key" or a locale code); shared by all projects. */
const WIDTHS_KEY = "retrans.tableWidths";

function loadWidths(): Record<string, number> {
  try {
    const saved = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

function saveWidths(widths: Record<string, number>): void {
  try {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths));
  } catch {
    /* blocked storage: widths last for this session only */
  }
}

/**
 * Drag handle on a header's right edge. Arrow keys resize too; double-click resets to the default width.
 * A `grows` column may be wider on screen than its stored width (it shares the window's spare room), so
 * resizing starts from what's on screen.
 */
function ColumnResizer({ label, width, grows, onResize, onReset, onDone }: {
  label: string; width: number; grows?: boolean; onResize: (w: number) => void; onReset: () => void; onDone: () => void;
}) {
  const clamp = (w: number) => Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));
  const shown = (handle: HTMLElement) => (grows && handle.parentElement ? handle.parentElement.getBoundingClientRect().width : width);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const handle = e.currentTarget;
    const startW = shown(handle);
    handle.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => onResize(clamp(startW + ev.clientX - startX));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      onDone();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
    if (!step) return;
    e.preventDefault();
    onResize(clamp(shown(e.currentTarget as HTMLElement) + step));
    onDone();
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      aria-valuenow={width}
      aria-valuemin={MIN_W}
      aria-valuemax={MAX_W}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      className="absolute -right-1 top-0 z-20 h-full w-2 cursor-col-resize touch-none hover:bg-brand-line focus-visible:bg-brand-line focus-visible:outline-none"
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}

export function TableView({ session, rows, locales, version, editing, actions, onRowAction, empty }: ViewProps) {
  const parent = useRef<HTMLDivElement>(null);
  const base = session.data.baseLocale;
  const [widths, setWidths] = useState(loadWidths);
  // Mirrors `widths` without waiting for a render, so a save right after a resize has the new width.
  const latest = useRef(widths);
  const update = (next: Record<string, number>) => {
    latest.current = next;
    setWidths(next);
  };
  const colW = (col: string) => widths[col] ?? (col === "key" ? KEY_W : COL_W);
  const keyW = colW("key");
  const width = keyW + colW(base) + locales.reduce((sum, l) => sum + colW(l), 0);
  // Language columns grow to share spare width (their stored width is the minimum); the key column doesn't.
  const grow = (col: string) => ({ flex: `1 0 ${colW(col)}px` });
  const resizer = (col: string, label: string) => (
    <ColumnResizer
      label={label}
      width={colW(col)}
      grows={col !== "key"}
      onResize={(w) => update({ ...latest.current, [col]: w })}
      onReset={() => {
        const { [col]: _, ...rest } = latest.current;
        update(rest);
        saveWidths(rest);
      }}
      onDone={() => saveWidths(latest.current)}
    />
  );
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 44,
    overscan: 10,
    scrollMargin: HEADER_H,
    scrollPaddingStart: HEADER_H,
    getItemKey: (i) => rows[i].id,
  });
  const editId = editing?.id;
  const editLocale = editing?.locale;
  useEffect(() => {
    if (!editId) return;
    const i = rows.findIndex((r) => r.id === editId);
    if (i >= 0) virt.scrollToIndex(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId, editLocale]);
  const pin = (left: number) => ({ position: "sticky" as const, left, zIndex: 1 });
  // The name may be cut off in a narrow column; the code below it is short and always fits.
  const head = (l: string, isBase = false) => {
    const name = localeLabel(l);
    return (
      <span className="block min-w-0" title={languageWithCode(l)}>
        <span className="block truncate text-fg-2">{name !== l ? name : l}</span>
        <span className="block truncate font-mono text-xs font-normal text-muted">
          {l}
          {isBase && " · base"}
        </span>
      </span>
    );
  };
  return (
    <div ref={parent} className="h-full overflow-auto text-sm" data-testid="table-scroll">
      <div style={{ width, minWidth: "100%" }}>
        <div style={{ height: HEADER_H }}
          className="sticky top-0 z-10 flex items-center border-b border-line bg-panel text-xs font-semibold text-muted">
          <div className="shrink-0 bg-panel px-3 py-1.5" style={{ width: keyW, ...pin(0), zIndex: 12 }}>
            Key
            {resizer("key", "Key")}
          </div>
          <div className="border-r border-line bg-panel px-2 py-1" style={{ ...grow(base), ...pin(keyW), zIndex: 11 }}>
            {head(base, true)}
            {resizer(base, languageWithCode(base))}
          </div>
          {locales.map((l) => (
            <div key={l} className="relative border-r border-line px-2 py-1" style={grow(l)}>
              {head(l)}
              {resizer(l, languageWithCode(l))}
            </div>
          ))}
        </div>
        {!rows.length ? (
          <NoMatches {...empty} />
        ) : (
          <div style={{ height: virt.getTotalSize(), position: "relative" }}>
            {virt.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              const removed = isRemovedInSource(session, row.id);
              const figmaRow = isFigmaRow(session, row.id);
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virt.measureElement}
                  className="absolute left-0 top-0 flex border-b border-line"
                  style={{ transform: `translateY(${vi.start - HEADER_H}px)`, width: "100%" }}
                  data-row={row.id}
                >
                  <div className="shrink-0 border-r border-line bg-surface px-3 py-1.5" style={{ width: keyW, ...pin(0) }}>
                    <div className="flex items-start gap-1">
                      <div className="min-w-0 flex-1 break-all pt-1 font-mono text-[0.8125rem] font-medium text-fg">{row.key}</div>
                      {onRowAction && (
                        <RowMenu
                          name={row.key}
                          onRename={() => onRowAction(row, "rename")}
                          onDelete={() => onRowAction(row, "delete")}
                          onKeep={removed ? () => onRowAction(row, "keep") : undefined}
                          onCodeKey={figmaRow ? () => onRowAction(row, "code-key") : undefined}
                          onLink={figmaRow ? () => onRowAction(row, "link") : undefined}
                        />
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted">
                      {row.ns && <span>{row.ns}</span>}
                      {figmaRow && <NoCodeKeyBadge />}
                      <RowWarnings duplicateOf={duplicateGroups(session, row.id)} removedInSource={removed} />
                    </div>
                  </div>
                  <div className="border-r border-line bg-surface" style={{ ...grow(base), ...pin(keyW) }}>
                    <Cell session={session} id={row.id} locale={base} showCode={false} version={version} editing={editId === row.id && editLocale === base} actions={actions} />
                  </div>
                  {locales.map((l) => (
                    <div key={l} className="border-r border-line" style={grow(l)}>
                      <Cell session={session} id={row.id} locale={l} showCode={false} version={version} editing={editId === row.id && editLocale === l} actions={actions} />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
