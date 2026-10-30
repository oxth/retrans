import type { Warning } from "../core/model";

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

export function Warnings({ warnings }: { warnings: Warning[] }) {
  if (!warnings.length) return null;
  const text = warnings.map(warningText).join("\n");
  return (
    <span role="img" aria-label={text} title={text} className="ml-1 shrink-0 cursor-help text-amber-600">
      ⚠
    </span>
  );
}
