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
  /** Unset for a group step (a Translate-missing run only writes cells). */
  keyOrder?: KeyId[];
  meta?: WorkspaceMeta | null;
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
  if (s.before.keyOrder && s.after.keyOrder && !sameOrder(s.before.keyOrder, s.after.keyOrder)) return false;
  if (s.before.meta !== s.after.meta) return false;
  for (const [id, b] of s.before.cells) {
    const a = s.after.cells.get(id)!;
    if (localesOf(a, b).some((l) => !sameCell(a, b, l))) return false;
  }
  return true;
}

/**
 * `current` moved from `from` to `to` by the step's own key-order changes: ids the step added are
 * removed, ids it removed are put back after their nearest earlier neighbour. Rows anything else
 * added or removed since stay as they are. `missing` counts ids that were expected but are gone.
 */
export function moveOrder(current: KeyId[], from: KeyId[], to: KeyId[]): { order: KeyId[]; missing: number } {
  const fromSet = new Set(from);
  const toSet = new Set(to);
  let missing = 0;
  const order = current.filter((id) => {
    if (fromSet.has(id) && !toSet.has(id)) return false;
    return true;
  });
  for (const id of from) if (!toSet.has(id) && !current.includes(id)) missing++;
  for (let i = 0; i < to.length; i++) {
    const id = to[i];
    if (fromSet.has(id) || order.includes(id)) continue;
    let at = -1;
    for (let j = i - 1; j >= 0 && at < 0; j--) at = order.indexOf(to[j]);
    order.splice(at + 1, 0, id);
  }
  return { order, missing };
}

/** Meta fields the step changed (from → to), applied to `current` only where it still matches `from`. */
export function moveMeta(current: WorkspaceMeta, from: WorkspaceMeta, to: WorkspaceMeta): { meta: WorkspaceMeta; missing: number } {
  const next = { ...current } as Record<string, unknown>;
  const f = from as unknown as Record<string, unknown>;
  const t = to as unknown as Record<string, unknown>;
  const c = current as unknown as Record<string, unknown>;
  let missing = 0;
  for (const k of new Set([...Object.keys(f), ...Object.keys(t)])) {
    const before = JSON.stringify(f[k]);
    if (before === JSON.stringify(t[k])) continue;
    if (JSON.stringify(c[k]) !== before) {
      missing++;
      continue;
    }
    if (t[k] === undefined) delete next[k];
    else next[k] = t[k];
  }
  return { meta: next as unknown as WorkspaceMeta, missing };
}
