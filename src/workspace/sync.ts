/**
 * Sync from source (spec §7): merges changes in a workspace's TypeScript locale files into the
 * workspace, three-way per cell against the source baseline. Writes no files: the merged values,
 * meta and new baseline (`session.setPendingBaseline`) are all written by the next save().
 */
import type { Conflict } from "../core/merge";
import { type KeyId, type MessageValue, parseKeyId, valuesEqual } from "../core/model";
import type { ProjectSession } from "../core/session";
import { type Fs, FsError, joinPath } from "../platform/fs";
import { importTsLocales, isMarker, type TsImport } from "../tssource/import";
import { type Baseline, BASELINE_PATH, jsonEqual, parseBaseline, serializeBaseline, type WorkspaceMeta } from "./meta";

export interface SyncResult {
  /** False when the source folder is missing or has no locale modules; nothing was changed. */
  sourceAvailable: boolean;
  /** Cells changed both in the source and in the workspace; the workspace keeps its value. */
  conflicts: Conflict[];
  /** Keys new to the workspace, now rows. */
  added: KeyId[];
  /** Existing rows that took at least one value from the source. */
  updated: KeyId[];
  /** Keys newly marked "removed in source" by this sync (they are not deleted). */
  removedInSource: KeyId[];
  /** Groups (namespaces) created for new source files. */
  newGroups: string[];
}

const unavailable = (): SyncResult => ({
  sourceAvailable: false, conflicts: [], added: [], updated: [], removedInSource: [], newGroups: [],
});

async function readOrNull(fs: Fs, path: string): Promise<string | null> {
  try {
    return await fs.readText(path);
  } catch (err) {
    if (err instanceof FsError && err.code === "NotFound") return null;
    throw err;
  }
}

const baseName = (relPath: string) => relPath.slice(relPath.lastIndexOf("/") + 1).replace(/\.tsx?$/, "");

/** A baseline cell as a value: markers count as missing. */
function baselineValue(b: Baseline, id: KeyId, locale: string): MessageValue | undefined {
  const s = b[id]?.[locale];
  return s === undefined || isMarker(s, locale) ? undefined : { kind: "text", text: s };
}

/** Sets or deletes `table[id][locale]` to match `from`. */
function copyCell(table: Record<KeyId, Record<string, string>>, from: Record<KeyId, Record<string, string>>, id: KeyId, locale: string) {
  const v = from[id]?.[locale];
  if (v !== undefined) (table[id] ??= {})[locale] = v;
  else if (table[id]) {
    delete table[id][locale];
    if (Object.keys(table[id]).length === 0) delete table[id];
  }
}

function copyRow(table: Record<KeyId, Record<string, string>>, from: Record<KeyId, Record<string, string>>, id: KeyId) {
  if (from[id]) table[id] = { ...from[id] };
  else delete table[id];
}

/**
 * Brings the workspace in step with its TypeScript source. Per cell (markers count as missing):
 * source unchanged → nothing; source changed and workspace still equal to the baseline → the
 * source value is taken; both changed differently → a conflict that keeps the workspace value.
 * Keys gone from the source are only marked removed. Files that can't be read are left out
 * entirely: their keys are neither changed nor marked removed, and keep their baseline.
 * The baseline then becomes the current source, except for conflict cells. The source's read-only
 * entries (computed in code) are handed to the session (setSourceReadOnly).
 */
export function syncFromSource(session: ProjectSession): Promise<SyncResult> {
  // One sync at a time per session, so two runs never merge against the same baseline.
  const run = (queues.get(session) ?? Promise.resolve()).then(() => syncNow(session));
  queues.set(session, run.catch(() => undefined));
  return run;
}

const queues = new WeakMap<ProjectSession, Promise<unknown>>();

/** Per session, from its last sync: the source as read, and the baseline that sync settled on. */
const lastSync = new WeakMap<ProjectSession, {
  source: Baseline; markers: WorkspaceMeta["markers"]; drafts: WorkspaceMeta["drafts"]; next: Baseline;
}>();

