import type { Warning } from "../core/model";
import { Icon } from "./Icon";

export function warningText(w: Warning): string {
  switch (w.kind) {
    case "placeholder-missing":
      return `Missing placeholders: ${(w.names ?? []).join(", ")}`;
    case "placeholder-extra":
      return `Extra placeholders: ${(w.names ?? []).join(", ")}`;
    case "orphan":
      return "orphan: not in base language";
  }
}

/** Row-level marks of a workspace row: a duplicate key, and a key removed from the TypeScript source. */
export function RowWarnings({ duplicateOf, removedInSource }: { duplicateOf: string[]; removedInSource: boolean }) {
  if (!duplicateOf.length && !removedInSource) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {duplicateOf.length > 0 && (
        <span className="inline-flex items-center gap-1 rounded bg-warn-soft px-1.5 text-warn" role="note">
          <Icon name="alert" size={11} />
          Duplicate key — also in {duplicateOf.join(", ")}
        </span>
      )}
      {removedInSource && <span className="rounded bg-sunken px-1.5 text-fg-2">Removed in source</span>}
    </span>
  );
}

export function Warnings({ warnings }: { warnings: Warning[] }) {
  if (!warnings.length) return null;
  const text = warnings.map(warningText).join("\n");
  return (
    <span role="img" aria-label={text} title={text} className="ml-1 mt-0.5 shrink-0 cursor-help text-warn">
      <Icon name="alert" size={14} />
    </span>
  );
}
