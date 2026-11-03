import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import type { Row } from "../core/rows";
import type { ProjectSession } from "../core/session";
import { Cell, type EditActions } from "./Cell";
import { RowMenu } from "./RowMenu";
import { RowWarnings } from "./Warnings";
import { duplicateGroups } from "../workspace/actions";

export interface ViewProps {
  session: ProjectSession;
  rows: Row[];
  locales: string[];
  version: number;
  editing: { id: string; locale: string } | null;
  actions: EditActions;
  onRowAction?: (row: Row, action: "rename" | "delete" | "keep") => void;
}

/** True when this workspace row's key was removed from the TypeScript source. */
export const isRemovedInSource = (session: ProjectSession, id: string) => !!session.workspace?.removedInSource.includes(id);

export function ListView({ session, rows, locales, version, editing, actions, onRowAction }: ViewProps) {
  const parent = useRef<HTMLDivElement>(null);
  const cols = [session.data.baseLocale, ...locales];
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => cols.length * 30 + 16,
    overscan: 8,
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
  if (!rows.length) return <div className="p-8 text-center text-sm text-gray-500">No keys match.</div>;
  return (
    <div ref={parent} className="h-full overflow-auto" data-testid="list-scroll">
      <div style={{ height: virt.getTotalSize(), position: "relative" }}>
        {virt.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          const base = session.value(row.id, session.data.baseLocale);
          const removed = isRemovedInSource(session, row.id);
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virt.measureElement}
              className="absolute left-0 top-0 flex w-full border-b border-gray-100 py-2 text-sm"
              style={{ transform: `translateY(${vi.start}px)` }}
              data-row={row.id}
            >
              <div className="w-1/3 shrink-0 px-3">
                <div className="flex items-start gap-1">
                  <div className="min-w-0 flex-1 break-all font-mono font-semibold text-gray-700">{row.key}</div>
                  {onRowAction && (
                    <RowMenu
                      name={row.key}
                      onRename={() => onRowAction(row, "rename")}
                      onDelete={() => onRowAction(row, "delete")}
                      onKeep={removed ? () => onRowAction(row, "keep") : undefined}
                    />
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-gray-400">
                  {row.ns && <span>{row.ns}</span>}
                  {row.pluralGroup && (
                    <span className="rounded bg-indigo-50 px-1 text-indigo-700">plural · {row.pluralCategory}</span>
                  )}
                  {base?.kind === "complex" && <span className="rounded bg-gray-100 px-1 text-gray-600">complex</span>}
                  <RowWarnings duplicateOf={duplicateGroups(session, row.id)} removedInSource={removed} />
                </div>
              </div>
              <div className="min-w-0 flex-1 space-y-0.5 pr-3">
                {cols.map((l) => (
                  <Cell
                    key={l}
                    session={session}
                    id={row.id}
                    locale={l}
                    showCode
                    version={version}
                    editing={editId === row.id && editLocale === l}
                    actions={actions}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