async function syncNow(session: ProjectSession): Promise<SyncResult> {
  const source = session.workspace?.source;
  if (!source) return unavailable();
  const { fs } = session;
  const root = session.data.root;
  const { localesDir } = source;
  if (!(await fs.exists(joinPath(root, localesDir)))) return unavailable();
  const src = await importTsLocales(fs, root, localesDir, session.data.baseLocale);
  if (src.modules.size === 0) return unavailable();
  if (!session.workspace) return unavailable();
  dropDeletedKeys(src, session.workspace.deletedKeys);
  applyRenames(src, session.workspace.renames);
  const persistedText = await readOrNull(fs, joinPath(root, BASELINE_PATH));
  // Everything below is synchronous, so the workspace can't change underneath the merge.
  // Merge against the newest baseline: one from an earlier sync not yet saved, else the file's.
  const stored = renameRows(session.pendingBaseline ?? parseBaseline(persistedText) ?? {}, session.workspace.renames);
  const meta = session.workspace;
  if (!meta) return unavailable();

  const parsedGroups = new Set([...src.modules.values()].map((m) => m.module.group));
  const unreadable = new Set(
    src.errors.filter((e) => !e.sameName).map((e) => baseName(e.relPath)).filter((g) => !parsedGroups.has(g)),
  );
  const skipped = (id: KeyId) => unreadable.has(parseKeyId(id).ns);
  const inSource = new Set(src.keyOrder);

  // ---- plan, per cell ----
  const conflicts: Conflict[] = [];
  const takes: Array<{ id: KeyId; locale: string; value: MessageValue | undefined }> = [];
  for (const id of src.keyOrder) {
    const locales = [...new Set([...Object.keys(src.baseline[id] ?? {}), ...Object.keys(stored[id] ?? {})])];
    for (const locale of locales) {
      const base = baselineValue(stored, id, locale);
      const theirs = src.values.get(id)?.get(locale);
      if (valuesEqual(base, theirs)) continue; // source unchanged
      const mine = session.value(id, locale);
      if (valuesEqual(mine, theirs)) continue; // same change on both sides
      if (valuesEqual(mine, base)) {
        takes.push({ id, locale, value: theirs });
      } else {
        const c: Conflict = { id, locale };
        if (mine) c.mine = mine;
        if (theirs) c.theirs = theirs;
        conflicts.push(c);
      }
    }
  }

  const known = new Set(session.data.keyOrder);
  const alreadyRemoved = new Set(meta.removedInSource);
  const removedNow = session.data.keyOrder.filter(
    (id) => stored[id] !== undefined && !inSource.has(id) && !skipped(id) && !alreadyRemoved.has(id),
  );

  // ---- apply ----
  const result: SyncResult = { sourceAvailable: true, conflicts, added: [], updated: [], removedInSource: removedNow, newGroups: [] };
  const added = new Set<KeyId>();
  const updated = new Set<KeyId>();
  session.batch(() => {
    for (const group of parsedGroups) {
      if (session.data.namespaces.includes(group)) continue;
      session.addNamespace(group);
      result.newGroups.push(group);
    }
    for (const { id, locale, value } of takes) {
      if (!known.has(id)) {
        if (value === undefined) continue;
        session.insertKey(id, previousRow(src.keyOrder, id, new Set(session.data.keyOrder)));
        known.add(id);
        added.add(id);
        result.added.push(id);
      } else if (!added.has(id) && !updated.has(id)) {
        updated.add(id);
        result.updated.push(id);
      }
      if (!session.data.locales.includes(locale)) session.addLanguage(locale);
      session.importCell(id, locale, value, undefined);
    }

    // Markers and drafts follow the source, except where the workspace keeps its own value.
    const markers = structuredClone(src.markers);
    const drafts = structuredClone(src.drafts);
    for (const c of conflicts) {
      copyCell(markers, meta.markers, c.id, c.locale);
      copyCell(drafts, meta.drafts, c.id, c.locale);
    }
    for (const id of Object.keys({ ...meta.markers, ...meta.drafts })) {
      if (!skipped(id)) continue;
      copyRow(markers, meta.markers, id);
      copyRow(drafts, meta.drafts, id);
    }
    const readOnly = new Set(src.readOnly.map((r) => r.id));
    const emptyKeys = [
      ...src.keyOrder.filter((id) => !src.values.get(id)?.size && !readOnly.has(id) && !session.data.values.get(id)?.size),
      ...meta.emptyKeys.filter(skipped),
    ].sort();
    const patch: Partial<WorkspaceMeta> = {
      markers,
      drafts,
      emptyKeys,
      duplicates: src.duplicates,
      removedInSource: [...meta.removedInSource.filter((id) => !inSource.has(id)), ...removedNow],
    };
    const current = meta as unknown as Record<string, unknown>;
    if (Object.entries(patch).some(([k, v]) => !jsonEqual(current[k], v))) session.setWorkspaceMeta(patch);

    // The new baseline: the current source, but the old cells where there's a conflict, and the
    // old rows of unreadable files. Written by the next save, never before the merge is saved.
    const next: Baseline = structuredClone(src.baseline);
    for (const c of conflicts) copyCell(next, stored, c.id, c.locale);
    for (const id of Object.keys(stored)) if (skipped(id)) copyRow(next, stored, id);
    session.setPendingBaseline(serializeBaseline(next) === persistedText ? null : next);
    lastSync.set(session, { source: src.baseline, markers: src.markers, drafts: src.drafts, next });
    // After the merge: a cell that just became computed in code still took the source's change.
    session.setSourceReadOnly(src.readOnly);
    session.setSourceKeys(src.keyOrder);
  });
  return result;
}

/**
 * Resolves a conflict reported by syncFromSource: "theirs" takes the source value, "mine" keeps
 * the workspace value. Either way the cell's baseline (written by the next save), marker and draft
 * become the source's, so the next sync no longer reports it.
 */
