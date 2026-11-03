import type { DetectResult, FileError, FormatAdapter, LoadedFile, ProjectOptions } from "../formats/adapter";
import { localesSnippet, nextI18nextAdapter } from "../formats/next-i18next";
import { paraglideAdapter } from "../formats/paraglide";
import { type Fs, FsError, joinPath, normalizePath } from "../platform/fs";
import { hashValue } from "./hash";
import { detectStyle, setAt } from "./json-text";
import {
  type CellMeta, type CellMap, isTranslated, type KeyId, keyId, type MessageValue, parseKeyId,
  type ProjectData, valuesEqual, type Warning,
} from "./model";
import type { Conflict } from "./merge";
import { entryEqual, mergeStateEntries } from "./merge";
import { comparePlaceholders } from "./placeholders";
import { expandPluralKeys, isApplicable, pluralCategories, splitPlural } from "./plurals";
import {
  applyChanges, type CellChange, checkCollision, isValidLocale, KeyError, newFile, validateKey,
} from "./session-helpers";
import type { Journal } from "./recovery";
import { planReload } from "./session-reload";
import { parseState, reconcile, serializeState, STATE_PATH, type StateEntry, type StateFile } from "./state-file";
import { cellMeta, recordCleared, recordEdit, recordReviewed, renameInState } from "./status";
import {
  type Baseline, BASELINE_PATH, jsonEqual, parseWorkspaceMeta, serializeBaseline, serializeWorkspaceMeta,
  WORKSPACE_DIR, WORKSPACE_META_ERROR, WORKSPACE_META_PATH, type WorkspaceMeta,
} from "../workspace/meta";
import { emptyKeysOf, type TsImport } from "../tssource/import";
import { workspaceAdapter } from "../workspace/store";

export { KeyError } from "./session-helpers";

export interface SaveResult {
  written: string[];
  deleted: string[];
  stale: string[]; // on-disk text differs from snapshot; nothing written (Task 10 handles it)
}

async function readOrNull(fs: Fs, path: string): Promise<string | null> {
  try {
    return await fs.readText(path);
  } catch (err) {
    if (err instanceof FsError && err.code === "NotFound") return null;
    throw err;
  }
}

function copyCells(values: CellMap): CellMap {
  const out: CellMap = new Map();
  for (const [id, cells] of values) out.set(id, new Map(cells));
  return out;
}

const keySets = new WeakMap<KeyId[], Set<KeyId>>();
function keySet(order: KeyId[]): Set<KeyId> {
  let s = keySets.get(order);
  if (!s) keySets.set(order, (s = new Set(order)));
  return s;
}

function projectEqual(a: StateFile["project"], b: StateFile["project"]): boolean {
  return a.baseLocale === b.baseLocale && a.localesPath === b.localesPath;
}

/** A TypeScript source entry Retrans can't edit; without `locale` the whole key. */
export interface SourceReadOnly { id: KeyId; reason: string; locale?: string }

export const READ_ONLY_MESSAGE = "Can't edit here (computed in code)";
export const RENAME_READ_ONLY_MESSAGE = "Can't rename — this key is computed in code.";

export class ProjectSession {
  readonly fs: Fs;
  readonly adapter: FormatAdapter;
  readonly opts: ProjectOptions;
  data: ProjectData;
  state: StateFile;
  files: LoadedFile[];
  errors: FileError[];
  /** Cells edited both locally and on disk, from the last reloadFromDisk(); see resolveConflict. */
  conflicts: Conflict[] = [];
  version = 0;

  private readonly root: string;
  private disk: CellMap; // values as loaded / last saved
  private stateBaseline: string; // serialized reconciled state as loaded / last saved
  private stateTouched = false;
  private stateDiskText: string | null; // raw state.json as loaded / last written (stale check)
  /** Set while .retrans/state.json on disk can't be parsed: it is then never written. */
  private stateError: string | undefined;
  private creates = new Map<string, { locale: string; ns: string }>(); // relPath -> pending create
  private removed = new Map<string, LoadedFile>(); // relPath -> pending delete
  private localesChanged = false;
  private saving: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  /** Nesting depth of batch(); listeners are held while > 0. */
  private batchDepth = 0;
  private batchEmitted = false;
  private dirtyCache: { version: number; cells: Array<{ id: KeyId; locale: string }> } | null = null;
  /** Workspace meta (null for plain projects); written by save() when it differs from metaBaseline. */
  private wsMeta: WorkspaceMeta | null;
  private metaBaseline: string | null; // serialized meta as loaded / last saved
  private metaDiskText: string | null = null; // raw workspace.json as loaded / last written (stale check)
  /** Set while workspace.json on disk can't be parsed: it is then never written. */
  private metaMalformed = false;
  /**
   * Workspace only: the source baseline after a sync, written by the next successful save(). Kept
   * in memory until then so the baseline on disk never claims source changes that aren't saved.
   */
  private pendingBase: Baseline | null = null;
  /** Workspace only: source entries computed in code (from the import / last sync); never editable here. */
  private roCells: SourceReadOnly[] = [];

  private constructor(
    fs: Fs, root: string, adapter: FormatAdapter, opts: ProjectOptions,
    load: { data: ProjectData; files: LoadedFile[]; errors: FileError[] }, state: StateFile,
    stateText: string | null, stateError: string | undefined, workspace: WorkspaceMeta | null,
  ) {
    this.fs = fs;
    this.root = root;
    this.adapter = adapter;
    this.opts = opts;
    this.data = load.data;
    this.files = load.files;
    this.state = state;
    this.disk = copyCells(load.data.values);
    this.stateBaseline = serializeState(reconcile(state, load.data));
    this.stateDiskText = stateText;
    this.stateError = stateError;
    this.errors = this.withStateError(load.errors);
    this.wsMeta = workspace ? structuredClone(workspace) : null;
    this.metaBaseline = workspace ? serializeWorkspaceMeta(workspace) : null;
  }

