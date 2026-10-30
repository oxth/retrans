import { isApplicable } from "../core/plurals";
import type { ProjectSession } from "../core/session";
import type { KeyId } from "../core/model";
import { StatusDot } from "./StatusDot";
import { Warnings } from "./Warnings";

/** Display-only cell (editing arrives in a later task). Reads from the session; callers re-render on version change. */
export function Cell({ session, id, locale, showCode }: { session: ProjectSession; id: KeyId; locale: string; showCode: boolean }) {
  const isBase = locale === session.data.baseLocale;
  const code = showCode ? <span className="w-8 shrink-0 font-bold uppercase text-gray-500">{locale}</span> : null;

  if (!isApplicable(session.data, id, locale)) {
    return (
      <div className="flex items-center gap-2 rounded bg-gray-50 px-1.5 py-1 text-gray-400" data-cell="not-applicable">
        {code}
        <span className="italic">not used in {locale}</span>
      </div>
    );
  }
  const v = session.value(id, locale);
  if (!v) {
    return (
      <div className="flex items-center gap-2 rounded bg-red-50 px-1.5 py-1 italic text-red-600" data-cell="missing">
        {code}
        <StatusDot status="untranslated" needsReview={false} machine={false} />
        <span>Missing — click to translate</span>
      </div>
    );
  }
  const meta = session.meta(id, locale);
  const clickable = !isBase && (meta.status !== "reviewed" || meta.needsReview);
  return (
    <div className="flex items-start gap-2 rounded px-1.5 py-1" data-cell="value">
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
}
