import type { KeyId } from "../core/model";

export const WORKSPACE_META_PATH = ".retrans/workspace.json";
export const WORKSPACE_DIR = ".retrans/workspace";
export const BASELINE_PATH = ".retrans/source-baseline.json";

/** The TypeScript locale files a workspace was imported from. `localesDir` is root-relative. */
export interface TsSourceRef {
  type: "ts";
  localesDir: string;
}

export type ExportTarget =
  | { kind: "ts-writeback" }
  | { kind: "ts-copy"; dir: string }
  | { kind: "ts-modules"; dir: string }
  | { kind: "i18next-json"; dir: string; namespaces: "per-group" | "single" }
  | { kind: "paraglide"; dir: string };

export interface ExportSettings {
  target: ExportTarget;
}

export interface WorkspaceMeta {
  retransWorkspace: 1;
  name: string;
  source?: TsSourceRef;
  /**
   * A `source` whose `localesDir` is absolute or leaves the project (`..`): never used, but
   * written back as `source` so the file keeps it. Set only by parseWorkspaceMeta.
   */
  invalidSource?: TsSourceRef;
  drafts: Record<KeyId, Record<string, string>>;
  markers: Record<KeyId, Record<string, string>>;
  removedInSource: KeyId[];
  duplicates: string[];
  /** Source keys with no value in any language (only markers / `undefined`), sorted; they have no workspace values. */
  emptyKeys: KeyId[];
  /**
   * Keys renamed in Retrans: source (old) id -> workspace (new) id, chains collapsed. Sync maps
   * source ids through it; write-back (Task 8) turns each into remove-old + add-new, then clears it.
   */
  renames: Record<KeyId, KeyId>;
  /**
   * Source keys (source ids, before any rename) whose rows were deleted in Retrans. Sync never
   * brings them back; write-back removes them from the source files, then clears them.
   */
  deletedKeys: KeyId[];
  lastExport?: ExportSettings;
}

/** Key id -> locale -> source text, as last imported from / exported to the source. */
export type Baseline = Record<KeyId, Record<string, string>>;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJsonText(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text.startsWith("﻿") ? text.slice(1) : text);
  } catch {
    return undefined;
  }
}

/** Record<string, Record<string, string>>, dropping anything that isn't. */
function stringTable(v: unknown): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  if (!isRecord(v)) return out;
  for (const [id, cells] of Object.entries(v)) {
    if (!isRecord(cells)) continue;
    const row: Record<string, string> = {};
    for (const [loc, s] of Object.entries(cells)) if (typeof s === "string") row[loc] = s;
    if (Object.keys(row).length) out[id] = row;
  }
  return out;
}

function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(v)) for (const [k, s] of Object.entries(v)) if (typeof s === "string") out[k] = s;
  return out;
}

const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function parseTarget(v: unknown): ExportTarget | undefined {
  if (!isRecord(v)) return undefined;
  const dir = typeof v.dir === "string" ? v.dir : undefined;
  switch (v.kind) {
    case "ts-writeback":
      return { kind: "ts-writeback" };
    case "ts-copy":
    case "ts-modules":
    case "paraglide":
      return dir === undefined ? undefined : { kind: v.kind, dir };
    case "i18next-json":
      return dir !== undefined && (v.namespaces === "per-group" || v.namespaces === "single")
        ? { kind: "i18next-json", dir, namespaces: v.namespaces }
        : undefined;
    default:
      return undefined;
  }
}

/** A root-relative folder that stays inside the root: not absolute (`/`, `\\`, `C:`), no `..` segment. */
export function isSafeLocalesDir(dir: string): boolean {
  if (/^[\\/]/.test(dir) || /^[A-Za-z]:/.test(dir)) return false;
  return !dir.split(/[\\/]/).includes("..");
}

/**
 * null for a missing file or anything that isn't a version-1 workspace meta. Never throws. An
 * unsafe `source.localesDir` (see isSafeLocalesDir) goes to `invalidSource`, not `source`.
 */
export function parseWorkspaceMeta(text: string | null): WorkspaceMeta | null {
  const raw = parseJsonText(text);
  if (!isRecord(raw) || raw.retransWorkspace !== 1 || typeof raw.name !== "string") return null;
  const meta: WorkspaceMeta = {
    retransWorkspace: 1,
    name: raw.name,
    drafts: stringTable(raw.drafts),
    markers: stringTable(raw.markers),
    removedInSource: stringList(raw.removedInSource),
    duplicates: stringList(raw.duplicates),
    emptyKeys: stringList(raw.emptyKeys),
    renames: stringMap(raw.renames),
    deletedKeys: stringList(raw.deletedKeys),
  };
  const src = raw.source;
  if (isRecord(src) && src.type === "ts" && typeof src.localesDir === "string") {
    if (isSafeLocalesDir(src.localesDir)) meta.source = { type: "ts", localesDir: src.localesDir };
    else meta.invalidSource = { type: "ts", localesDir: src.localesDir };
  }
  const target = isRecord(raw.lastExport) ? parseTarget(raw.lastExport.target) : undefined;
  if (target) meta.lastExport = { target };
  return meta;
}

function sorted(v: Json): Json {
  if (Array.isArray(v)) return v.map(sorted);
  if (v !== null && typeof v === "object") {
    const o: { [k: string]: Json } = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = sorted(v[k]);
    return o;
  }
  return v;
}

const serialize = (v: unknown) => JSON.stringify(sorted(v as Json), null, 2) + "\n";

/** Order-insensitive equality of JSON-like values (object key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sorted((a ?? null) as Json)) === JSON.stringify(sorted((b ?? null) as Json));
}

export const WORKSPACE_META_ERROR =
  "Can't read .retrans/workspace.json — fix it (e.g. resolve merge markers) and open again.";

/** Sorted keys, 2-space indent, trailing newline (same style as serializeState). */
export function serializeWorkspaceMeta(m: WorkspaceMeta): string {
  const { invalidSource, ...rest } = m;
  return serialize(invalidSource && !rest.source ? { ...rest, source: invalidSource } : rest);
}

/** null for a missing or malformed file. Never throws. */
export function parseBaseline(text: string | null): Baseline | null {
  const raw = parseJsonText(text);
  return isRecord(raw) ? stringTable(raw) : null;
}

export function serializeBaseline(b: Baseline): string {
  return serialize(b);
}
