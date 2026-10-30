import type { Status } from "../core/model";

const COLOR: Record<Status, string> = {
  untranslated: "bg-red-500",
  translated: "bg-yellow-400",
  reviewed: "bg-green-500",
};

export interface StatusDotProps {
  status: Status;
  needsReview: boolean;
  machine: boolean;
  /** Only set when clicking should mark the cell reviewed. */
  onClick?: () => void;
}

export function StatusDot({ status, needsReview, machine, onClick }: StatusDotProps) {
  const label = `${status}${needsReview ? ", needs review" : ""}${machine ? ", machine translated" : ""}`;
  const cls = `inline-block h-3 w-3 shrink-0 rounded-full ${COLOR[status]} ${needsReview ? "ring-2 ring-orange-400" : ""}`;
  const dot = <span data-status={status} data-needs-review={needsReview} className={cls} />;
  const ai = machine ? <span className="ml-0.5 text-[9px] font-bold leading-none text-indigo-600">AI</span> : null;
  if (!onClick) {
    return (
      <span className="inline-flex shrink-0 items-center" title={label} aria-label={`Status: ${label}`}>
        {dot}
        {ai}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="inline-flex shrink-0 items-center"
      title={`${label} — click to mark reviewed`}
      aria-label={`Mark reviewed (${label})`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {dot}
      {ai}
    </button>
  );
}
