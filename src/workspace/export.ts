/**
 * Export engine (spec §8): turns a workspace session into a list of files, then writes them.
 *
 * Planning is read-only (it only reads the stored baseline); `writeExportPlan` does the writing.
 * TypeScript write-back edits the source modules with minimal diffs (`applyTsEdits`); every other
 * target is generated from the workspace values alone.
 */
import { planFigmaExport } from "../figma/export";
import { figmaGroups } from "../figma/meta";
import { isTranslated, type KeyId, keyId, parseKeyId } from "../core/model";
import type { ProjectSession } from "../core/session";
import { MESSAGE_SCHEMA, paraglideSettingsText } from "../formats/scaffold";
import { type Fs, FsError, joinPath, normalizePath } from "../platform/fs";
import { isMarker, type TsImport } from "../tssource/import";
import { type LocaleModule, parseLocaleModule } from "../tssource/parse";
import {
  applyTsEdits, encodeTsString, groupIdents, i18nSnippet, mapLocaleImport, newTableModule, type TsEdit,
} from "../tssource/write";
import { type Baseline, BASELINE_PATH, type ExportTarget, jsonEqual, parseBaseline, serializeBaseline } from "./meta";
import { applyRenames, dropDeletedKeys } from "./sync";

export interface ExportPlan {
  /** Every file must be under this folder: the project root (write-back), else the chosen folder. */
  root: string;
  /**
   * `expected` (write-back only): the file's text the plan was made from, `null` for a file that
   * must not exist yet. writeExportPlan refuses to write when the file no longer matches.
   */
  files: Array<{ path: string; text: string; expected?: string | null }>;
  snippets: string[];
  leftOutLocales: string[];
  /** ts-writeback / ts-copy: how to add the `leftOutLocales` to the code (when there are any). */
  leftOutSnippet?: string;
  warnings: string[];
  blocked?: { reason: "duplicates"; keys: string[] } | { reason: "conflicts" };
  /** ts-writeback only: the source baseline after this export, written after the files. */
  baseline?: { path: string; text: string };
  /**
   * ts-writeback only: the old (source) ids of `meta.renames` entries this write-back carries out
   * (old key removed, new key written) or that never mapped a source key. `recordWriteBack` drops
   * them from the meta once the plan is written.
   */
  renamesApplied?: KeyId[];
  /** ts-writeback only: the `meta.deletedKeys` now gone from the source; `recordWriteBack` clears them. */
  deletedApplied?: KeyId[];
  /** figma only: modes this export creates (mode name -> language), to add to the Figma mode map. */
  figmaModes?: Record<string, string>;
  /**
   * figma only: what the new mode files hold. Added to the Figma baseline after writing, so their
   * base-language fallbacks never come back as translations when the files are synced.
   */
  figmaBaseline?: Record<string, Record<string, string>>;
}

const emptyPlan = (root: string): ExportPlan => ({ root, files: [], snippets: [], leftOutLocales: [], warnings: [] });

/**
 * `source` (from `importTsLocales` on the current files) is required for `ts-writeback` and
 * `ts-copy`. Those are blocked with `conflicts` while the source differs from the stored
 * baseline: the caller syncs first (`syncFromSource`), which brings the baseline up to date
 * once there are no open conflicts.
 */
export async function planExport(session: ProjectSession, target: ExportTarget, source?: TsImport): Promise<ExportPlan> {
  switch (target.kind) {
    case "ts-writeback":
    case "ts-copy":
      if (!source) throw new Error("Writing TypeScript needs the current source files");
      return planTsSource(session, target, source);
    case "ts-modules":
      return planTsModules(session, target.dir);
    case "i18next-json":
      return planI18next(session, target.dir, target.namespaces);
    case "paraglide":
      return planParaglide(session, target.dir);
    case "figma":
      return planFigmaExport(session, target.dir);
  }
}

export const SOURCE_CHANGED_MESSAGE = "Your code changed while exporting. Export again.";

