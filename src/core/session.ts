import type { DetectResult, FileError, FormatAdapter, LoadedFile, ProjectOptions } from "../formats/adapter";
import { localesSnippet, nextI18nextAdapter } from "../formats/next-i18next";
import { paraglideAdapter } from "../formats/paraglide";
import { type Fs, FsError, joinPath } from "../platform/fs";
import { hashValue } from "./hash";
import {
  type CellMeta, type CellMap, type KeyId, keyId, type MessageValue, parseKeyId,
  type ProjectData, valuesEqual, type Warning,
} from "./model";
import { comparePlaceholders } from "./placeholders";
import { expandPluralKeys, isApplicable, pluralCategories, splitPlural } from "./plurals";
import {
  applyChanges, type CellChange, checkCollision, isValidLocale, KeyError, newFile, validateKey,
} from "./session-helpers";
import { parseState, reconcile, serializeState, STATE_PATH, type StateFile } from "./state-file";
import { cellMeta, recordCleared, recordEdit, recordReviewed, renameInState } from "./status";

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

export class ProjectSession {
  readonly fs: Fs;
  readonly adapter: FormatAdapter;
  readonly opts: ProjectOptions;
  data: ProjectData;
  state: StateFile;
  files: LoadedFile[];
  errors: FileError[];
  version = 0;

  private readonly root: string;
  private disk: CellMap; // values as loaded / last saved
  private stateBaseline: string; // serialized reconciled state as loaded / last saved
  private stateTouched = false;
  private creates = new Map<string, { locale: string; ns: string }>(); // relPath -> pending create
  private removed = new Map<string, LoadedFile>(); // relPath -> pending delete
  private localesChanged = false;
  private saving: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private dirtyCache: { version: number; cells: Array<{ id: KeyId; locale: string }> } | null = null;

  private constructor(
    fs: Fs, root: string, adapter: FormatAdapter, opts: ProjectOptions,
    load: { data: ProjectData; files: LoadedFile[]; errors: FileError[] }, state: StateFile,
  ) {
    this.fs = fs;
    this.root = root;
    this.adapter = adapter;
    this.opts = opts;
    this.data = load.data;
    this.files = load.files;
    this.errors = load.errors;
    this.state = state;
    this.disk = copyCells(load.data.values);
    this.stateBaseline = serializeState(reconcile(state, load.data));
  }

  static async open(fs: Fs, root: string, d: DetectResult, opts: ProjectOptions): Promise<ProjectSession> {
    const adapter = d.format === "paraglide" ? paraglideAdapter : nextI18nextAdapter;
    const load = await adapter.load(fs, root, opts);
    const stateText = await readOrNull(fs, joinPath(root, STATE_PATH));
    const state = parseState(stateText, { baseLocale: opts.baseLocale, localesPath: opts.localesPath });
    return new ProjectSession(fs, root, adapter, opts, load, state);
  }

  // ---- reading ---------------------------------------------------------------------------

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
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
    if (!v) return [];
    const base = this.value(id, this.data.baseLocale);
    if (!base) return [{ kind: "orphan" }];
    if (v.kind !== "text" || base.kind !== "text") return [];
    const { missing, extra } = comparePlaceholders(this.data.format, base.text, v.text);
    const out: Warning[] = [];
    if (missing.length) out.push({ kind: "placeholder-missing", names: missing });
    if (extra.length) out.push({ kind: "placeholder-extra", names: extra });
    return out;
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
        if (cells?.get(l)) s.done++;
      }
    }
    return out;
  }

  isDirty(): boolean {
    if (this.creates.size || this.removed.size || this.localesChanged) return true;
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

  setComplex(id: KeyId, locale: string, raw: unknown): void {
    this.requireCell(id, locale);
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

    for (const [src, dst] of pairs) {
      const cells = this.data.values.get(src);
      this.data.values.delete(src);
      if (cells) this.data.values.set(dst, cells);
      renameInState(this.state, src, dst);
    }
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
    this.emit();
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
    return this.data.format === "next-i18next" ? { configSnippet: localesSnippet(locales) } : {};
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

    // this.state stays the live object: status edits made while the write is in flight survive,
    // and stay dirty because they differ from the baseline captured here.
    const serialized = serializeState(reconcile(this.state, this.data));
    this.stateTouched = false;
    if (serialized !== this.stateBaseline) {
      await this.fs.writeTextAtomic(joinPath(this.root, STATE_PATH), serialized);
      res.written.push(STATE_PATH);
      this.stateBaseline = serialized;
    }
    this.emit();
    return res;
  }

  // ---- internals -------------------------------------------------------------------------

  private emit(): void {
    this.version++;
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
