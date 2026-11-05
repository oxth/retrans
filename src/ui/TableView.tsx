import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { Cell } from "./Cell";
import { RowMenu } from "./RowMenu";
import { isRemovedInSource, type ViewProps, isFigmaRow, NoCodeKeyBadge, NoMatches } from "./ListView";
import { RowWarnings } from "./Warnings";
import { duplicateGroups } from "../workspace/actions";

const KEY_W = 220;
const COL_W = 260;
/** Fixed height of the sticky header; the virtualizer needs it as scrollMargin so the visible range is right. */
const HEADER_H = 32;

export function TableView({ session, rows, locales, version, editing, actions, onRowAction }: ViewProps) {
  const parent = useRef<HTMLDivElement>(null);
  const base = session.data.baseLocale;
  const width = KEY_W + COL_W * (locales.length + 1);
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
  return (
    <div ref={parent} className="h-full overflow-auto text-sm" data-testid="table-scroll">
      <div style={{ width, minWidth: "100%" }}>
        <div style={{ height: HEADER_H }}
          className="sticky top-0 z-10 flex items-center border-b border-line bg-panel text-xs font-semibold uppercase tracking-wide text-muted">
          <div className="shrink-0 bg-panel px-3 py-1.5" style={{ width: KEY_W, ...pin(0), zIndex: 11 }}>Key</div>
          <div className="shrink-0 border-r border-line bg-panel px-2 py-1.5" style={{ width: COL_W, ...pin(KEY_W), zIndex: 11 }}>
            {base.toUpperCase()} <span className="font-normal normal-case text-muted">(base)</span>
          </div>
          {locales.map((l) => (
            <div key={l} className="shrink-0 border-r border-line px-2 py-1.5" style={{ width: COL_W }}>{l.toUpperCase()}</div>
          ))}
        </div>
        {!rows.length ? (
          <NoMatches />
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
                  style={{ transform: `translateY(${vi.start - HEADER_H}px)`, width }}
                  data-row={row.id}
                >
                  <div className="shrink-0 border-r border-line bg-surface px-3 py-1.5" style={{ width: KEY_W, ...pin(0) }}>
                    <div className="flex items-start gap-1">
                      <div className="min-w-0 flex-1 break-all pt-1 font-mono text-[13px] font-medium text-fg">{row.key}</div>
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
                    {row.ns && <div className="mt-0.5 text-[11px] text-muted">{row.ns}</div>}
                    <div className="mt-0.5 text-[11px]">
                      {figmaRow && <NoCodeKeyBadge />}
                      <RowWarnings duplicateOf={duplicateGroups(session, row.id)} removedInSource={removed} />
                    </div>
                  </div>
                  <div className="shrink-0 border-r border-line bg-surface" style={{ width: COL_W, ...pin(KEY_W) }}>
                    <Cell session={session} id={row.id} locale={base} showCode={false} version={version} editing={editId === row.id && editLocale === base} actions={actions} />
                  </div>
                  {locales.map((l) => (
                    <div key={l} className="shrink-0 border-r border-line" style={{ width: COL_W }}>
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