/** writeExportPlan wrote some files, then failed: `written` files are already on disk. */
export class PartialExportError extends Error {
  constructor(readonly written: number, cause: unknown) {
    super(`${written} files were written before the error: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/**
 * Writes every file (parent folders created, atomic writes). Throws when the plan is blocked, when
 * a path leaves `plan.root`, or (SOURCE_CHANGED_MESSAGE) when a write-back file changed since
 * planning — all before writing anything. A failure after some files were written throws a
 * PartialExportError; a failure before the first one throws as is.
 */
export async function writeExportPlan(fs: Fs, plan: ExportPlan): Promise<void> {
  if (plan.blocked) {
    throw new Error(
      plan.blocked.reason === "duplicates"
        ? `Export blocked by duplicate keys: ${plan.blocked.keys.join(", ")}`
        : "Export blocked: the source files changed — sync and resolve conflicts first",
    );
  }
  // Defence in depth: nothing is written unless every path stays under the plan's root.
  const root = resolveDots(plan.root);
  const inside = (path: string) => {
    const p = resolveDots(path);
    if (p === root || !p.startsWith(root === "/" ? "/" : root + "/")) {
      throw new Error(`Refusing to write outside ${plan.root}: ${path}`);
    }
    return p;
  };
  const files = plan.files.map((f) => ({ path: inside(f.path), text: f.text }));
  const baseline = plan.baseline && { path: inside(plan.baseline.path), text: plan.baseline.text };
  for (const f of plan.files) {
    if (f.expected !== undefined && (await readOrNull(fs, f.path)) !== f.expected) throw new Error(SOURCE_CHANGED_MESSAGE);
  }
  let written = 0;
  try {
    for (const f of files) {
      const slash = f.path.lastIndexOf("/");
      if (slash > 0) await fs.mkdirp(f.path.slice(0, slash));
      await fs.writeTextAtomic(f.path, f.text);
      written++;
    }
    // Last: if a file write fails, the old baseline makes the next export sync first.
    if (baseline) await fs.writeTextAtomic(baseline.path, baseline.text);
  } catch (e) {
    if (written === 0) throw e;
    throw new PartialExportError(written, e);
  }
}

/** `path` normalized with `.` and `..` segments resolved (`..` never goes above the start). */
function resolveDots(path: string): string {
  const norm = normalizePath(path);
  const out: string[] = [];
  for (const seg of norm.split("/")) {
    if (seg === ".") continue;
    if (seg === "..") {
      // Never above the start: "/" (out[0] === "") or a drive ("C:").
      if (out.length > 1 || (out.length === 1 && out[0] !== "" && !/^[A-Za-z]:$/.test(out[0]))) out.pop();
      continue;
    }
    out.push(seg);
  }
  const r = out.join("/");
  return r === "" ? "/" : r;
}

/**
 * After `writeExportPlan` of a write-back: the renames it carried out leave the meta (written by
 * the next save), since the source now has the new keys.
 */
export function recordWriteBack(session: ProjectSession, plan: ExportPlan): void {
  const meta = session.workspace;
  if (!meta) return;
  if (plan.renamesApplied?.length) {
    const done = new Set(plan.renamesApplied);
    session.setWorkspaceMeta({ renames: Object.fromEntries(Object.entries(meta.renames).filter(([from]) => !done.has(from))) });
  }
  if (plan.deletedApplied?.length) {
    const done = new Set(plan.deletedApplied);
    session.setWorkspaceMeta({ deletedKeys: session.workspace!.deletedKeys.filter((id) => !done.has(id)) });
  }
}

// ---- workspace reading -------------------------------------------------------------------

type Cell = { text: string } | "complex" | undefined;

/** A translated cell's text, "complex" for a non-text value, undefined when missing. */
function cell(session: ProjectSession, id: KeyId, locale: string): Cell {
  const v = session.value(id, locale);
  if (!isTranslated(v)) return undefined;
  return v!.kind === "text" ? { text: v!.text } : "complex";
}

/** Group -> its key ids, in key order. */
function rowsByGroup(session: ProjectSession): Map<string, KeyId[]> {
  const out = new Map<string, KeyId[]>();
  for (const id of session.data.keyOrder) {
    const { ns } = parseKeyId(id);
    const list = out.get(ns) ?? [];
    list.push(id);
    out.set(ns, list);
  }
  return out;
}

/** Keys present in more than one group, sorted. */
function duplicateKeys(session: ProjectSession): string[] {
  const groups = new Map<string, Set<string>>();
  for (const id of session.data.keyOrder) {
    const { ns, key } = parseKeyId(id);
    const s = groups.get(key) ?? new Set<string>();
    s.add(ns);
    groups.set(key, s);
  }
  return [...groups].filter(([, s]) => s.size > 1).map(([k]) => k).sort();
}

/**
 * `{ key: { locale: text } }` for a group's TS output: translated text, else (with
 * `keepMarkers`, for write-back into the source) the marker the cell still had in the source.
 * Other untranslated cells are left out.
 */
function tableValues(
  session: ProjectSession, ids: KeyId[], locales: string[], keepMarkers: boolean,
): Record<string, Record<string, string>> {
  const markers = keepMarkers ? (session.workspace?.markers ?? {}) : {};
  const out: Record<string, Record<string, string>> = {};
  for (const id of ids) {
    const row: Record<string, string> = {};
    for (const loc of locales) {
      const c = cell(session, id, loc);
      if (c && c !== "complex") row[loc] = c.text;
      else if (c === undefined && markers[id]?.[loc] !== undefined) row[loc] = markers[id][loc];
    }
    out[parseKeyId(id).key] = row;
  }
  return out;
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

function jsonValue(session: ProjectSession, id: KeyId, locale: string): unknown {
  const v = session.value(id, locale);
  if (!isTranslated(v)) return undefined;
  return v!.kind === "text" ? v!.text : v!.raw;
}

// ---- TypeScript: write-back / copy -------------------------------------------------------

async function readOrNull(fs: Fs, path: string): Promise<string | null> {
  try {
    return await fs.readText(path);
  } catch (err) {
    if (err instanceof FsError && err.code === "NotFound") return null;
    throw err;
  }
}

/** True when a generated module parses back as a locale module. */
function generatedOk(text: string, relPath: string): boolean {
  try {
    return parseLocaleModule(text, relPath) !== null;
  } catch {
    return false;
  }
}

/** True when root-relative `relPath` sits directly in folder `dir` (not in a subfolder). */
function directlyIn(relPath: string, dir: string): boolean {
  const d = joinPath(dir);
  const rest = d === "" ? relPath : relPath.startsWith(d + "/") ? relPath.slice(d.length + 1) : null;
  return rest !== null && !rest.includes("/");
}

/** The folder part of a path or specifier, with its trailing `/` (`none` when it has none). */
function dirOf(path: string, none: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? none : path.slice(0, slash + 1);
}

const baseName = (relPath: string) => relPath.slice(relPath.lastIndexOf("/") + 1).replace(/\.tsx?$/, "");

async function planTsSource(
  session: ProjectSession,
  target: Extract<ExportTarget, { kind: "ts-writeback" | "ts-copy" }>,
  source: TsImport,
): Promise<ExportPlan> {
  const meta = session.workspace;
  if (!meta?.source) throw new Error("This workspace has no TypeScript source");
  const root = session.data.root;
  // Renames done in Retrans: the old source key is written as remove-old + add-new. Compare in
  // workspace ids, as sync does (a baseline saved after a sync is keyed by the new ids).
  const renamed = activeRenames(source, meta.renames);
  // Keys deleted in Retrans count as gone from the source, as in sync (with the row they were renamed to).
  const deleted = new Set(meta.deletedKeys);
  const gone = new Set([...deleted, ...meta.deletedKeys.flatMap((id) => (meta.renames[id] ? [meta.renames[id]] : []))]);
  const normalized: TsImport = { ...source };
  dropDeletedKeys(normalized, meta.deletedKeys);
  applyRenames(normalized, meta.renames);
  const stored = parseBaseline(await readOrNull(session.fs, joinPath(root, BASELINE_PATH)));
  const storedNow = stored && Object.fromEntries(Object.entries(renameBaseline(stored, renamed)).filter(([id]) => !gone.has(id)));
  if (!storedNow || !jsonEqual(storedNow, normalized.baseline)) {
    return { ...emptyPlan(root), blocked: { reason: "conflicts" } };
  }
  const renamedOld = new Set(renamed.keys());
  const renamedNew = new Set(renamed.values());

  const writeback = target.kind === "ts-writeback";
  const outRoot = writeback ? root : target.dir;
  const plan = emptyPlan(outRoot);
  const removed = new Set(meta.removedInSource);
  const rows = rowsByGroup(session);
  const sessionLocales = session.data.locales;

  /** Every module as it will be after the export; `module` is set when it didn't change. */
  const outputs: Output[] = [];
  for (const { relPath, module, text } of source.modules.values()) {
    const ids = (rows.get(module.group) ?? []).filter((id) => !removed.has(id));
    const out = applyTsEdits(text, module, moduleEdits(session, module, ids, removed, renamedOld, renamedNew, deleted));
    outputs.push(out === text ? { relPath, text: out, module } : { relPath, text: out });
    if (writeback && out === text) continue;
    plan.files.push({ path: joinPath(outRoot, relPath), text: out, ...(writeback ? { expected: text } : {}) });
  }

  for (const e of source.errors) {
    plan.warnings.push(e.sameName ? e.message : `Couldn't read ${e.relPath}; it was left unchanged.`);
  }

  // Groups created in Retrans: a new table-style file each, in the languages the source has.
  const srcLocales = source.locales.filter((l) => sessionLocales.includes(l));
  const known = new Set([...source.modules.values()].map((m) => m.module.group));
  // A file skipped for its name doesn't make its group unreadable: the group's other file is read.
  const erroredGroups = new Set(source.errors.filter((e) => !e.sameName).map((e) => baseName(e.relPath)));
  const newGroups: string[] = [];
  // New files import mapLocale as the folder's table-style files do (else from next to them).
  const mapLocaleFrom = [...source.modules.values()]
    .filter((m) => m.module.style === "table" && directlyIn(m.relPath, meta.source!.localesDir))
    .map((m) => mapLocaleImport(m.text))
    .find((x) => x !== null) ?? "./mapLocale";
  const idents = groupIdents(session.data.namespaces.filter((g) => !known.has(g)));
  // Figma strings with no code key yet never go into the code (spec C3).
  const figma = figmaGroups(meta);
  for (const group of session.data.namespaces) {
    if (known.has(group) || figma.has(group)) continue;
    const ids = (rows.get(group) ?? []).filter((id) => !removed.has(id));
    const values = tableValues(session, ids, srcLocales, true);
    if (!Object.values(values).some((r) => Object.keys(r).length > 0)) continue;
    const relPath = joinPath(meta.source.localesDir, `${group}.ts`);
    const path = joinPath(outRoot, relPath);
    if (erroredGroups.has(group)) {
      plan.warnings.push(`Couldn't read the source file of group "${group}"; it was not written.`);
      continue;
    }
    if (writeback && (await session.fs.exists(path))) {
      plan.warnings.push(`${relPath} already exists; group "${group}" was not written.`);
      continue;
    }
    const text = newTableModule(group, values, srcLocales, mapLocaleFrom, idents.get(group));
    if (!generatedOk(text, relPath)) {
      plan.warnings.push(`Couldn't generate ${path} — skipped.`);
      continue;
    }
    plan.files.push({ path, text, ...(writeback ? { expected: null } : {}) });
    outputs.push({ relPath, text });
    newGroups.push(group);
  }
  if (newGroups.length > 0) plan.snippets.push(i18nSnippet(newGroups, srcLocales, dirOf(mapLocaleFrom, "./"), idents));

  plan.leftOutLocales = sessionLocales.filter((l) => !source.locales.includes(l));
  if (plan.leftOutLocales.length > 0) plan.leftOutSnippet = languageSnippet(plan.leftOutLocales, source.locales);
  if (writeback && plan.files.length > 0) {
    plan.baseline = { path: joinPath(root, BASELINE_PATH), text: serializeBaseline(baselineOf(parsed(outputs))) };
  }
  if (writeback) {
    // Done once the old key is gone from the written source (a rename of a key added in Retrans
    // never mapped a source key). Unreadable files were not touched: their renames stay.
    const after = keysOf(parsed(outputs));
    const applied = Object.keys(meta.renames).filter(
      (from) => !erroredGroups.has(parseKeyId(from).ns) && !after.has(from),
    );
    if (applied.length > 0) plan.renamesApplied = applied;
    const deletedDone = meta.deletedKeys.filter((id) => !erroredGroups.has(parseKeyId(id).ns) && !after.has(id));
    if (deletedDone.length > 0) plan.deletedApplied = deletedDone;
  }
  return plan;
}

/** `renames` entries that map a source key (the same rule as sync's applyRenames): old id -> new id. */
function activeRenames(source: TsImport, renames: Record<KeyId, KeyId>): Map<KeyId, KeyId> {
  const inSource = new Set(source.keyOrder);
  const map = new Map<KeyId, KeyId>();
  for (const [from, to] of Object.entries(renames)) if (inSource.has(from) && !inSource.has(to)) map.set(from, to);
  return map;
}

/** A baseline keyed by source ids with renamed rows moved to their new id (an existing new-id row wins). */
function renameBaseline(b: Baseline, map: Map<KeyId, KeyId>): Baseline {
  const out: Baseline = { ...b };
  for (const [from, to] of map) {
    if (!(from in out)) continue;
    if (!(to in out)) out[to] = out[from];
    delete out[from];
  }
  return out;
}

type Output = { relPath: string; text: string; module?: LocaleModule | null };

/** Each output's module, parsed once (unchanged outputs already have theirs). */
function parsed(outputs: Output[]): LocaleModule[] {
  for (const o of outputs) if (o.module === undefined) o.module = parseLocaleModule(o.text, o.relPath);
  return outputs.flatMap((o) => (o.module ? [o.module] : []));
}

/** Every key id the modules define (values, `undefined`s, read-only entries). */
function keysOf(modules: LocaleModule[]): Set<KeyId> {
  const out = new Set<KeyId>();
  for (const module of modules) {
    for (const e of module.entries) out.add(keyId(module.group, e.key));
    for (const r of module.readOnly) out.add(keyId(module.group, r.key));
    for (const k of Object.keys(module.pairObjects ?? {})) out.add(keyId(module.group, k));
  }
  return out;
}

/** The baseline `importTsLocales` would record for these modules. */
function baselineOf(modules: LocaleModule[]): Baseline {
  const out: Baseline = {};
  for (const module of modules) {
    for (const e of module.entries) {
      if (!e.undefinedLiteral) (out[keyId(module.group, e.key)] ??= {})[e.locale] = e.value;
    }
  }
  return out;
}

/**
 * The edits that make `module` match the workspace rows `ids` (its group, removed-in-source keys
 * already dropped). At most one edit kind per key, and nothing for read-only values.
 */
function moduleEdits(
  session: ProjectSession, module: LocaleModule, ids: KeyId[], removed: Set<KeyId>,
  renamedOld: Set<KeyId>, renamedNew: Set<KeyId>, deleted: Set<KeyId>,
): TsEdit[] {
  const edits: TsEdit[] = [];
  const { group } = module;
  const markers = session.workspace?.markers ?? {};
  const sessionLocales = session.data.locales;
  // Lookups by key (the first entry per key and language, as a linear search would find).
  const entries = new Map<string, Map<string, LocaleModule["entries"][number]>>();
  for (const e of module.entries) {
    const byLoc = entries.get(e.key) ?? new Map();
    if (!byLoc.has(e.locale)) byLoc.set(e.locale, e);
    entries.set(e.key, byLoc);
  }
  const readOnly = new Map<string, LocaleModule["readOnly"]>();
  for (const r of module.readOnly) readOnly.set(r.key, [...(readOnly.get(r.key) ?? []), r]);
  const entry = (key: string, loc: string) => entries.get(key)?.get(loc);
  const isReal = (key: string, loc: string) => {
    const e = entry(key, loc);
    return e !== undefined && !e.undefinedLiteral && !isMarker(e.value, loc);
  };
  const hasReadOnly = (key: string) => readOnly.has(key);
  const readOnlyCell = (key: string, loc: string) =>
    (readOnly.get(key) ?? []).some((r) => module.style === "table" || r.locale === undefined || r.locale === loc);

  // In source order (a Set keeps insertion order).
  const sourceKeys = new Set<string>();
  for (const e of module.entries) sourceKeys.add(e.key);
  for (const r of module.readOnly) sourceKeys.add(r.key);
  for (const k of Object.keys(module.pairObjects ?? {})) sourceKeys.add(k);

  const wsKeys = new Set<string>();
  for (const id of ids) {
    const { key } = parseKeyId(id);
    wsKeys.add(key);

    if (!sourceKeys.has(key)) {
      const values: Record<string, string> = {};
      for (const loc of module.locales) {
        const c = cell(session, id, loc);
        if (c && c !== "complex") values[loc] = c.text;
        // A renamed key keeps the marker its old key had in the source.
        else if (c === undefined && renamedNew.has(id) && markers[id]?.[loc] !== undefined) values[loc] = markers[id][loc];
      }
      if (Object.keys(values).length > 0) edits.push({ kind: "add", key, values });
      continue;
    }
    if (module.style === "table" && hasReadOnly(key)) continue;

    const cellEdits: TsEdit[] = [];
    let kept = 0; // languages that still have something in the file afterwards
    for (const loc of module.locales) {
      const e = entry(key, loc);
      const present = e !== undefined && !e.undefinedLiteral;
      if (!sessionLocales.includes(loc) || readOnlyCell(key, loc)) {
        if (present || readOnlyCell(key, loc)) kept++;
        continue;
      }
      const c = cell(session, id, loc);
      if (c === "complex") {
        if (present) kept++;
      } else if (c) {
        kept++;
        if (!(isReal(key, loc) && e!.value === c.text)) cellEdits.push({ kind: "set", key, locale: loc, value: c.text });
      } else if (present && isMarker(e!.value, loc)) {
        kept++; // still missing: the marker stays
      } else if (present) {
        cellEdits.push({ kind: "remove", key, locale: loc });
      }
    }
    const removesAll = kept === 0 && cellEdits.some((x) => x.kind === "remove") && !hasReadOnly(key);
    if (removesAll) {
      edits.push({ kind: "remove", key });
    } else if (cellEdits.some((x) => x.kind === "remove") && cellEdits.some((x) => x.kind === "set")) {
      // One edit per key: sets and per-language removals travel together.
      const values: Record<string, string | null> = {};
      for (const x of cellEdits) {
        if (x.kind === "set") values[x.locale] = x.value;
        else if (x.kind === "remove") values[x.locale!] = null;
      }
      edits.push({ kind: "replace", key, values });
    } else {
      edits.push(...cellEdits);
    }
  }

  // Keys deleted in the workspace. A key with no real value in the source (only markers or
  // `undefined`) goes only when its row was deleted (meta.deletedKeys) or renamed.
  for (const key of sourceKeys) {
    if (wsKeys.has(key) || removed.has(keyId(group, key)) || hasReadOnly(key)) continue;
    const id = keyId(group, key);
    if (deleted.has(id) || renamedOld.has(id) || module.locales.some((loc) => isReal(key, loc))) edits.push({ kind: "remove", key });
  }
  return edits;
}

/** How to add languages the TS sources don't have. */
function languageSnippet(leftOut: string[], sourceLocales: string[]): string {
  const all = [...sourceLocales, ...leftOut];
  const names = leftOut.join(", ");
  const field = (l: string) => `${tsKey(l)}?: string`;
  const pairs = all.map((l) => `${tsKey(l)}: '…'`).join(", ");
  return [
    `// ${names}: not in the TypeScript sources, so not written. To add ${leftOut.length > 1 ? "them" : "it"}:`,
    `// 1. Split-style files: one more export per language, e.g.`,
    ...leftOut.map((l) => `//      export const button${l.toUpperCase()} = { button_save: '…', … };`),
    `// 2. Table-style files: one more field per pair, e.g.`,
    `//      email: { ${pairs} },`,
    `// 3. mapLocale.ts: widen its types:`,
    `//      table: Record<TKey, { ${all.map(field).join("; ")} }>,`,
    `//      locale: ${all.map((l) => encodeTsString(l, "'")).join(" | ")},`,
    `// 4. i18n.ts: add resources.<language>.translation with the …${leftOut[0].toUpperCase()} spreads.`,
    `// Or export ${names} in another format (i18next JSON or Paraglide).`,
    "",
  ].join("\n");
}

const tsKey = (s: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) ? s : encodeTsString(s, "'"));