export function resolveSyncConflict(session: ProjectSession, c: Conflict, pick: "mine" | "theirs"): void {
  const last = lastSync.get(session);
  if (!last) throw new Error("No sync to resolve a conflict of");
  const meta = session.workspace!;
  session.batch(() => {
    if (pick === "theirs") {
      if (!session.data.keyOrder.includes(c.id) && c.theirs) session.insertKey(c.id);
      if (session.data.keyOrder.includes(c.id)) {
        if (!session.data.locales.includes(c.locale)) session.addLanguage(c.locale);
        session.importCell(c.id, c.locale, c.theirs, undefined);
      }
    }
    copyCell(last.next, last.source, c.id, c.locale);
    session.setPendingBaseline(last.next);
    const markers = structuredClone(meta.markers);
    const drafts = structuredClone(meta.drafts);
    copyCell(markers, last.markers, c.id, c.locale);
    copyCell(drafts, last.drafts, c.id, c.locale);
    if (!jsonEqual(markers, meta.markers) || !jsonEqual(drafts, meta.drafts)) session.setWorkspaceMeta({ markers, drafts });
    session.conflicts = session.conflicts.filter((x) => x.id !== c.id || x.locale !== c.locale);
  });
}

/**
 * Rewrites an import's ids to workspace ids through `renames` (source id -> renamed id), so a key
 * renamed in Retrans keeps its row, values and meta, and source changes to it merge into it. A
 * rename whose new id the source now has as a key of its own is ignored (the source key wins).
 * Duplicates are recomputed from the renamed keys. Mutates `imp`.
 */
export function applyRenames(imp: TsImport, renames: Record<KeyId, KeyId>): void {
  const map = new Map<KeyId, KeyId>();
  const inSource = new Set(imp.keyOrder);
  for (const [from, to] of Object.entries(renames)) if (inSource.has(from) && !inSource.has(to)) map.set(from, to);
  if (!map.size) return;
  const id = (k: KeyId) => map.get(k) ?? k;
  imp.keyOrder = imp.keyOrder.map(id);
  imp.values = new Map([...imp.values].map(([k, v]) => [id(k), v]));
  imp.baseline = renameRows(imp.baseline, renames, map);
  imp.markers = renameRows(imp.markers, renames, map);
  imp.drafts = renameRows(imp.drafts, renames, map);
  imp.readOnly = imp.readOnly.map((r) => ({ ...r, id: id(r.id) }));
  imp.duplicates = duplicatesOf(imp.keyOrder);
}

/**
 * Leaves the keys deleted in Retrans (`meta.deletedKeys`, source ids) out of an import, as if the
 * source didn't have them: sync never brings them back. Call before applyRenames. Mutates `imp`.
 */
export function dropDeletedKeys(imp: TsImport, deleted: KeyId[]): void {
  if (!deleted.length) return;
  const drop = new Set(deleted);
  if (!imp.keyOrder.some((id) => drop.has(id))) return;
  const keep = <T>(t: Record<KeyId, T>) => Object.fromEntries(Object.entries(t).filter(([id]) => !drop.has(id))) as Record<KeyId, T>;
  imp.keyOrder = imp.keyOrder.filter((id) => !drop.has(id));
  imp.values = new Map([...imp.values].filter(([id]) => !drop.has(id)));
  imp.baseline = keep(imp.baseline);
  imp.markers = keep(imp.markers);
  imp.drafts = keep(imp.drafts);
  imp.readOnly = imp.readOnly.filter((r) => !drop.has(r.id));
  imp.duplicates = duplicatesOf(imp.keyOrder);
}

/** Keys present in more than one group, sorted. */
function duplicatesOf(ids: KeyId[]): string[] {
  const groups = new Map<string, Set<string>>();
  for (const k of ids) {
    const { ns, key } = parseKeyId(k);
    groups.set(key, (groups.get(key) ?? new Set()).add(ns));
  }
  return [...groups].filter(([, gs]) => gs.size > 1).map(([k]) => k).sort();
}

/** A table keyed by source ids with renamed rows moved to their new id (an existing new-id row wins). */
function renameRows<T>(table: Record<KeyId, T>, renames: Record<KeyId, KeyId>, map?: Map<KeyId, KeyId>): Record<KeyId, T> {
  const out: Record<KeyId, T> = { ...table };
  for (const [from, to] of map ?? Object.entries(renames)) {
    if (!(from in out)) continue;
    if (!(to in out)) out[to] = out[from];
    delete out[from];
  }
  return out;
}

/** The nearest key before `id` in source order that is a workspace row of the same group. */
function previousRow(sourceOrder: KeyId[], id: KeyId, rows: Set<KeyId>): KeyId | undefined {
  const { ns } = parseKeyId(id);
  for (let i = sourceOrder.indexOf(id) - 1; i >= 0; i--) {
    const k = sourceOrder[i];
    if (rows.has(k) && parseKeyId(k).ns === ns) return k;
  }
  return undefined;
}
