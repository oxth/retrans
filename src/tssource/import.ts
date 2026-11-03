/**
 * Reads a folder of TypeScript locale modules (spec §4, §6) into model data.
 * Read-only: never writes anything.
 */
import { type CellMap, type KeyId, keyId, type MessageValue } from "../core/model";
import { type Fs, joinPath } from "../platform/fs";
import type { Baseline, WorkspaceMeta } from "../workspace/meta";
import { type LocaleModule, parseLocaleModule } from "./parse";

export interface TsImport {
  /** Keyed by root-relative path, in path order. */
  modules: Map<string, { relPath: string; module: LocaleModule; text: string }>;
  /** Union across modules, base first. */
  locales: string[];
  /** Real values only: marker and `undefined` cells are absent (missing). */
  values: CellMap;
  /** Files sorted by path, then keys in source order. */
  keyOrder: KeyId[];
  drafts: WorkspaceMeta["drafts"];
  markers: WorkspaceMeta["markers"];
  /** Every source string value as written, markers included. */
  baseline: Baseline;
  /** Keys present in more than one group, sorted. */
  duplicates: string[];
  readOnly: Array<{ id: KeyId; reason: string }>;
  /** Files that failed to read or parse; they are skipped. */
  errors: Array<{ relPath: string; message: string }>;
}

/** Root-relative candidates, checked in order. */
const CANDIDATES = ["src/assets/locales", "src/locales", "src/i18n", "locales"];
const MAX_DEPTH = 8;

/** True when the trimmed value ends with ` (XX)` for this cell's locale. */
export function isMarker(value: string, locale: string): boolean {
  return value.trim().endsWith(` (${locale.toUpperCase()})`);
}

/** The text before the marker, trimmed. Only call when `isMarker` is true. */
function markerText(value: string, locale: string): string {
  const t = value.trim();
  return t.slice(0, t.length - ` (${locale.toUpperCase()})`.length).trim();
}

/** Locale-file candidates under `dir`, relative to `dir`, sorted. */
async function candidateFiles(fs: Fs, dir: string): Promise<string[]> {
  if (!(await fs.exists(dir))) return [];
  let files: string[];
  try {
    files = await fs.listFiles(dir, MAX_DEPTH);
  } catch {
    return [];
  }
  return files.filter(isLocaleFile).sort();
}

function isLocaleFile(rel: string): boolean {
  const parts = rel.split("/");
  const name = parts[parts.length - 1];
  if (parts.includes("__tests__")) return false;
  if (!/\.tsx?$/.test(name) || name.endsWith(".d.ts")) return false;
  if (/\.(test|spec)\./.test(name)) return false;
  if (/^mapLocale\.tsx?$/.test(name)) return false;
  return true;
}

export async function findLocalesDir(fs: Fs, root: string): Promise<string | null> {
  for (const cand of CANDIDATES) {
    const dir = joinPath(root, cand);
    for (const rel of await candidateFiles(fs, dir)) {
      try {
        if (parseLocaleModule(await fs.readText(joinPath(dir, rel)), rel)) return cand;
      } catch {
        // unreadable or unparsable: not evidence either way
      }
    }
  }
  return null;
}

export async function importTsLocales(
  fs: Fs,
  root: string,
  localesDir: string,
  baseLocale: string,
): Promise<TsImport> {
  const out: TsImport = {
    modules: new Map(),
    locales: [baseLocale],
    values: new Map(),
    keyOrder: [],
    drafts: {},
    markers: {},
    baseline: {},
    duplicates: [],
    readOnly: [],
    errors: [],
  };
  const dir = joinPath(root, localesDir);
  const relPaths = (await candidateFiles(fs, dir)).map((rel) => joinPath(localesDir, rel)).sort();

  for (const relPath of relPaths) {
    let text: string;
    let module: LocaleModule | null;
    try {
      text = await fs.readText(joinPath(root, relPath));
      module = parseLocaleModule(text, relPath);
    } catch (e) {
      out.errors.push({ relPath, message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!module) continue;
    out.modules.set(relPath, { relPath, module, text });
    for (const loc of module.locales) if (!out.locales.includes(loc)) out.locales.push(loc);
  }

  const seen = new Set<KeyId>();
  const groupsByKey = new Map<string, Set<string>>();
  const addKey = (group: string, key: string): KeyId => {
    const id = keyId(group, key);
    if (!seen.has(id)) {
      seen.add(id);
      out.keyOrder.push(id);
      const gs = groupsByKey.get(key) ?? new Set<string>();
      gs.add(group);
      groupsByKey.set(key, gs);
    }
    return id;
  };

  for (const { module } of out.modules.values()) {
    const { group } = module;
    // Source order. Entries come in source order per object; read-only keys have no offset,
    // so they follow — except in a table, where each key's pair object gives its position.
    const order: string[] = [];
    for (const e of module.entries) if (!order.includes(e.key)) order.push(e.key);
    for (const r of module.readOnly) if (!order.includes(r.key)) order.push(r.key);
    const pairs = module.pairObjects;
    if (pairs) {
      const pos = (k: string) => pairs[k]?.open ?? Number.POSITIVE_INFINITY;
      order.sort((a, b) => pos(a) - pos(b));
    }
    for (const k of order) addKey(group, k);

    // Base value per key (marker stripped), for draft comparison.
    const baseOf = new Map<string, string>();
    for (const e of module.entries) {
      if (e.locale !== baseLocale || e.undefinedLiteral) continue;
      baseOf.set(e.key, isMarker(e.value, e.locale) ? markerText(e.value, e.locale) : e.value.trim());
    }

    for (const e of module.entries) {
      const id = keyId(group, e.key);
      let cells = out.values.get(id);
      if (!cells) out.values.set(id, (cells = new Map<string, MessageValue>()));
      if (e.undefinedLiteral) continue;
      (out.baseline[id] ??= {})[e.locale] = e.value;
      if (isMarker(e.value, e.locale)) {
        (out.markers[id] ??= {})[e.locale] = e.value;
        const draft = markerText(e.value, e.locale);
        if (draft !== "" && draft !== (baseOf.get(e.key) ?? "")) (out.drafts[id] ??= {})[e.locale] = draft;
        continue;
      }
      cells.set(e.locale, { kind: "text", text: e.value });
    }

    for (const r of module.readOnly) {
      out.readOnly.push({ id: keyId(group, r.key), reason: r.locale ? `${r.locale}: ${r.reason}` : r.reason });
    }
  }

  out.duplicates = [...groupsByKey].filter(([, gs]) => gs.size > 1).map(([k]) => k).sort();
  return out;
}