// ---- TypeScript modules ------------------------------------------------------------------

function mapLocaleModule(locales: string[]): string {
  const fields = locales.map((l) => `${tsKey(l)}?: string`).join("; ");
  return [
    "/**",
    " * Derives one language's flat translation map from a table of per-language pairs,",
    " * keeping each translation key written once.",
    " */",
    "export function mapLocale<TKey extends string>(",
    `  table: Record<TKey, { ${fields} }>,`,
    `  locale: ${locales.map((l) => encodeTsString(l, "'")).join(" | ")},`,
    "): Partial<Record<TKey, string>> {",
    "  return Object.fromEntries(",
    "    Object.entries(table)",
    "      .map(([key, value]) => [key, (value as Record<string, string | undefined>)[locale]])",
    "      .filter(([, value]) => value !== undefined),",
    "  ) as Partial<Record<TKey, string>>;",
    "}",
    "",
  ].join("\n");
}

function planTsModules(session: ProjectSession, dir: string): ExportPlan {
  const plan = emptyPlan(dir);
  const locales = session.data.locales;
  const rows = rowsByGroup(session);
  const candidates = session.data.namespaces.filter((g) => (rows.get(g) ?? []).length > 0);
  const idents = groupIdents(candidates);
  const groups: string[] = [];
  for (const group of candidates) {
    const values = tableValues(session, rows.get(group)!, locales, false);
    const path = joinPath(dir, `${group}.ts`);
    const text = newTableModule(group, values, locales, "./mapLocale", idents.get(group));
    if (!generatedOk(text, `${group}.ts`)) {
      plan.warnings.push(`Couldn't generate ${path} — skipped.`);
      continue;
    }
    plan.files.push({ path, text });
    groups.push(group);
  }
  plan.files.push({ path: joinPath(dir, "mapLocale.ts"), text: mapLocaleModule(locales) });
  if (groups.length > 0) plan.snippets.push(i18nSnippet(groups, locales, "./", idents));
  return plan;
}

