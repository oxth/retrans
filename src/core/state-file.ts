import { isTranslated, type KeyId, type ProjectData } from "./model";

export interface StateEntry { s: "translated" | "reviewed"; h: string; m?: true }
export interface StateFile {
  version: 1;
  /**
   * Explicit user overrides only: a Settings-page locales path, and the base language the user
   * picked when detection couldn't tell. Detected values are never stored here.
   */
  project: { baseLocale?: string; localesPath?: string };
  entries: Record<KeyId, Record<string, StateEntry>>;
}
export const STATE_PATH = ".retrans/state.json";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isEntry(v: unknown): v is StateEntry {
  return isRecord(v) && (v.s === "translated" || v.s === "reviewed") && typeof v.h === "string";
}

/**
 * A missing file (null) is an empty state. Text that isn't a version-1 state object comes back as
 * an empty state plus `error`: callers must not overwrite such a file (it may hold merge markers).
 */
export function parseState(text: string | null): { state: StateFile; error?: string } {
  const empty = (): StateFile => ({ version: 1, project: {}, entries: {} });
  if (text === null) return { state: empty() };
  let raw: unknown;
  try {
    raw = JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
  } catch (err) {
    return { state: empty(), error: `not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (!isRecord(raw)) return { state: empty(), error: "not a JSON object" };
  if (raw.version !== 1) return { state: empty(), error: `unsupported version ${JSON.stringify(raw.version)}` };
  const p = isRecord(raw.project) ? raw.project : {};
  const project = {
    ...(typeof p.baseLocale === "string" ? { baseLocale: p.baseLocale } : {}),
    ...(typeof p.localesPath === "string" ? { localesPath: p.localesPath } : {}),
  };
  const entries: StateFile["entries"] = {};
  if (isRecord(raw.entries)) {
    for (const [id, cells] of Object.entries(raw.entries)) {
      if (!isRecord(cells)) continue;
      const out: Record<string, StateEntry> = {};
      for (const [loc, e] of Object.entries(cells)) {
        if (!isEntry(e)) continue;
        out[loc] = e.m ? { s: e.s, h: e.h, m: true } : { s: e.s, h: e.h };
      }
      if (Object.keys(out).length) entries[id] = out;
    }
  }
  return { state: { version: 1, project, entries } };
}

function sorted(v: Json): Json {
  if (Array.isArray(v)) return v.map(sorted);
  if (v !== null && typeof v === "object") {
    const o: { [k: string]: Json } = {};
    for (const k of Object.keys(v).sort()) o[k] = sorted(v[k]);
    return o;
  }
  return v;
}

export function serializeState(s: StateFile): string {
  return JSON.stringify(sorted(s as unknown as Json), null, 2) + "\n";
}

export function reconcile(s: StateFile, data: ProjectData): StateFile {
  const keys = new Set(data.keyOrder);
  const locales = new Set(data.locales);
  const entries: StateFile["entries"] = {};
  for (const [id, cells] of Object.entries(s.entries)) {
    if (!keys.has(id)) continue;
    const out: Record<string, StateEntry> = {};
    for (const [loc, e] of Object.entries(cells)) {
      if (loc === data.baseLocale || !locales.has(loc)) continue;
      if (!isTranslated(data.values.get(id)?.get(loc))) continue;
      out[loc] = { ...e };
    }
    if (Object.keys(out).length) entries[id] = out;
  }
  return { version: 1, project: { ...s.project }, entries };
}
