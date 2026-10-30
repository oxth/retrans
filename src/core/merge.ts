import { type CellMap, type KeyId, type MessageValue, valuesEqual } from "./model";
import type { StateEntry, StateFile } from "./state-file";

export interface Conflict { id: KeyId; locale: string; mine?: MessageValue; theirs?: MessageValue }

/**
 * Three-way merge per cell. Equal on both sides -> that value; only one side moved away from
 * base -> that side; both moved differently -> conflict, and `merged` keeps mine.
 */
export function mergeCells(base: CellMap, mine: CellMap, theirs: CellMap): { merged: CellMap; conflicts: Conflict[] } {
  const merged: CellMap = new Map();
  const conflicts: Conflict[] = [];
  const ids = new Set<KeyId>([...mine.keys(), ...theirs.keys(), ...base.keys()]);
  for (const id of ids) {
    const b = base.get(id);
    const m = mine.get(id);
    const t = theirs.get(id);
    const locales = new Set<string>([...(m?.keys() ?? []), ...(t?.keys() ?? []), ...(b?.keys() ?? [])]);
    const out = new Map<string, MessageValue>();
    for (const l of locales) {
      const bv = b?.get(l);
      const mv = m?.get(l);
      const tv = t?.get(l);
      let v: MessageValue | undefined;
      if (valuesEqual(mv, tv) || valuesEqual(bv, tv)) v = mv;
      else if (valuesEqual(bv, mv)) v = tv;
      else {
        conflicts.push({ id, locale: l, mine: mv, theirs: tv });
        v = mv;
      }
      if (v) out.set(l, v);
    }
    if (out.size) merged.set(id, out);
  }
  return { merged, conflicts };
}

export function entryEqual(a?: StateEntry, b?: StateEntry): boolean {
  if (!a || !b) return a === b;
  return a.s === b.s && a.h === b.h && !!a.m === !!b.m;
}

/**
 * Review-status merge. A cell whose local entry still equals the baseline (last loaded/saved
 * state) was not touched locally, so the on-disk entry replaces it (or removes it). Cells touched
 * locally keep the local entry. Mutates `local.entries`.
 */
export function mergeStateEntries(local: StateFile, baseline: StateFile, disk: StateFile): void {
  const ids = new Set<KeyId>([...Object.keys(baseline.entries), ...Object.keys(disk.entries)]);
  for (const id of ids) {
    const locales = new Set([...Object.keys(baseline.entries[id] ?? {}), ...Object.keys(disk.entries[id] ?? {})]);
    for (const l of locales) {
      const mine = local.entries[id]?.[l];
      if (!entryEqual(mine, baseline.entries[id]?.[l])) continue; // touched locally
      const theirs = disk.entries[id]?.[l];
      if (theirs) (local.entries[id] ??= {})[l] = { ...theirs };
      else if (local.entries[id]) {
        delete local.entries[id][l];
        if (Object.keys(local.entries[id]).length === 0) delete local.entries[id];
      }
    }
  }
}
