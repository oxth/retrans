import { memo } from "react";
import { isApplicable } from "../core/plurals";
import type { ProjectSession } from "../core/session";
import type { KeyId } from "../core/model";
import { CellEditor } from "./CellEditor";
import { StatusDot } from "./StatusDot";
import { Warnings } from "./Warnings";

/** Stable callbacks owned by AppShell; every cell shares the same object. */
export interface EditActions {
  start: (id: KeyId, locale: string) => void;
  /** May throw; the editor shows the message inline. */
  commit: (id: KeyId, locale: string, text: string) => void;
  cancel: () => void;
  next: (id: KeyId, locale: string) => void;
  review: (id: KeyId, locale: string) => void;
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
  const isBase = locale === session.data.baseLocale;
  const code = showCode ? <span className="w-8 shrink-0 font-bold uppercase text-gray-500">{locale}</span> : null;

  if (!isApplicable(session.data, id, locale)) {
    return (
      <div className="flex items-center gap-2 rounded bg-gray-50 px-1.5 py-1 text-gray-400" data-cell="not-applicable" data-locale={locale}>
        {code}
        <span className="italic">not used in {locale}</span>
      </div>
    );
  }
  const v = session.value(id, locale);

  if (editing) {
    const complex = v?.kind === "complex";
    const initial = v ? (v.kind === "text" ? v.text : JSON.stringify(v.raw, null, 2)) : "";
    return (
      <div className="flex items-start gap-2 rounded px-1.5 py-1" data-cell="editing" data-locale={locale}>
        {code}
        <CellEditor
          id={id}
          locale={locale}
          initial={initial}
          complex={complex}
          onCommit={(t) => actions.commit(id, locale, t)}
          onCancel={actions.cancel}
          onNextMissing={() => actions.next(id, locale)}
          onMarkReviewed={isBase ? undefined : () => actions.review(id, locale)}
        />
      </div>
    );
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "r") {
      e.preventDefault();
      if (v && !isBase) actions.review(id, locale);
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      actions.start(id, locale);
    }
  };

  if (!v) {
    return (
      <div
        className="flex cursor-text items-center gap-2 rounded bg-red-50 px-1.5 py-1 italic text-red-600"
        data-cell="missing"
        data-locale={locale}
        tabIndex={0}
        onClick={() => actions.start(id, locale)}
        onKeyDown={onKeyDown}
      >
        {code}
        <StatusDot status="untranslated" needsReview={false} machine={false} />
        <span>Missing — click to translate</span>
      </div>
    );
  }
  const meta = session.meta(id, locale);
  const clickable = !isBase && (meta.status !== "reviewed" || meta.needsReview);
  return (
    <div
      className="flex cursor-text items-start gap-2 rounded px-1.5 py-1"
      data-cell="value"
      data-locale={locale}
      tabIndex={0}
      onClick={() => actions.start(id, locale)}
      onKeyDown={onKeyDown}
    >
      {code}
      {!isBase && (
        <span className="mt-1">
          <StatusDot
            status={meta.status}
            needsReview={meta.needsReview}
            machine={meta.machine}
            onClick={clickable ? () => session.markReviewed(id, locale) : undefined}
          />
        </span>
      )}
      {v.kind === "text" ? (
        <span className="min-w-0 whitespace-pre-wrap break-words">{v.text}</span>
      ) : (
        <span className="italic text-gray-500">complex message</span>
      )}
      <Warnings warnings={session.warnings(id, locale)} />
    </div>
  );
});
