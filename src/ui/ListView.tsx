import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import type { Row } from "../core/rows";
import type { ProjectSession } from "../core/session";
import { Cell, type EditActions } from "./Cell";
import { RowMenu } from "./RowMenu";
import { Icon } from "./Icon";
import { isUnmappedFigmaRow } from "../figma/meta";
import { RowWarnings } from "./Warnings";
import { duplicateGroups } from "../workspace/actions";

export interface ViewProps {
  session: ProjectSession;
  rows: Row[];
  locales: string[];
  version: number;
  editing: { id: string; locale: string } | null;
  actions: EditActions;
  onRowAction?: (row: Row, action: RowAction) => void;
}

export type RowAction = "rename" | "delete" | "keep" | "code-key" | "link";

/** A Figma string that has no code key yet (still in its Figma group). */
export const isFigmaRow = (session: ProjectSession, id: string) =>
  !!session.workspace?.figma && isUnmappedFigmaRow(session.workspace, id);

/** The row badge for a Figma string with no code key yet. */
/** Shown when the search and filters leave no rows. */
export const NoMatches = () => (
  <div className="flex flex-col items-center gap-2 px-8 py-16 text-center">
    <span className="rounded-full bg-sunken p-3 text-muted"><Icon name="filterX" size={20} /></span>
    <p className="text-sm font-medium text-fg">No keys match.</p>
    <p className="text-xs text-muted">Try a different search, or turn off some filters.</p>
  </div>
);

export const NoCodeKeyBadge = () => <span className="rounded bg-info-soft px-1.5 text-info">No code key yet</span>;

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
  if (!rows.length) return <NoMatches />;
  return (
    <div ref={parent} className="h-full overflow-auto" data-testid="list-scroll">
      <div style={{ height: virt.getTotalSize(), position: "relative" }}>
        {virt.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          const base = session.value(row.id, session.data.baseLocale);
          const removed = isRemovedInSource(session, row.id);
          const figmaRow = isFigmaRow(session, row.id);
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virt.measureElement}
              className="group/row absolute left-0 top-0 flex w-full border-b border-line py-2.5 text-sm hover:bg-panel/60"
              style={{ transform: `translateY(${vi.start}px)` }}
              data-row={row.id}
            >
              <div className="w-1/3 min-w-48 max-w-sm shrink-0 pl-4 pr-3">
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
                <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted">
                  {row.ns && <span>{row.ns}</span>}
                  {row.pluralGroup && (
                    <span className="rounded bg-brand-soft px-1.5 text-brand-ink">plural · {row.pluralCategory}</span>
                  )}
                  {base?.kind === "complex" && <span className="rounded bg-sunken px-1.5 text-muted">complex</span>}
                  {figmaRow && <NoCodeKeyBadge />}
                  <RowWarnings duplicateOf={duplicateGroups(session, row.id)} removedInSource={removed} />
                </div>
              </div>
              <div className="min-w-0 flex-1 space-y-0.5 pr-4">
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