  static async open(fs: Fs, root: string, d: DetectResult, opts: ProjectOptions): Promise<ProjectSession> {
    const adapter = d.workspace ? workspaceAdapter : d.format === "paraglide" ? paraglideAdapter : nextI18nextAdapter;
    const load = await adapter.load(fs, root, opts);
    const stateText = await readOrNull(fs, joinPath(root, STATE_PATH));
    const { state, error } = parseState(stateText);
    const s = new ProjectSession(fs, root, adapter, opts, load, state, stateText, error, d.workspace ?? null);
    if (d.workspace) {
      s.metaDiskText = await readOrNull(fs, joinPath(root, WORKSPACE_META_PATH));
      s.addExtraRows();
    }
    return s;
  }

  /**
   * A workspace made from an imported TypeScript project, in memory only: every file under
   * .retrans/ (workspace files, meta, state.json with the base language, source baseline) is
   * written by the first save(). Nothing is written here.
   */
  static async fromImport(
    fs: Fs, root: string, imp: TsImport, o: { name: string; localesDir: string; baseLocale: string },
  ): Promise<ProjectSession> {
    const base = o.baseLocale;
    const keyOrder = [...imp.keyOrder];
    const namespaces = [...new Set(keyOrder.map((id) => parseKeyId(id).ns))].sort();
    const locales = [base, ...imp.locales.filter((l) => l !== base).sort()];
    const values: CellMap = new Map();
    for (const [id, cells] of imp.values) if (cells.size) values.set(id, new Map(cells));
    const data: ProjectData = { format: "next-i18next", root, baseLocale: base, locales, namespaces, keyOrder, values };
    const opts: ProjectOptions = { baseLocale: base, localesPath: WORKSPACE_DIR };
    const stateText = await readOrNull(fs, joinPath(root, STATE_PATH));
    const { state, error } = parseState(stateText);
    const meta: WorkspaceMeta = {
      retransWorkspace: 1,
      name: o.name,
      source: { type: "ts", localesDir: o.localesDir },
      drafts: structuredClone(imp.drafts),
      markers: structuredClone(imp.markers),
      removedInSource: [],
      duplicates: [...imp.duplicates],
      emptyKeys: emptyKeysOf(imp),
      renames: {},
    };
    const s = new ProjectSession(fs, root, workspaceAdapter, opts, { data, files: [], errors: [] }, state, stateText, error, meta);
    s.disk = new Map(); // nothing on disk yet: every value is unsaved
    s.metaBaseline = null;
    s.metaDiskText = await readOrNull(fs, joinPath(root, WORKSPACE_META_PATH));
    for (const locale of locales) {
      for (const ns of namespaces) s.creates.set(workspaceAdapter.filePath(opts, locale, ns), { locale, ns });
    }
    s.pendingBase = structuredClone(imp.baseline);
    s.roCells = imp.readOnly.map((r) => ({ ...r }));
    s.state.project.baseLocale = base;
    s.stateTouched = true;
    s.setKeyOrder(keyOrder);
    return s;
  }

  /** Workspace only: why this cell can't be edited (computed in code), else null. */
  readOnlyReason(id: KeyId, locale: string): string | null {
    for (const r of this.roCells) if (r.id === id && (r.locale === undefined || r.locale === locale)) return r.reason;
    return null;
  }

  /** Workspace only: the source's read-only entries (from a sync); they get rows even without values. */
  setSourceReadOnly(list: SourceReadOnly[]): void {
    if (!this.wsMeta || jsonEqual(list, this.roCells)) return;
    this.roCells = list.map((r) => ({ ...r }));
    this.addExtraRows();
    this.emit();
  }

  /**
   * Workspace rows that have no values, so the workspace files don't list them: keys empty in
   * every language (meta.emptyKeys) and read-only source entries. Each goes after the last row of
   * its group. Doesn't make the session dirty.
   */
  private addExtraRows(): void {
    if (!this.wsMeta) return;
    const known = keySet(this.data.keyOrder);
    const extra = [...new Set([...this.wsMeta.emptyKeys, ...this.roCells.map((r) => r.id)])].filter(
      (id) => !known.has(id) && this.data.namespaces.includes(parseKeyId(id).ns),
    );
    if (!extra.length) return;
    const order = [...this.data.keyOrder];
    for (const id of extra) {
      const { ns } = parseKeyId(id);
      let at = -1;
      for (let i = order.length - 1; i >= 0; i--) {
        if (parseKeyId(order[i]).ns === ns) {
          at = i;
          break;
        }
      }
      order.splice(at < 0 ? order.length : at + 1, 0, id);
    }
    this.setKeyOrder(order);
  }

  /** The workspace meta (.retrans/workspace.json); null when this isn't a workspace. */
  get workspace(): WorkspaceMeta | null {
    return this.wsMeta;
  }

  /** Workspace only: merge `patch` into the meta; written by the next save(). */
  setWorkspaceMeta(patch: Partial<WorkspaceMeta>): void {
    if (!this.wsMeta) throw new Error("This project is not a workspace");
    this.wsMeta = { ...this.wsMeta, ...patch, retransWorkspace: 1 };
    if (patch.emptyKeys) this.addExtraRows();
    this.emit();
  }

  /** The source baseline waiting for the next save (see setPendingBaseline); null when none. */
  get pendingBaseline(): Baseline | null {
    return this.pendingBase;
  }

  /**
   * Workspace only: the baseline save() writes to .retrans/source-baseline.json after the
   * workspace files and meta (null drops it). Makes the session dirty; lost when not saved.
   */
  setPendingBaseline(b: Baseline | null): void {
    if (!this.wsMeta) throw new Error("This project is not a workspace");
    const same = b === null || this.pendingBase === null ? b === this.pendingBase : jsonEqual(b, this.pendingBase);
    if (same) return;
    this.pendingBase = b === null ? null : structuredClone(b);
    this.emit();
  }

