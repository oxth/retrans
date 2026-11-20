/**
 * Reads a designer's results file back: a verdict is kept only for text that is still exactly what
 * the designer saw, so it never lands on a translation that changed since.
 */
import { hashValue } from "../core/hash";
import type { ProjectSession } from "../core/session";
import type { PreviewResult, PreviewResults } from "./format";

export interface ResultsDiff {
  locale: string;
  otherProject: boolean;
  apply: PreviewResult[];
  changedSinceChecked: number;
  missingKeys: number;
  /** Results the file had but that couldn't be read. */
  unreadable: number;
  tooLong: number;
  fits: number;
}

export function diffResults(session: ProjectSession, r: PreviewResults, unreadable = 0): { ok: true; diff: ResultsDiff } | { ok: false; error: string } {
  const { baseLocale, locales } = session.data;
  if (r.locale === baseLocale) return { ok: false, error: `These results are for ${r.locale}, the base language.` };
  if (!locales.includes(r.locale)) return { ok: false, error: `This project has no ${r.locale} language.` };
  const keys = new Set(session.data.keyOrder);
  const diff: ResultsDiff = {
    locale: r.locale,
    otherProject: r.sourceProjectId !== session.state.project.id,
    apply: [],
    changedSinceChecked: 0,
    missingKeys: 0,
    unreadable,
    tooLong: 0,
    fits: 0,
  };
  for (const res of r.results) {
    if (!keys.has(res.key)) diff.missingKeys++;
    else if (res.hash !== hashValue(session.value(res.key, r.locale))) diff.changedSinceChecked++;
    else {
      diff.apply.push(res);
      if (res.verdict === "too-long") diff.tooLong++;
      else diff.fits++;
    }
  }
  return { ok: true, diff };
}

export function applyResults(session: ProjectSession, d: ResultsDiff): number {
  for (const r of d.apply) session.setFit(r.key, d.locale, r.note ? { v: r.verdict, h: r.hash, note: r.note } : { v: r.verdict, h: r.hash });
  return d.apply.length;
}
