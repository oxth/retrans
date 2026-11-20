import { memo, useEffect, useId, useRef } from "react";
import { isApplicable } from "../core/plurals";
import { READ_ONLY_MESSAGE, type ProjectSession } from "../core/session";
import { acceptDraft } from "../workspace/actions";
import { isTranslated, type KeyId } from "../core/model";
import { CellEditor } from "./CellEditor";
import { useSuggestion } from "./Suggestion";
import { Icon } from "./Icon";
import { NEEDS_REVIEW_TEXT, SOURCE_CHANGED, STATUS_TEXT, StatusDot } from "./StatusDot";
import { Warnings } from "./Warnings";
import { languageWithCode } from "./locales";

/** Stable callbacks owned by AppShell; every cell shares the same object. */
export interface EditActions {
  start: (id: KeyId, locale: string) => void;
  /** May throw; the editor shows the message inline. */
  commit: (id: KeyId, locale: string, text: string) => void;
  /** Writes accepted machine output (flagged as machine, never reviewed). May throw. */
  commitMachine: (id: KeyId, locale: string, text: string) => void;
  cancel: () => void;
  /** Opens the next missing cell; returns false (and closes the editor) when there is none. */
  next: (id: KeyId, locale: string) => boolean;
  /** Opens the previous missing cell; returns false (and closes the editor) when there is none. */
  prev: (id: KeyId, locale: string) => boolean;
  review: (id: KeyId, locale: string) => void;
  /** Reports an error that can no longer be shown inline (editor already unmounted). */
  error?: (message: string) => void;
}

export interface CellProps {
  session: ProjectSession;
  id: KeyId;
  locale: string;
  showCode: boolean;
  /** Session version: busts the memo when data changes (the session object itself is mutable). */
  version: number;
  editing: boolean;
  actions: EditActions;
}

