/**
 * Designer preview files (spec: Figma preview plugin). Retrans writes a preview bundle of drafts for
 * one language; the Figma plugin writes back a results file with a verdict per string. This module
 * has no imports: the plugin bundles it as is.
 */

export interface PreviewString {
  key: string;
  /** Absent for strings a tool other than Figma will match by key. */
  figmaVariableId?: string;
  base: string;
  text: string;
  /** hashValue of the draft, so results can tell whether it changed since. */
  hash: string;
  status: "translated" | "reviewed";
  machine: boolean;
}

export interface PreviewBundle {
  retransPreview: 1;
  sourceProjectId: string;
  exportedAt: string;
  baseLocale: string;
  locale: string;
  strings: PreviewString[];
}

export type Verdict = "fits" | "too-long";
export type PreviewFlag = "overflow" | "font-missing" | null;

export interface PreviewResult {
  key: string;
  hash: string;
  verdict: Verdict;
  note?: string;
  flag: PreviewFlag;
}

export interface PreviewResults {
  retransPreviewResults: 1;
  sourceProjectId: string;
  locale: string;
  checkedAt: string;
  results: PreviewResult[];
}

type Parsed<K extends string, T> = ({ ok: true } & Record<K, T>) | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";

function parseJson(text: string): { ok: true; raw: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, raw: JSON.parse(text.startsWith("﻿") ? text.slice(1) : text) };
  } catch (err) {
    return { ok: false, error: `not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
}

function versionError(raw: Record<string, unknown>, marker: string, what: string): string | null {
  const v = raw[marker];
  if (v === 1) return null;
  if (typeof v === "number" && v > 1) return `This ${what} was made by a newer version of Retrans. Update Retrans and try again.`;
  return `This isn't a Retrans ${what}.`;
}

function parseString(v: unknown): PreviewString | null {
  if (!isRecord(v)) return null;
  const { key, figmaVariableId, base, text, hash, status, machine } = v;
  if (!isString(key) || !isString(base) || !isString(text) || !isString(hash)) return null;
  if (status !== "translated" && status !== "reviewed") return null;
  if (typeof machine !== "boolean") return null;
  if (figmaVariableId !== undefined && !isString(figmaVariableId)) return null;
  return { key, ...(isString(figmaVariableId) ? { figmaVariableId } : {}), base, text, hash, status, machine };
}

export function parseBundle(text: string): Parsed<"bundle", PreviewBundle> {
  const json = parseJson(text);
  if (!json.ok) return json;
  const raw = json.raw;
  if (!isRecord(raw)) return { ok: false, error: "This isn't a Retrans preview file." };
  const bad = versionError(raw, "retransPreview", "preview file");
  if (bad) return { ok: false, error: bad };
  const { sourceProjectId, exportedAt, baseLocale, locale, strings } = raw;
  if (!isString(sourceProjectId) || !isString(exportedAt) || !isString(baseLocale) || !isString(locale) || !Array.isArray(strings)) {
    return { ok: false, error: "This preview file is incomplete." };
  }
  const parsed = strings.map(parseString);
  const i = parsed.findIndex((s) => s === null);
  if (i >= 0) return { ok: false, error: `String ${i + 1} in this preview file is incomplete.` };
  return { ok: true, bundle: { retransPreview: 1, sourceProjectId, exportedAt, baseLocale, locale, strings: parsed as PreviewString[] } };
}

function parseResult(v: unknown): PreviewResult | null {
  if (!isRecord(v)) return null;
  const { key, hash, verdict, note, flag } = v;
  if (!isString(key) || !isString(hash)) return null;
  if (verdict !== "fits" && verdict !== "too-long") return null;
  return {
    key,
    hash,
    verdict,
    ...(isString(note) && note.trim() ? { note } : {}),
    flag: flag === "overflow" || flag === "font-missing" ? flag : null,
  };
}

export function parseResults(text: string): Parsed<"results", PreviewResults> {
  const json = parseJson(text);
  if (!json.ok) return json;
  const raw = json.raw;
  if (!isRecord(raw)) return { ok: false, error: "This isn't a Retrans results file." };
  const bad = versionError(raw, "retransPreviewResults", "results file");
  if (bad) return { ok: false, error: bad };
  const { sourceProjectId, locale, checkedAt, results } = raw;
  if (!isString(sourceProjectId) || !isString(locale) || !isString(checkedAt) || !Array.isArray(results)) {
    return { ok: false, error: "This results file is incomplete." };
  }
  const list = results.flatMap((r) => {
    const p = parseResult(r);
    return p ? [p] : [];
  });
  return { ok: true, results: { retransPreviewResults: 1, sourceProjectId, locale, checkedAt, results: list } };
}

export function serializePreview(v: PreviewBundle | PreviewResults): string {
  return JSON.stringify(v, null, 2) + "\n";
}
