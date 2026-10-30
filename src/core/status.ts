import { hashValue } from "./hash";
import { type CellMeta, isTranslated, type KeyId, type ProjectData } from "./model";
import type { StateFile } from "./state-file";

export function cellMeta(data: ProjectData, s: StateFile, id: KeyId, locale: string): CellMeta {
  const cells = data.values.get(id);
  const value = cells?.get(locale);
  if (locale === data.baseLocale) {
    return { status: isTranslated(value) ? "translated" : "untranslated", needsReview: false, machine: false };
  }
  if (!isTranslated(value)) return { status: "untranslated", needsReview: false, machine: false };
  const entry = s.entries[id]?.[locale];
  if (!entry) return { status: "translated", needsReview: false, machine: false };
  return {
    status: entry.s,
    machine: !!entry.m,
    needsReview: entry.h !== hashValue(cells?.get(data.baseLocale)),
  };
}

function baseHash(data: ProjectData, id: KeyId): string {
  return hashValue(data.values.get(id)?.get(data.baseLocale));
}

export function recordEdit(data: ProjectData, s: StateFile, id: KeyId, locale: string, machine: boolean): void {
  if (locale === data.baseLocale) return;
  (s.entries[id] ??= {})[locale] = machine
    ? { s: "translated", h: baseHash(data, id), m: true }
    : { s: "translated", h: baseHash(data, id) };
}

export function recordReviewed(data: ProjectData, s: StateFile, id: KeyId, locale: string): void {
  if (locale === data.baseLocale || !isTranslated(data.values.get(id)?.get(locale))) return;
  (s.entries[id] ??= {})[locale] = { s: "reviewed", h: baseHash(data, id) };
}

export function recordCleared(s: StateFile, id: KeyId, locale: string): void {
  const cells = s.entries[id];
  if (!cells) return;
  delete cells[locale];
  if (Object.keys(cells).length === 0) delete s.entries[id];
}

export function renameInState(s: StateFile, from: KeyId, to: KeyId): void {
  const cells = s.entries[from];
  if (!cells) return;
  delete s.entries[from];
  s.entries[to] = cells;
}