  private metaDirty(): boolean {
    return this.wsMeta !== null && serializeWorkspaceMeta(this.wsMeta) !== this.metaBaseline;
  }

  // ---- reading ---------------------------------------------------------------------------

  /** True while .retrans/state.json can't be parsed (it is then never written). */
  get stateMalformed(): boolean {
    return this.stateError !== undefined;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Run `fn` with change notifications held; listeners then fire once if anything changed (also
   * when `fn` throws). Nested batches notify only when the outermost one ends.
   */
  batch<T>(fn: () => T): T {
    this.batchDepth++;
    try {
      return fn();
    } finally {
      if (--this.batchDepth === 0 && this.batchEmitted) {
        this.batchEmitted = false;
        this.notify();
      }
    }
  }

  value(id: KeyId, locale: string): MessageValue | undefined {
    return this.data.values.get(id)?.get(locale);
  }

  meta(id: KeyId, locale: string): CellMeta {
    return cellMeta(this.data, this.state, id, locale);
  }

  warnings(id: KeyId, locale: string): Warning[] {
    if (locale === this.data.baseLocale) return [];
    const v = this.value(id, locale);
    if (!v || !isTranslated(v)) return [];
    const base = this.value(id, this.data.baseLocale);
    if (!base) return [{ kind: "orphan" }];
    if (v.kind !== "text" || base.kind !== "text") return [];
    const { missing, extra } = comparePlaceholders(this.data.format, base.text, v.text);
    const out: Warning[] = [];
    if (missing.length) out.push({ kind: "placeholder-missing", names: missing });
    if (extra.length) out.push({ kind: "placeholder-extra", names: extra });
    return out;
  }

  /** False when the file holding this cell couldn't be read, or it is computed in code: edits to it are refused. */
  isWritable(id: KeyId, locale: string): boolean {
    if (this.readOnlyReason(id, locale) !== null) return false;
    const relPath = this.adapter.filePath(this.opts, locale, parseKeyId(id).ns);
    return !this.files.find((f) => f.relPath === relPath)?.readOnly;
  }

  stats(): Map<string, { done: number; total: number }> {
    const out = new Map<string, { done: number; total: number }>();
    for (const l of this.data.locales) out.set(l, { done: 0, total: 0 });
    for (const id of this.data.keyOrder) {
      const cells = this.data.values.get(id);
      for (const l of this.data.locales) {
        if (!isApplicable(this.data, id, l)) continue;
        const s = out.get(l)!;
        s.total++;
        if (isTranslated(cells?.get(l))) s.done++;
      }
    }
    return out;
  }

  isDirty(): boolean {
    if (this.creates.size || this.removed.size || this.localesChanged || this.metaDirty() || this.pendingBase) return true;
    if (this.dirtyCells().length) return true;
    return this.stateTouched && serializeState(reconcile(this.state, this.data)) !== this.stateBaseline;
  }

  dirtyCells(): Array<{ id: KeyId; locale: string }> {
    if (this.dirtyCache?.version === this.version) return this.dirtyCache.cells;
    const out: Array<{ id: KeyId; locale: string }> = [];
    const check = (id: KeyId) => {
      const cur = this.data.values.get(id);
      const disk = this.disk.get(id);
      if (!cur && !disk) return;
      for (const l of this.data.locales) {
        if (!valuesEqual(cur?.get(l), disk?.get(l))) out.push({ id, locale: l });
      }
    };
    const known = keySet(this.data.keyOrder);
    for (const id of this.data.keyOrder) check(id);
    for (const id of this.disk.keys()) if (!known.has(id)) check(id);
    this.dirtyCache = { version: this.version, cells: out };
    return out;
  }

  // ---- editing ---------------------------------------------------------------------------

  setText(id: KeyId, locale: string, text: string | null, opts?: { machine?: boolean }): void {
    this.requireCell(id, locale);
    this.requireEditable(id, locale);
    if (text === null || text === "") {
      this.put(id, locale, undefined);
      recordCleared(this.state, id, locale);
    } else {
      this.put(id, locale, { kind: "text", text });
      recordEdit(this.data, this.state, id, locale, !!opts?.machine);
    }
    this.stateTouched = true;
    this.emit();
  }

  /**
   * Take a cell from an imported package: its value plus the translator's status entry when the
   * package carried one (their Reviewed / machine flags travel); otherwise a plain human edit.
   */
  importCell(id: KeyId, locale: string, value: MessageValue | undefined, entry: StateEntry | undefined): void {
    this.requireCell(id, locale);
    if (value === undefined) {
      this.put(id, locale, undefined);
      recordCleared(this.state, id, locale);
    } else {
      this.put(id, locale, value.kind === "complex" ? { kind: "complex", raw: structuredClone(value.raw) } : { ...value });
      if (entry) (this.state.entries[id] ??= {})[locale] = { ...entry };
      else recordEdit(this.data, this.state, id, locale, false);
    }
    this.stateTouched = true;
    this.emit();
  }

  setComplex(id: KeyId, locale: string, raw: unknown): void {
    this.requireCell(id, locale);
    this.requireEditable(id, locale);
    this.put(id, locale, { kind: "complex", raw: structuredClone(raw) });
    recordEdit(this.data, this.state, id, locale, false);
    this.stateTouched = true;
    this.emit();
  }

  markReviewed(id: KeyId, locale: string): void {
    this.requireKey(id);
    recordReviewed(this.data, this.state, id, locale);
    this.stateTouched = true;
    this.emit();
  }

  addKey(ns: string, key: string, baseText: string, opts?: { plural?: boolean }): KeyId {
    validateKey(key);
    if (!baseText) throw new KeyError("invalid", "A new key needs a base-language text");
    if (!this.data.namespaces.includes(ns)) throw new KeyError("invalid", `namespace "${ns}" does not exist`);
    const base = this.data.baseLocale;
    const keys = opts?.plural ? pluralCategories(base).map((c) => `${key}_${c}`) : [key];
    for (const k of keys) {
      validateKey(k);
      checkCollision(this.data.keyOrder, ns, k);
    }
    this.assertWritable(base, ns);
    const ids = keys.map((k) => keyId(ns, k));
    for (const id of ids) this.put(id, base, { kind: "text", text: baseText });
    this.setKeyOrder([...this.data.keyOrder, ...ids]);
    this.emit();
    return opts?.plural ? keyId(ns, `${key}_other`) : ids[0];
  }

  /**
   * Adds a row with no values yet (e.g. a key that appeared in the TS source), right after `after`
   * when that is a row, else at the end. Fill it with importCell().
   */
  insertKey(id: KeyId, after?: KeyId): void {
    const { ns, key } = parseKeyId(id);
    validateKey(key);
    if (!this.data.namespaces.includes(ns)) throw new KeyError("invalid", `namespace "${ns}" does not exist`);
    checkCollision(this.data.keyOrder, ns, key);
    this.assertWritable(this.data.baseLocale, ns);
    const order = [...this.data.keyOrder];
    const at = after === undefined ? -1 : order.indexOf(after);
    order.splice(at < 0 ? order.length : at + 1, 0, id);
    this.setKeyOrder(order);
    this.emit();
  }

  renameKey(id: KeyId, newKey: string): KeyId {
    this.requireKey(id);
    validateKey(newKey);
    const { ns, key } = parseKeyId(id);
    if (key === newKey) return id;
    const from = splitPlural(key);
    const to = splitPlural(newKey);
    const pairs = new Map<KeyId, KeyId>();
    if (from?.category === "other" && to?.category === "other") {
      for (const sib of this.pluralSiblings(id)) {
        pairs.set(sib, keyId(ns, `${to.base}_${splitPlural(parseKeyId(sib).key)!.category}`));
      }
    } else {
      pairs.set(id, keyId(ns, newKey));
    }
    const ignore = new Set(pairs.keys());
    for (const target of pairs.values()) checkCollision(this.data.keyOrder, ns, parseKeyId(target).key, ignore);
    for (const src of pairs.keys()) this.assertWritableKey(src);
    if ([...pairs.keys()].some((src) => this.roCells.some((r) => r.id === src))) throw new Error(RENAME_READ_ONLY_MESSAGE);

    for (const [src, dst] of pairs) {
      const cells = this.data.values.get(src);
      this.data.values.delete(src);
      if (cells) this.data.values.set(dst, cells);
      renameInState(this.state, src, dst);
    }
    if (this.wsMeta) this.renameInMeta(pairs);
    this.setKeyOrder(this.data.keyOrder.map((k) => pairs.get(k) ?? k));
    this.stateTouched = true;
    this.emit();
    return pairs.get(id)!;
  }

  deleteKey(id: KeyId): void {
    this.requireKey(id);
    const ids = splitPlural(parseKeyId(id).key)?.category === "other" ? this.pluralSiblings(id) : [id];
    for (const k of ids) this.assertWritableKey(k);
    const drop = new Set(ids);
    for (const k of ids) {
      this.data.values.delete(k);
      delete this.state.entries[k];
    }
    this.setKeyOrder(this.data.keyOrder.filter((k) => !drop.has(k)));
    this.stateTouched = true;
    if (this.wsMeta) this.forgetInMeta(drop);
    this.emit();
  }

  /** A renamed key takes its workspace meta along (empty-key row, draft, marker, removed-in-source). */
  private renameInMeta(pairs: Map<KeyId, KeyId>): void {
    const meta = this.wsMeta!;
    const ids = (list: KeyId[]) => [...new Set(list.map((id) => pairs.get(id) ?? id))];
    const table = <T>(t: Record<KeyId, T>) =>
      Object.fromEntries(Object.entries(t).map(([id, v]) => [pairs.get(id) ?? id, v])) as Record<KeyId, T>;
    const renames = { ...meta.renames };
    for (const [from, to] of pairs) {
      // The source id this key came from (chains collapse); renaming back to it drops the entry.
      const origin = Object.keys(renames).find((k) => renames[k] === from) ?? from;
      if (to === origin) delete renames[origin];
      else renames[origin] = to;
    }
    this.wsMeta = {
      ...meta,
      renames,
      emptyKeys: ids(meta.emptyKeys).sort(),
      removedInSource: ids(meta.removedInSource),
      drafts: table(meta.drafts),
      markers: table(meta.markers),
    };
  }

  /** A deleted key leaves the workspace meta too (so it doesn't come back as a row or a mark). */
  private forgetInMeta(drop: Set<KeyId>): void {
    const meta = this.wsMeta!;
    const without = <T>(table: Record<KeyId, T>) =>
      Object.fromEntries(Object.entries(table).filter(([id]) => !drop.has(id))) as Record<KeyId, T>;
    const patch: Partial<WorkspaceMeta> = {
      removedInSource: meta.removedInSource.filter((id) => !drop.has(id)),
      emptyKeys: meta.emptyKeys.filter((id) => !drop.has(id)),
      drafts: without(meta.drafts),
      markers: without(meta.markers),
    };
    this.wsMeta = { ...meta, ...patch };
    this.roCells = this.roCells.filter((r) => !drop.has(r.id));
  }

  addLanguage(locale: string): { configSnippet?: string } {
    if (!isValidLocale(locale)) throw new Error(`"${locale}" is not a valid locale`);
    if (this.data.locales.includes(locale)) throw new Error(`"${locale}" is already a language of this project`);
    const [base, ...rest] = this.data.locales;
    const locales =
      this.data.format === "paraglide" ? [base, ...rest, locale] : [base, ...[...rest, locale].sort()];
    this.data.locales = locales;
    for (const ns of this.data.namespaces) {
      this.creates.set(this.adapter.filePath(this.opts, locale, ns), { locale, ns });
    }
    this.setKeyOrder(this.data.keyOrder);
    this.localesChanged = true;
    this.emit();
    return this.data.format === "next-i18next" && !this.wsMeta ? { configSnippet: localesSnippet(locales) } : {};
  }

  removeLanguage(locale: string): void {
    if (locale === this.data.baseLocale) throw new Error("The base language can't be removed");
    if (!this.data.locales.includes(locale)) throw new Error(`"${locale}" is not a language of this project`);
    for (const f of this.files) if (f.locale === locale) this.removed.set(f.relPath, f);
    this.files = this.files.filter((f) => f.locale !== locale);
    for (const [p, c] of this.creates) if (c.locale === locale) this.creates.delete(p);
    for (const cells of this.data.values.values()) cells.delete(locale);
    for (const cells of this.disk.values()) cells.delete(locale);
    for (const [id, cells] of Object.entries(this.state.entries)) {
      delete cells[locale];
      if (Object.keys(cells).length === 0) delete this.state.entries[id];
    }
    this.data.locales = this.data.locales.filter((l) => l !== locale);
    this.localesChanged = true;
    this.stateTouched = true;
    this.emit();
  }

  /**
   * Records the base language the user picked (because detection couldn't tell) in
   * .retrans/state.json right away, changing only `project.baseLocale` in the file, so the
   * question is asked once. Runs in the save queue. Skipped while state.json is malformed or
   * changed on disk since it was read (the in-memory value is then written by the next save).
   */
  pinBaseLocale(locale: string): Promise<void> {
    const run = this.saving.then(() => this.pinBaseLocaleNow(locale));
    this.saving = run.catch(() => undefined);
    return run;
  }

  private async pinBaseLocaleNow(locale: string): Promise<void> {
    this.state.project.baseLocale = locale;
    this.stateTouched = true;
    if (this.stateError) return;
    const path = joinPath(this.root, STATE_PATH);
    const disk = await readOrNull(this.fs, path);
    if (disk !== this.stateDiskText) return;
    let text: string;
    if (disk === null) {
      text = serializeState({ version: 1, project: { baseLocale: locale }, entries: {} });
    } else {
      text = setAt(disk, ["project", "baseLocale"], locale, detectStyle(disk));
      if (text === disk) return;
    }
    await this.fs.writeTextAtomic(path, text);
    this.stateDiskText = text;
    const baseline = JSON.parse(this.stateBaseline) as StateFile;
    baseline.project.baseLocale = locale;
    this.stateBaseline = serializeState(baseline);
    this.emit();
  }

  /** Project-level setting stored in .retrans/state.json (e.g. the locales path override, the project id). */
  setProjectSetting(patch: { localesPath?: string | undefined; id?: string }): void {
    if ("localesPath" in patch) {
      if (patch.localesPath) this.state.project.localesPath = patch.localesPath;
      else delete this.state.project.localesPath;
    }
    if (patch.id) this.state.project.id = patch.id;
    this.stateTouched = true;
    this.emit();
  }

  addNamespace(ns: string): void {
    if (this.data.format !== "next-i18next") throw new Error("Namespaces are only supported for next-i18next");
    if (!ns || /[\\/]|::/.test(ns) || ns.startsWith(".")) throw new Error(`"${ns}" is not a valid namespace`);
    if (this.data.namespaces.includes(ns)) throw new Error(`Namespace "${ns}" already exists`);
    this.data.namespaces = [...this.data.namespaces, ns].sort();
    for (const locale of this.data.locales) {
      this.creates.set(this.adapter.filePath(this.opts, locale, ns), { locale, ns });
    }
    this.emit();
  }

  // ---- saving ----------------------------------------------------------------------------

  /** Saves are serialized: a call made while another is in flight runs after it. */
  save(): Promise<SaveResult> {
    const run = this.saving.then(() => this.saveNow());
    this.saving = run.catch(() => undefined);
    return run;
  }

  private async saveNow(): Promise<SaveResult> {
    const res: SaveResult = { written: [], deleted: [], stale: [] };
    const pendingBase = this.pendingBase; // what the values saved below were merged against
    const byFile = new Map<string, { locale: string; ns: string; changes: CellChange[] }>();
    for (const { id, locale } of this.dirtyCells()) {
      const { ns, key } = parseKeyId(id);
      const relPath = this.adapter.filePath(this.opts, locale, ns);
      let g = byFile.get(relPath);
      if (!g) byFile.set(relPath, (g = { locale, ns, changes: [] }));
      g.changes.push({ id, key, value: this.value(id, locale) });
    }
    for (const [relPath, c] of this.creates) if (!byFile.has(relPath)) byFile.set(relPath, { ...c, changes: [] });

    for (const [relPath, { locale, ns, changes }] of byFile) {
      const existing = this.files.find((f) => f.relPath === relPath);
      if (existing?.readOnly) continue; // never written; edits to it are refused up front
      const abs = joinPath(this.root, relPath);
      const expected = existing ? existing.text : (this.removed.get(relPath)?.text ?? null);
      if ((await readOrNull(this.fs, abs)) !== expected) {
        res.stale.push(relPath);
        continue;
      }
      const file = existing ?? newFile(this.adapter, this.files, this.data.baseLocale, relPath, locale, ns);
      const { text, segIndex, hasSet } = applyChanges(this.adapter, file, changes);
      const write = existing ? text !== existing.text : hasSet || this.creates.has(relPath);
      if (write) {
        await this.fs.writeTextAtomic(abs, text);
        res.written.push(relPath);
        if (existing) {
          existing.text = text;
          existing.segIndex = segIndex;
        } else {
          this.files.push({ ...file, text, segIndex });
        }
        this.removed.delete(relPath);
      }
      this.creates.delete(relPath);
      for (const ch of changes) this.snapshot(ch.id, locale, ch.value);
    }

    for (const [relPath, f] of this.removed) {
      const abs = joinPath(this.root, relPath);
      const disk = await readOrNull(this.fs, abs);
      if (disk !== null && disk !== f.text) {
        res.stale.push(relPath);
        continue;
      }
      if (disk !== null) {
        await this.fs.remove(abs);
        res.deleted.push(relPath);
      }
      this.removed.delete(relPath);
    }

    if (this.localesChanged) {
      this.localesChanged = false;
      try {
        const r = await this.adapter.onLocalesChanged(this.fs, this.root, this.data.locales);
        res.written.push(...(r.written ?? []));
      } catch (err) {
        this.localesChanged = true;
        throw err;
      }
    }

    if (this.wsMeta && this.metaDirty() && !this.metaMalformed) {
      const text = serializeWorkspaceMeta(this.wsMeta);
      const path = joinPath(this.root, WORKSPACE_META_PATH);
      if ((await readOrNull(this.fs, path)) !== this.metaDiskText) {
        res.stale.push(WORKSPACE_META_PATH); // changed on disk: don't clobber it; stays dirty
      } else {
        await this.fs.writeTextAtomic(path, text);
        res.written.push(WORKSPACE_META_PATH);
        this.metaBaseline = text;
        this.metaDiskText = text;
      }
    }

    // Only once every workspace file and the meta are on disk: otherwise a later sync would see
    // the source as already merged while the merge isn't saved.
    if (pendingBase && res.stale.length === 0) {
      await this.fs.writeTextAtomic(joinPath(this.root, BASELINE_PATH), serializeBaseline(pendingBase));
      res.written.push(BASELINE_PATH);
      if (this.pendingBase === pendingBase) this.pendingBase = null;
    }

    // this.state stays the live object: status edits made while the write is in flight survive,
    // and stay dirty because they differ from the baseline captured here.
    const serialized = serializeState(reconcile(this.state, this.data));
    // Unparseable on disk (e.g. merge markers): never overwrite it. Statuses stay in memory (and
    // dirty) until a reload finds the file valid again.
    if (!this.stateError) this.stateTouched = false;
    if (!this.stateError && serialized !== this.stateBaseline) {
      const statePath = joinPath(this.root, STATE_PATH);
      if ((await readOrNull(this.fs, statePath)) !== this.stateDiskText) {
        // Changed on disk (e.g. a pull): don't clobber it; reloadFromDisk merges, then save again.
        res.stale.push(STATE_PATH);
        this.stateTouched = true;
      } else {
        await this.fs.writeTextAtomic(statePath, serialized);
        res.written.push(STATE_PATH);
        this.stateBaseline = serialized;
        this.stateDiskText = serialized;
      }
    }
    this.emit();
    return res;
  }

  // ---- external changes & recovery ---------------------------------------------------------

  /**
   * Merge what's on disk now into the session (three-way: base = snapshot at last load/save,
   * theirs = disk now, mine = current values). Runs in the save queue. Conflicting cells keep
   * "mine" until resolveConflict. state.json: an entry changed on disk replaces the local one only
   * for cells whose local entry still equals the last loaded/saved one (untouched locally).
   */
  reloadFromDisk(): Promise<Conflict[]> {
    const run = this.saving.then(() => this.reloadNow());
    this.saving = run.catch(() => undefined);
    return run;
  }

  private async reloadNow(): Promise<Conflict[]> {
    const load = await this.adapter.load(this.fs, this.root, this.opts);
    const stateText = await readOrNull(this.fs, joinPath(this.root, STATE_PATH));
    const metaText = this.wsMeta ? await readOrNull(this.fs, joinPath(this.root, WORKSPACE_META_PATH)) : null;
    // Everything below is synchronous, so edits made during the awaits are included as "mine".
    const plan = planReload({ data: this.data, disk: this.disk, creates: this.creates, removed: this.removed, load });
    for (const p of plan.adopted) this.creates.delete(p);
    for (const f of load.files) if (this.removed.has(f.relPath)) this.removed.set(f.relPath, f);
    this.files = plan.files;
    this.disk = copyCells(plan.theirs);
    this.data.values = plan.merged;
    this.data.locales = plan.locales;
    this.data.namespaces = plan.namespaces;
    this.setKeyOrder(plan.keyOrder);

    const { state: diskState, error: stateError } = parseState(stateText);
    this.stateError = stateError;
    if (!stateError) {
      const baseline = JSON.parse(this.stateBaseline) as StateFile;
      mergeStateEntries(this.state, baseline, diskState);
      // Project overrides: adopt the disk's unless changed locally since the last load/save.
      if (projectEqual(this.state.project, baseline.project)) this.state.project = { ...diskState.project };
      this.stateBaseline = serializeState(reconcile(diskState, this.data));
    } // else: keep local entries and the last good baseline; merging resumes once it parses again
    this.stateDiskText = stateText;
    this.stateTouched = true;
    this.errors = this.withStateError(load.errors.filter((e) => plan.files.some((f) => f.relPath === e.relPath)));
    if (this.wsMeta) {
      this.mergeMetaFromDisk(metaText);
      this.addExtraRows();
    }

    this.conflicts = plan.conflicts;
    this.emit();
    return plan.conflicts;
  }

  /**
   * Workspace meta from disk: fields not changed locally since the last load/save adopt the disk's,
   * locally changed fields win. A deleted file is written again by the next save; an unparseable
   * one is reported and never overwritten until it parses again.
   */
  private mergeMetaFromDisk(text: string | null): void {
    const local = this.wsMeta!;
    if (text === null) {
      this.metaMalformed = false;
      this.metaDiskText = null;
      this.metaBaseline = null; // so the meta counts as changed and is re-created
      return;
    }
    const disk = parseWorkspaceMeta(text);
    this.metaMalformed = !disk;
    if (!disk) {
      this.errors = [
        ...this.errors.filter((e) => e.relPath !== WORKSPACE_META_PATH),
        { relPath: WORKSPACE_META_PATH, message: WORKSPACE_META_ERROR },
      ];
      return;
    }
    // Compared in file form (as metaBaseline is), e.g. an invalid source is `source` there.
    const base = (this.metaBaseline ? JSON.parse(this.metaBaseline) : {}) as Record<string, unknown>;
    const mine = JSON.parse(serializeWorkspaceMeta(local)) as Record<string, unknown>;
    const theirs = JSON.parse(serializeWorkspaceMeta(disk)) as Record<string, unknown>;
    const merged: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs), ...Object.keys(base)])) {
      const v = jsonEqual(mine[k], base[k]) ? theirs[k] : mine[k];
      if (v !== undefined) merged[k] = v;
    }
    this.wsMeta = parseWorkspaceMeta(JSON.stringify(merged)) ?? disk;
    this.metaBaseline = serializeWorkspaceMeta(disk);
    this.metaDiskText = text;
  }

  /**
   * "theirs" adopts the current on-disk value (undefined = cleared) and its status, never the
   * possibly older `c.theirs`; "mine" keeps current.
   */
  resolveConflict(c: Conflict, pick: "mine" | "theirs"): void {
    this.conflicts = this.conflicts.filter((x) => x.id !== c.id || x.locale !== c.locale);
    if (pick === "theirs") {
      const theirs = this.disk.get(c.id)?.get(c.locale);
      this.put(c.id, c.locale, theirs ? structuredClone(theirs) : undefined);
      if (theirs && !keySet(this.data.keyOrder).has(c.id)) this.setKeyOrder([...this.data.keyOrder, c.id]);
      const disk = (JSON.parse(this.stateBaseline) as StateFile).entries[c.id]?.[c.locale];
      if (disk) (this.state.entries[c.id] ??= {})[c.locale] = { ...disk };
      else if (this.state.entries[c.id]) {
        delete this.state.entries[c.id][c.locale];
        if (Object.keys(this.state.entries[c.id]).length === 0) delete this.state.entries[c.id];
      }
      this.stateTouched = true;
    }
    this.emit();
  }

  /**
   * Brings a list of conflicts up to date: one per cell (later entries win), `mine`/`theirs` from
   * the current value and disk snapshot, and cells whose value now equals disk dropped.
   */
  refreshConflicts(list: Conflict[]): Conflict[] {
    const byCell = new Map<string, Conflict>();
    for (const c of list) {
      const k = `${c.id}\0${c.locale}`;
      byCell.delete(k); // re-insert so the newest keeps its place at the end
      byCell.set(k, c);
    }
    const out: Conflict[] = [];
    for (const { id, locale } of byCell.values()) {
      const mine = this.value(id, locale);
      const theirs = this.disk.get(id)?.get(locale);
      if (valuesEqual(mine, theirs)) continue;
      const c: Conflict = { id, locale };
      if (mine) c.mine = mine;
      if (theirs) c.theirs = theirs;
      out.push(c);
    }
    return out;
  }

  /** Unsaved edits, for the crash-recovery journal. Each cell carries its disk value at the time. */
  toJournal(): Journal {
    const baseline = (JSON.parse(this.stateBaseline) as StateFile).entries;
    const stateCells: Array<[KeyId, string]> = [];
    for (const id of new Set([...Object.keys(baseline), ...Object.keys(this.state.entries)])) {
      const locales = new Set([...Object.keys(baseline[id] ?? {}), ...Object.keys(this.state.entries[id] ?? {})]);
      for (const l of locales) {
        if (!entryEqual(this.state.entries[id]?.[l], baseline[id]?.[l])) stateCells.push([id, l]);
      }
    }
    return {
      root: this.root,
      savedAt: new Date().toISOString(),
      locales: [...this.data.locales],
      namespaces: [...this.data.namespaces],
      cells: this.dirtyCells().map(({ id, locale }) => [
        id, locale,
        structuredClone(this.value(id, locale)) ?? null,
        structuredClone(this.disk.get(id)?.get(locale)) ?? null,
      ]),
      stateCells,
      state: structuredClone(this.state),
      ...(this.metaDirty() ? { workspaceMeta: this.metaPatch() } : {}),
    };
  }

  /** Meta fields changed since the last load/save (all of them when the meta was never saved). */
  private metaPatch(): NonNullable<Journal["workspaceMeta"]> {
    const cur = JSON.parse(serializeWorkspaceMeta(this.wsMeta!)) as Record<string, unknown>; // file form
    if (this.metaBaseline === null) return cur as Partial<WorkspaceMeta>;
    const base = JSON.parse(this.metaBaseline) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(cur), ...Object.keys(base)])) {
      if (!jsonEqual(cur[k], base[k])) out[k] = cur[k] ?? null; // null: field removed
    }
    return out as NonNullable<Journal["workspaceMeta"]>;
  }

  /**
   * Re-applies a journal onto a freshly opened session: missing languages/namespaces (as pending
   * creates), then cells merged three-way (base = disk value at journal time, theirs = disk now,
   * mine = journal value; conflicts keep mine until resolveConflict), then status entries for the
   * cells the journal touched only.
   */
  applyJournal(j: Journal): Conflict[] {
    if (normalizePath(j.root) !== normalizePath(this.root)) {
      throw new Error(`Journal root ${j.root} does not match project root ${this.root}`);
    }
    for (const l of j.locales) if (!this.data.locales.includes(l)) this.addLanguage(l);
    if (this.data.format === "next-i18next") {
      for (const ns of j.namespaces) if (!this.data.namespaces.includes(ns)) this.addNamespace(ns);
    }
    const known = keySet(this.data.keyOrder);
    const added = new Set<KeyId>();
    const conflicts: Conflict[] = [];
    const touched: Array<[KeyId, string]> = [...j.stateCells];
    for (const [id, locale, m, b] of j.cells) {
      if (!this.data.locales.includes(locale)) continue;
      const relPath = this.adapter.filePath(this.opts, locale, parseKeyId(id).ns);
      if (this.files.find((f) => f.relPath === relPath)?.readOnly) continue;
      const mine = m ?? undefined;
      const theirs = this.disk.get(id)?.get(locale);
      if (!valuesEqual(mine, theirs) && !valuesEqual(b ?? undefined, theirs)) {
        if (valuesEqual(b ?? undefined, mine)) continue; // only disk moved: keep disk
        conflicts.push({ id, locale, mine, theirs });
      }
      this.put(id, locale, mine ? structuredClone(mine) : undefined);
      if (mine && !known.has(id)) added.add(id);
      touched.push([id, locale]);
    }
    if (added.size) this.setKeyOrder([...this.data.keyOrder, ...added]);
    if (this.wsMeta && j.workspaceMeta) {
      // The journal's meta changes win; anything that doesn't parse as meta is ignored.
      const merged = JSON.parse(serializeWorkspaceMeta(this.wsMeta)) as Record<string, unknown>; // file form
      for (const [k, v] of Object.entries(j.workspaceMeta)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      const meta = parseWorkspaceMeta(JSON.stringify(merged));
      if (meta) {
        this.wsMeta = meta;
        this.addExtraRows();
      }
    }
    for (const [id, l] of touched) {
      const e = j.state.entries[id]?.[l];
      if (e) (this.state.entries[id] ??= {})[l] = { ...e };
      else if (this.state.entries[id]) {
        delete this.state.entries[id][l];
        if (Object.keys(this.state.entries[id]).length === 0) delete this.state.entries[id];
      }
    }
    this.stateTouched = true;
    this.conflicts = [...this.conflicts, ...conflicts];
    this.emit();
    return conflicts;
  }

  // ---- internals -------------------------------------------------------------------------

  private withStateError(errors: FileError[]): FileError[] {
    if (!this.stateError) return errors;
    const message = `${this.stateError}. Review statuses won't be saved until this file is fixed.`;
    return [...errors.filter((e) => e.relPath !== STATE_PATH), { relPath: STATE_PATH, message }];
  }

  private emit(): void {
    this.version++;
    if (this.batchDepth > 0) this.batchEmitted = true;
    else this.notify();
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn();
  }

  private snapshot(id: KeyId, locale: string, v: MessageValue | undefined): void {
    let cells = this.disk.get(id);
    if (v) {
      if (!cells) this.disk.set(id, (cells = new Map()));
      cells.set(locale, v);
    } else if (cells) {
      cells.delete(locale);
      if (cells.size === 0) this.disk.delete(id);
    }
  }

  /** Assign a new keyOrder array (never mutate in place) and re-expand plural categories. */
  private setKeyOrder(order: KeyId[]): void {
    this.data.keyOrder = expandPluralKeys({ ...this.data, keyOrder: order });
  }

  /** Set/clear a value. A base change first pins un-tracked translations to the old base hash. */
  private put(id: KeyId, locale: string, v: MessageValue | undefined): void {
    let cells = this.data.values.get(id);
    if (locale === this.data.baseLocale && cells && !valuesEqual(cells.get(locale), v)) {
      const h = hashValue(cells.get(locale));
      for (const [l, val] of cells) {
        if (l === locale || !val || this.state.entries[id]?.[l]) continue;
        (this.state.entries[id] ??= {})[l] = { s: "translated", h };
      }
    }
    if (v) {
      if (!cells) this.data.values.set(id, (cells = new Map()));
      cells.set(locale, v);
    } else if (cells) {
      cells.delete(locale);
      if (cells.size === 0) this.data.values.delete(id);
    }
  }

  private pluralSiblings(id: KeyId): KeyId[] {
    const { ns, key } = parseKeyId(id);
    const base = splitPlural(key)!.base;
    return this.data.keyOrder.filter((k) => {
      const p = parseKeyId(k);
      return p.ns === ns && splitPlural(p.key)?.base === base;
    });
  }

  private requireKey(id: KeyId): void {
    if (!keySet(this.data.keyOrder).has(id)) throw new Error(`Unknown key ${id}`);
  }

  private requireCell(id: KeyId, locale: string): void {
    this.requireKey(id);
    if (!this.data.locales.includes(locale)) throw new Error(`Unknown language ${locale}`);
    this.assertWritable(locale, parseKeyId(id).ns);
  }

  /** Read-only source entries (computed in code) are never edited here. */
  private requireEditable(id: KeyId, locale: string): void {
    if (this.readOnlyReason(id, locale) !== null) throw new Error(READ_ONLY_MESSAGE);
  }

  private assertWritable(locale: string, ns: string): void {
    const relPath = this.adapter.filePath(this.opts, locale, ns);
    if (this.files.find((f) => f.relPath === relPath)?.readOnly) {
      throw new Error(`${relPath} couldn't be read and is read-only`);
    }
  }

  private assertWritableKey(id: KeyId): void {
    const { ns } = parseKeyId(id);
    for (const l of this.data.values.get(id)?.keys() ?? []) this.assertWritable(l, ns);
  }
}
