import { memo, useEffect, useRef } from "react";
import { isApplicable } from "../core/plurals";
import { READ_ONLY_MESSAGE, type ProjectSession } from "../core/session";
import { acceptDraft } from "../workspace/actions";
import { isTranslated, type KeyId } from "../core/model";
import { CellEditor } from "./CellEditor";
import { useSuggestion } from "./Suggestion";
import { Icon } from "./Icon";
import { NEEDS_REVIEW_TEXT, SOURCE_CHANGED, STATUS_TEXT, StatusDot } from "./StatusDot";
import { Warnings } from "./Warnings";

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
  const code = showCode ? <span className="w-8 shrink-0 pt-px text-xs font-semibold uppercase leading-5 text-muted">{locale}</span> : null;

  if (!isApplicable(session.data, id, locale)) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-panel px-1.5 py-1 text-muted" data-cell="not-applicable" data-locale={locale}>
        {code}
        <span className="italic">not used in {locale}</span>
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

  if (!v || !isTranslated(v)) {
    const draft = session.workspace?.drafts[id]?.[locale];
    return (
      <div
        className="flex cursor-text flex-wrap items-center gap-2 rounded-md border border-dashed border-danger-line px-1.5 py-1 text-danger hover:bg-danger-soft"
        data-cell="missing"
        ref={el}
        data-locale={locale}
        tabIndex={0}
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
  const statusLabel = `${STATUS_TEXT[meta.status]}${meta.needsReview ? `; ${NEEDS_REVIEW_TEXT}` : ""}`;
  return (
    <div
      className="group/cell flex cursor-text items-start gap-2 rounded-md border border-transparent px-1.5 py-1 hover:border-line hover:bg-hover"
      data-cell="value"
      ref={el}
      data-locale={locale}
      tabIndex={0}
      onClick={() => actions.start(id, locale)}
      onKeyDown={onKeyDown}
    >
      {code}
      {!isBase && (
        <span className="flex h-5 items-center">
          <StatusDot status={meta.status} needsReview={meta.needsReview} machine={meta.machine} />
        </span>
      )}
      {v.kind === "text" ? (
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{v.text}</span>
      ) : (
        <span className="flex-1 italic text-muted">complex message</span>
      )}
      <Warnings warnings={session.warnings(id, locale)} />
      {reviewable && (
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {meta.needsReview && (
            <span
              className="rounded bg-warn-soft px-1.5 text-[11px] font-medium leading-5 text-warn"
              title="The base text changed after this was translated. Check the translation still fits, then mark it reviewed."
            >
              {SOURCE_CHANGED}
            </span>
          )}
          <button
            type="button"
            aria-label={`Mark reviewed (${statusLabel})`}
            title="Mark reviewed (⌘⇧R / Ctrl+Shift+R)"
            className={`inline-flex items-center gap-1 rounded-md px-1.5 text-xs font-medium leading-5 ${
              meta.needsReview
                ? "border border-warn-line bg-surface text-fg hover:bg-ok-soft hover:text-ok"
                : "text-muted hover:bg-ok-soft hover:text-ok group-hover/cell:text-fg-2"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              actions.review(id, locale);
            }}
          >
            <Icon name="check" size={13} />
            Review
          </button>
        </span>
      )}
    </div>
  );
});