// ---- i18next JSON ------------------------------------------------------------------------

function planI18next(session: ProjectSession, dir: string, namespaces: "per-group" | "single"): ExportPlan {
  if (namespaces === "single") {
    const dups = duplicateKeys(session);
    if (dups.length > 0) return { ...emptyPlan(dir), blocked: { reason: "duplicates", keys: dups } };
  }
  const plan = emptyPlan(dir);
  const rows = rowsByGroup(session);
  const flat = (ids: KeyId[], locale: string) => {
    const out: Record<string, unknown> = {};
    for (const id of ids) {
      const v = jsonValue(session, id, locale);
      if (v !== undefined) out[parseKeyId(id).key] = v;
    }
    return out;
  };
  for (const locale of session.data.locales) {
    if (namespaces === "single") {
      plan.files.push({ path: joinPath(dir, locale, "translation.json"), text: json(flat(session.data.keyOrder, locale)) });
      continue;
    }
    for (const group of session.data.namespaces) {
      plan.files.push({ path: joinPath(dir, locale, `${group}.json`), text: json(flat(rows.get(group) ?? [], locale)) });
    }
  }
  return plan;
}

// ---- Paraglide ---------------------------------------------------------------------------

/** i18next `{{name}}` → `{name}`; a format modifier (`{{x, fmt}}`, `{{- x}}`) is dropped. */
function toParaglide(text: string, onModifier: () => void): string {
  return text.replace(/\{\{([^{}]*)\}\}/g, (_, inner: string) => {
    let name = inner.trim();
    let modifier = false;
    if (name.startsWith("-")) {
      name = name.slice(1).trim();
      modifier = true;
    }
    const comma = name.indexOf(",");
    if (comma >= 0) {
      name = name.slice(0, comma).trim();
      modifier = true;
    }
    if (modifier) onModifier();
    return `{${name}}`;
  });
}

function planParaglide(session: ProjectSession, dir: string): ExportPlan {
  const dups = duplicateKeys(session);
  if (dups.length > 0) return { ...emptyPlan(dir), blocked: { reason: "duplicates", keys: dups } };
  const plan = emptyPlan(dir);
  const warned = new Set<string>();
  for (const locale of session.data.locales) {
    const out: Record<string, unknown> = { $schema: MESSAGE_SCHEMA };
    for (const id of session.data.keyOrder) {
      const { key } = parseKeyId(id);
      const v = session.value(id, locale);
      if (!isTranslated(v)) continue;
      out[key] = v!.kind === "text" ? toParaglide(v!.text, () => warned.add(key)) : v!.raw;
    }
    plan.files.push({ path: joinPath(dir, "messages", `${locale}.json`), text: json(out) });
  }
  plan.files.push({
    path: joinPath(dir, "project.inlang/settings.json"),
    text: paraglideSettingsText(session.data.baseLocale, session.data.locales),
  });
  plan.warnings = [...warned].map((k) => `Format modifier dropped in ${k}`);
  return plan;
}
