/**
 * Undo/redo for a ProjectSession (one history per open project). A step holds the "before" and
 * "after" image of only what one user action touched: the cells and review entries of the keys it
 * changed, the key order, and the workspace meta (replaced, never mutated, so a reference will do).
 * External changes (sync, reload, journal) are never recorded.
 */
import type { StateEntry } from "./state-file";
import { type KeyId, type MessageValue, valuesEqual } from "./model";
import type { WorkspaceMeta } from "../workspace/meta";

export const HISTORY_LIMIT = 200;

export interface CellImage {
  values: Map<string, MessageValue> | undefined;
  entries: Record<string, StateEntry> | undefined;
}

export interface Image {
  cells: Map<KeyId, CellImage>;
  keyOrder: KeyId[];
  meta: WorkspaceMeta | null;
}

export interface Step {
  before: Image;
  after: Image;
  /** A language added or removed by this step: undone by the opposite call, since it means files. */
  lang?: { added?: string; removed?: string };
}

export function sameCell(a: CellImage, b: CellImage, locale: string): boolean {
  return (
    valuesEqual(a.values?.get(locale), b.values?.get(locale)) &&
    JSON.stringify(a.entries?.[locale]) === JSON.stringify(b.entries?.[locale])
  );
}

export function localesOf(...imgs: CellImage[]): string[] {
  const out = new Set<string>();
  for (const i of imgs) {
    for (const l of i.values?.keys() ?? []) out.add(l);
    for (const l of Object.keys(i.entries ?? {})) out.add(l);
  }
  return [...out];
}

export const sameOrder = (a: KeyId[], b: KeyId[]) => a === b || (a.length === b.length && a.every((k, i) => k === b[i]));

/** True when a finished step changed nothing (it is then dropped). */
export function isEmpty(s: Step): boolean {
  if (s.lang) return false;
  if (!sameOrder(s.before.keyOrder, s.after.keyOrder) || s.before.meta !== s.after.meta) return false;
  for (const [id, b] of s.before.cells) {
    const a = s.after.cells.get(id)!;
    if (localesOf(a, b).some((l) => !sameCell(a, b, l))) return false;
  }
  return true;
}
