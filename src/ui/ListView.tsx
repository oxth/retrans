import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import type { Row } from "../core/rows";
import type { ProjectSession } from "../core/session";
import { Cell } from "./Cell";

export function ListView({ session, rows, locales }: { session: ProjectSession; rows: Row[]; locales: string[] }) {
  const parent = useRef<HTMLDivElement>(null);
  const cols = [session.data.baseLocale, ...locales];
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => cols.length * 30 + 16,
    overscan: 8,
    getItemKey: (i) => rows[i].id,
  });
  if (!rows.length) return <div className="p-8 text-center text-sm text-gray-500">No keys match.</div>;
  return (
    <div ref={parent} className="h-full overflow-auto" data-testid="list-scroll">
      <div style={{ height: virt.getTotalSize(), position: "relative" }}>
        {virt.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          const base = session.value(row.id, session.data.baseLocale);
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
                <div className="break-all font-mono font-semibold text-gray-700">{row.key}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-gray-400">
                  {row.ns && <span>{row.ns}</span>}
                  {row.pluralGroup && (
                    <span className="rounded bg-indigo-50 px-1 text-indigo-700">plural · {row.pluralCategory}</span>
                  )}
                  {base?.kind === "complex" && <span className="rounded bg-gray-100 px-1 text-gray-600">complex</span>}
                </div>
              </div>
              <div className="min-w-0 flex-1 space-y-0.5 pr-3">
                {cols.map((l) => (
                  <Cell key={l} session={session} id={row.id} locale={l} showCode />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
