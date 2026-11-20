import type { Status } from "../core/model";

/** Not reviewed is a ring, the others are filled: the states differ by shape, not only by colour. */
const COLOR: Record<Status, string> = {
  untranslated: "bg-st-missing",
  translated: "border-2 border-st-translated",
  reviewed: "bg-st-reviewed",
};

/** Plain-language names for each state, shared by the dots and the sidebar's status key. */
export const STATUS_TEXT: Record<Status, string> = {
  untranslated: "Missing",
  translated: "Not reviewed",
  reviewed: "Reviewed",
};
export const NEEDS_REVIEW_TEXT = "the base text changed after this was translated";
/** Short name for that state: the base (source) text changed, so the translation may be out of date. */
export const SOURCE_CHANGED = "Source changed";

export interface StatusDotProps {
  status: Status;
  needsReview: boolean;
  machine: boolean;
  /** Only set when clicking should mark the cell reviewed. */
  onClick?: () => void;
}

export function StatusDot({ status, needsReview, machine, onClick }: StatusDotProps) {
  const label = `${STATUS_TEXT[status]}${needsReview ? `; ${NEEDS_REVIEW_TEXT}` : ""}${machine ? "; machine translated" : ""}`;
  const cls = `inline-block h-2.5 w-2.5 shrink-0 rounded-full ${COLOR[status]} ${needsReview ? "ring-2 ring-warn-solid ring-offset-1 ring-offset-surface" : ""}`;
  const dot = <span data-status={status} data-needs-review={needsReview} className={cls} />;
  const ai = machine ? <span className="ml-1 rounded bg-sunken px-1 text-xs font-medium leading-4 text-fg-2">AI</span> : null;
  if (!onClick) {
    return (
      <span role="img" className="inline-flex shrink-0 items-center" title={label} aria-label={`Status: ${label}`}>
        {dot}
        {ai}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="-m-1 inline-flex shrink-0 items-center rounded-full p-1 hover:bg-sunken"
      title={`${label}. Click to mark reviewed`}
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
