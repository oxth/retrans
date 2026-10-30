import type { LoadedFile, LoadResult } from "../formats/adapter";
import { type Conflict, mergeCells } from "./merge";
import { type CellMap, type KeyId, parseKeyId, type ProjectData } from "./model";

/** What the session knows right before a reload. */
export interface ReloadInput {
  data: ProjectData; // current ("mine")
  disk: CellMap; // snapshot as of last load/save ("base")
  creates: Map<string, { locale: string; ns: string }>; // pending creates (relPath -> cell)
  removed: Map<string, LoadedFile>; // pending deletes
  load: LoadResult; // fresh adapter.load ("theirs")
}

export interface ReloadPlan {
  theirs: CellMap; // new disk snapshot
  merged: CellMap; // new current values
  conflicts: Conflict[];
  locales: string[];
  namespaces: string[];
  keyOrder: KeyId[]; // before plural expansion
  files: LoadedFile[];
  adopted: string[]; // pending creates that now exist on disk
}

/**
 * Rules:
 * - Locales with a pending removal are ignored in the new load (their files stay pending deletes).
 * - Cells of a file that is now read-only (malformed) keep their old snapshot as "theirs", so a
 *   broken file never wipes values; it is never written anyway.
 * - Pending creates whose file now exists on disk are adopted as loaded files.
 * - Locales/namespaces: the new load's, plus local-only ones that still have pending creates or
 *   merged values. Keys: the new load's order, plus local-only keys, keeping only keys that have
 *   a merged value, are in a conflict, or exist both locally and on disk.
 */
export function planReload(inp: ReloadInput): ReloadPlan {
  const { data, disk, creates, removed, load } = inp;
  const removedLocales = new Set(
    [...removed.values()].map((f) => f.locale).filter((l) => !data.locales.includes(l)),
  );
  const files = load.files.filter((f) => !removedLocales.has(f.locale));

  const theirs: CellMap = new Map();
  for (const [id, cells] of load.data.values) {
    const out = new Map([...cells].filter(([l]) => !removedLocales.has(l)));
    if (out.size) theirs.set(id, out);
  }
  const broken = new Set(files.filter((f) => f.readOnly).map((f) => `${f.locale}\0${f.ns}`));
  if (broken.size) {
    for (const [id, cells] of disk) {
      const { ns } = parseKeyId(id);
      for (const [l, v] of cells) {
        if (!broken.has(`${l}\0${ns}`)) continue;
        let t = theirs.get(id);
        if (!t) theirs.set(id, (t = new Map()));
        t.set(l, v);
      }
    }
  }

  const { merged, conflicts } = mergeCells(disk, data.values, theirs);
  const onDisk = new Set(files.map((f) => f.relPath));
  const adopted = [...creates.keys()].filter((p) => onDisk.has(p));
  const pending = [...creates].filter(([p]) => !onDisk.has(p)).map(([, c]) => c);

  const hasValueIn = (l: string) => [...merged.values()].some((c) => c.has(l));
  const freshLocales = load.data.locales.filter((l) => !removedLocales.has(l));
  const extra = data.locales.filter(
    (l) => !freshLocales.includes(l) && (pending.some((c) => c.locale === l) || hasValueIn(l)),
  );
  const [base, ...rest] = [...freshLocales, ...extra];
  const locales = [base, ...(data.format === "paraglide" ? rest : rest.sort())];

  const nsSet = new Set([...load.data.namespaces, ...pending.map((c) => c.ns)]);
  for (const id of merged.keys()) nsSet.add(parseKeyId(id).ns);
  const namespaces = data.format === "paraglide" ? [""] : [...nsSet].sort();

  const conflictIds = new Set(conflicts.map((c) => c.id));
  const cur = new Set(data.keyOrder);
  const fresh = new Set(load.data.keyOrder);
  const keep = (id: KeyId) => merged.has(id) || conflictIds.has(id) || (cur.has(id) && fresh.has(id));
  const keyOrder = [
    ...load.data.keyOrder.filter(keep),
    ...data.keyOrder.filter((id) => !fresh.has(id) && keep(id)),
  ];

  return { theirs, merged, conflicts, locales, namespaces, keyOrder, files, adopted };
}
