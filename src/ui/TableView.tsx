import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import type { Row } from "../core/rows";
import type { ProjectSession } from "../core/session";
import { Cell } from "./Cell";

const KEY_W = 220;
const COL_W = 260;

export function TableView({ session, rows, locales }: { session: ProjectSession; rows: Row[]; locales: string[] }) {
  const parent = useRef<HTMLDivElement>(null);
  const base = session.data.baseLocale;
  const width = KEY_W + COL_W * (locales.length + 1);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 44,
    overscan: 10,
    getItemKey: (i) => rows[i].id,
  });
  const pin = (left: number) => ({ position: "sticky" as const, left, zIndex: 1 });
  return (
    <div ref={parent} className="h-full overflow-auto text-sm" data-testid="table-scroll">
      <div style={{ width, minWidth: "100%" }}>
        <div className="sticky top-0 z-10 flex border-b border-gray-200 bg-gray-50 text-xs font-semibold text-gray-500">
          <div className="shrink-0 bg-gray-50 px-2 py-1.5" style={{ width: KEY_W, ...pin(0), zIndex: 11 }}>Key</div>
          <div className="shrink-0 border-r border-gray-100 bg-gray-50 px-2 py-1.5" style={{ width: COL_W, ...pin(KEY_W), zIndex: 11 }}>
            {base.toUpperCase()} (base)
          </div>
          {locales.map((l) => (
            <div key={l} className="shrink-0 border-r border-gray-100 px-2 py-1.5" style={{ width: COL_W }}>{l.toUpperCase()}</div>
          ))}
        </div>
        {!rows.length ? (
          <div className="p-8 text-center text-gray-500">No keys match.</div>
        ) : (
          <div style={{ height: virt.getTotalSize(), position: "relative" }}>
            {virt.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virt.measureElement}
                  className="absolute left-0 top-0 flex border-b border-gray-100"
                  style={{ transform: `translateY(${vi.start}px)`, width }}
                  data-row={row.id}
                >
                  <div className="shrink-0 bg-white px-2 py-1.5" style={{ width: KEY_W, ...pin(0) }}>
                    <div className="break-all font-mono font-semibold text-gray-700">{row.key}</div>
                    {row.ns && <div className="text-[10px] text-gray-400">{row.ns}</div>}
                  </div>
                  <div className="shrink-0 border-r border-gray-100 bg-white" style={{ width: COL_W, ...pin(KEY_W) }}>
                    <Cell session={session} id={row.id} locale={base} showCode={false} />
                  </div>
                  {locales.map((l) => (
                    <div key={l} className="shrink-0 border-r border-gray-100" style={{ width: COL_W }}>
                      <Cell session={session} id={row.id} locale={l} showCode={false} />
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
