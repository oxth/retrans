import { useMemo, useState } from "react";
import { type MessageValue, parseKeyId } from "../core/model";
import type { ProjectSession } from "../core/session";
import { applyImport, type ImportDiff } from "../package/diff";
import { btnGhost, btnPrimary, Dialog } from "./Dialog";

/** The list renders at most this many rows (conflicts first); the rest are counted in a note. */
export const MAX_ROWS = 300;

const show = (v: MessageValue | undefined): string =>
  !v ? "(empty)" : v.kind === "text" ? v.text || "(empty)" : JSON.stringify(v.raw);

export function ImportDialog({ session, diff, onClose, onApplied }: {
  session: ProjectSession;
  diff: ImportDiff;
  onClose: () => void;
  onApplied: (count: number) => void;
}) {
  const [picks, setPicks] = useState<Map<string, "mine" | "theirs">>(new Map());
  const [error, setError] = useState<string | null>(null);
  const apply = () => {
    let n: number;
    try {
      n = applyImport(session, diff, picks);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    onApplied(n);
  };
  const items = useMemo(
    () => [...diff.items].sort((a, b) => Number(b.kind === "conflict") - Number(a.kind === "conflict")),
    [diff],
  );
  const count = (k: string) => diff.items.filter((i) => i.kind === k).length;
  const conflicts = diff.items.filter((i) => i.kind === "conflict");
  const keyOf = (i: { id: string; locale: string }) => `${i.id}|${i.locale}`;
  const setAll = (p: "mine" | "theirs") => setPicks(new Map(conflicts.map((i) => [keyOf(i), p])));

  if (diff.items.length === 0) {
    return (
      <Dialog title="Import translator work" onClose={onClose}>
        <p className="mb-4 text-sm">Nothing to import.</p>
        {diff.otherProject && <Warn>This package came from a different project. Matching keys will still be merged.</Warn>}
        <div className="flex justify-end">
          <button className={btnPrimary} onClick={onClose}>Close</button>
        </div>
      </Dialog>
    );
  }

  const shown = items.slice(0, MAX_ROWS);
  return (
    <Dialog title="Import translator work" onClose={onClose} wide>
      <p className="mb-3 flex flex-wrap gap-x-3 text-sm text-fg-2">
        <span>{count("new")} new</span>
        <span>{count("changed")} changed</span>
        <span>{count("status")} status only</span>
        <span>{conflicts.length} conflicts</span>
        <span>{diff.skipped.length} skipped</span>
      </p>
      {diff.otherProject && <Warn>This package came from a different project. Matching keys will still be merged.</Warn>}
      {!diff.hasManifest && <Warn>No package info: only values are merged.</Warn>}
      {conflicts.length > 0 && (
        <div className="mb-2 flex gap-2">
          <button className={btnGhost} onClick={() => setAll("theirs")}>Use theirs for all conflicts</button>
          <button className={btnGhost} onClick={() => setAll("mine")}>Keep mine for all</button>
        </div>
      )}
      <ul className="mb-3 max-h-80 divide-y divide-line overflow-auto rounded border border-line text-sm">
        {shown.map((i) => {
          const { ns, key } = parseKeyId(i.id);
          const k = keyOf(i);
          const pick = picks.get(k) ?? "mine";
          return (
            <li key={k} className="px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-mono text-xs">{ns ? `${ns}: ${key}` : key}</span>
                <span className="shrink-0 text-xs font-semibold uppercase text-muted">{i.locale}</span>
              </div>
              <div className="break-words text-fg-2">
                {i.kind === "status" ? "status only" : `${show(i.mine)} → ${show(i.theirs)}`}
              </div>
              {i.kind === "conflict" && (
                <div className="mt-1 flex gap-4 text-xs">
                  {(["mine", "theirs"] as const).map((p) => (
                    <label key={p} className="flex items-center gap-1">
                      <input
                        type="radio"
                        name={`pick-${k}`}
                        checked={pick === p}
                        onChange={() => setPicks((m) => new Map(m).set(k, p))}
                      />
                      {p === "mine" ? "Keep mine" : "Use theirs"}
                    </label>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {items.length > shown.length && (
        <p className="mb-3 text-xs text-muted">+{items.length - shown.length} more (applied the same way)</p>
      )}
      {error && <p role="alert" className="mb-3 rounded bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose}>Cancel</button>
        <button className={btnPrimary} onClick={apply}>Apply</button>
      </div>
    </Dialog>
  );
}

function Warn({ children }: { children: string }) {
  return <p className="mb-2 rounded bg-warn-soft px-3 py-2 text-xs text-warn">{children}</p>;
}