/** Reads from the session; memoized on (id, locale, version, editing) so unrelated edits do not re-render every cell. */
export const Cell = memo(function Cell({ session, id, locale, showCode, editing, actions }: CellProps) {
  const el = useRef<HTMLDivElement>(null);
  const fitNoteId = useId();
  const refocus = useRef(false);
  useEffect(() => {
    if (editing) refocus.current = false;
    else if (refocus.current) {
      refocus.current = false;
      el.current?.focus();
    }
  });
  const isBase = locale === session.data.baseLocale;
  const suggestion = useSuggestion(session, id, locale, editing && !isBase);
  // The list view sets --code-w to fit its longest code (ZH-CN), so codes stay on one line and the text lines up.
  const code = showCode ? (
    <span className="shrink-0 whitespace-nowrap pt-px text-xs font-semibold uppercase leading-5 text-muted" style={{ width: "var(--code-w, 2rem)" }}>
      {locale}
    </span>
  ) : null;

  if (!isApplicable(session.data, id, locale)) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-panel px-1.5 py-1 text-muted" data-cell="not-applicable" data-locale={locale}>
        {code}
        <span className="italic">not used in {languageWithCode(locale)}</span>
      </div>
    );
  }
  const v = session.value(id, locale);
  const readOnly = session.readOnlyReason(id, locale);

  if (readOnly !== null) {
    // Computed in code (TypeScript source): shown, never edited here.
    return (
      <div className="flex items-start gap-2 rounded-md bg-panel px-1.5 py-1 text-muted" data-cell="read-only" data-locale={locale} title={readOnly}>
        {code}
        {v?.kind === "text" && <span className="min-w-0 whitespace-pre-wrap break-words">{v.text}</span>}
        <span className="italic">{READ_ONLY_MESSAGE}</span>
      </div>
    );
  }

  if (editing) {
    const complex = v?.kind === "complex";
    const initial = v ? (v.kind === "text" ? v.text : JSON.stringify(v.raw, null, 2)) : "";
    return (
      <div className="flex items-start gap-2 rounded-md px-1.5 py-1" data-cell="editing" data-locale={locale}>
        {code}
        <CellEditor
          id={id}
          locale={locale}
          initial={initial}
          complex={complex}
          onCommit={(t) => actions.commit(id, locale, t)}
          onCancel={actions.cancel}
          onFlushError={actions.error}
          suggestion={suggestion}
          onAcceptSuggestion={(t) => actions.commitMachine(id, locale, t)}
          onNextMissing={() => {
            if (!actions.next(id, locale)) refocus.current = true;
          }}
          onPrevMissing={() => {
            if (!actions.prev(id, locale)) refocus.current = true;
          }}
          onMarkReviewed={isBase ? undefined : () => isTranslated(session.value(id, locale)) && actions.review(id, locale)}
          onRefocus={() => {
            refocus.current = true;
          }}
        />
      </div>
    );
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "r") {
      e.preventDefault();
      if (isTranslated(v) && !isBase) actions.review(id, locale);
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      actions.start(id, locale);
    }
  };

  // A named group, not a button: it holds its own buttons (Review, Accept draft). Enter or F2 edits.
  const cellLabel = `${languageWithCode(locale)} translation of ${id}`;

  if (!v || !isTranslated(v)) {
    const draft = session.workspace?.drafts[id]?.[locale];
    return (
      <div
        className="flex cursor-text flex-wrap items-center gap-2 rounded-md border border-dashed border-line-strong px-1.5 py-1 text-fg-2 hover:bg-hover"
        data-cell="missing"
        ref={el}
        data-locale={locale}
        tabIndex={0}
        role="group"
        aria-label={`${cellLabel}: missing`}
        aria-keyshortcuts="Enter F2"
        onClick={() => actions.start(id, locale)}
        onKeyDown={onKeyDown}
      >
        {code}
        <StatusDot status="untranslated" needsReview={false} machine={false} />
        <span>{v ? "Missing (empty string in file) — click to translate" : "Missing — click to translate"}</span>
        {draft !== undefined && (
          <span className="flex basis-full items-center gap-2 text-fg-2" data-draft>
            <span className="min-w-0 whitespace-pre-wrap break-words">Draft: {draft}</span>
            <button
              className="shrink-0 rounded-md border border-line-strong bg-surface px-2 py-0.5 text-xs font-medium text-fg hover:bg-hover"
              onClick={(e) => {
                e.stopPropagation();
                try {
                  acceptDraft(session, id, locale);
                } catch (err) {
                  actions.error?.(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              Accept draft
            </button>
          </span>
        )}
      </div>
    );
  }
  const meta = session.meta(id, locale);
  const reviewable = !isBase && (meta.status !== "reviewed" || meta.needsReview);
  const warnings = session.warnings(id, locale);
  const fit = isBase ? null : session.fitOf(id, locale);
  const statusLabel = `${STATUS_TEXT[meta.status]}${meta.needsReview ? `; ${NEEDS_REVIEW_TEXT}` : ""}`;
  // Review stays in view only where it needs attention (source changed); elsewhere it appears on hover or focus.
  const reviewButton = (overlay: boolean) => (
    <button
      type="button"
      aria-label={`Mark reviewed (${statusLabel})`}
      title="Mark reviewed (⌘⇧R / Ctrl+Shift+R)"
      data-review={overlay ? "hover" : "pinned"}
      className={`inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md border bg-surface px-1.5 text-xs font-medium hover:border-ok hover:bg-ok-soft hover:text-ok ${
        meta.needsReview ? "border-warn-line text-fg" : "border-line-strong text-fg-2"
      } ${overlay ? "invisible absolute right-1 top-1 group-hover/cell:visible group-focus-within/cell:visible" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        actions.review(id, locale);
      }}
    >
      <Icon name="check" size={13} />
      Review
    </button>
  );
  const pinnedReview = reviewable && meta.needsReview;
  const fitsMark = fit?.v === "fits" && (
    <span role="img" aria-label="Designer: fits" title="A designer checked this fits in the Figma preview." className="inline-flex align-[-2px] text-ok">
      <Icon name="check" size={13} />
    </span>
  );
  // In a table column the small "fits" check stays beside the text; only the wider badges drop below it.
  // The small "fits" check stays beside the text in both views; only the wider badges go to the side or below.
  const hasMarks = pinnedReview || warnings.length > 0 || fit?.v === "too-long";
  const marks = (
    <>
      <Warnings warnings={warnings} />
      {fit?.v === "too-long" && (
        <span
          data-fit="too-long"
          aria-describedby={fitNoteId}
          className="rounded bg-warn-soft px-1.5 text-xs font-medium leading-5 text-warn"
          title={fit.note ? `Designer: ${fit.note}` : "A designer found this too long in the Figma preview."}
        >
          Too long
          {!fit.note && <span id={fitNoteId} hidden>A designer found this too long in the Figma preview.</span>}
        </span>
      )}
      {pinnedReview && (
        <>
          <span
            className="rounded bg-warn-soft px-1.5 text-xs font-medium leading-5 text-warn"
            title="The base text changed after this was translated. Check the translation still fits, then mark it reviewed."
          >
            {SOURCE_CHANGED}
          </span>
          {reviewButton(false)}
        </>
      )}
    </>
  );
  return (
    <div
      className="group/cell relative flex cursor-text items-start gap-2 rounded-md border border-transparent px-1.5 py-1 hover:border-line hover:bg-hover"
      data-cell="value"
      data-reviewable={reviewable || undefined}
      ref={el}
      data-locale={locale}
      tabIndex={0}
      role="group"
      aria-label={`${cellLabel}: ${v.kind === "text" ? v.text : "complex message"}${isBase ? "" : ` (${statusLabel})`}`}
      aria-keyshortcuts={isBase ? "Enter F2" : "Enter F2 Control+Shift+R Meta+Shift+R"}
      aria-describedby={fit?.v === "too-long" || fit?.note ? fitNoteId : undefined}
      onClick={() => actions.start(id, locale)}
      onKeyDown={onKeyDown}
    >
      {code}
      {!isBase && (
        <span className="flex h-5 items-center">
          <StatusDot status={meta.status} needsReview={meta.needsReview} machine={meta.machine} />
        </span>
      )}
      {/* Badges float top-right in the list (wide rows); in a table column they go under the text so it keeps the width. */}
      <div className="min-w-0 flex-1">
        {hasMarks && showCode && <span className="float-right ml-2 flex items-center gap-1.5">{marks}</span>}
        {v.kind === "text" ? (
          <span className="whitespace-pre-wrap break-words">{v.text}</span>
        ) : (
          <span className="italic text-muted">complex message</span>
        )}
        {fitsMark && <> {fitsMark}</>}
        {hasMarks && !showCode && <div className="mt-1 flex flex-wrap items-center gap-1.5">{marks}</div>}
        {/* The designer's note from the Figma preview, on the cell so it reads without hovering. */}
        {fit?.note && (
          <p id={fitNoteId} className={`mt-0.5 whitespace-pre-wrap break-words text-xs ${fit.v === "too-long" ? "text-warn" : "text-muted"}`}>
            Designer: {fit.note}
          </p>
        )}
      </div>
      {reviewable && !meta.needsReview && reviewButton(true)}
    </div>
  );
});
