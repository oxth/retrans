import { hashValue } from "../core/hash";
import type { Format, KeyId } from "../core/model";
import type { ProjectSession } from "../core/session";

export const MANIFEST_PATH = ".retrans/package.json";

export interface CellSnapshot { v: string; s?: "translated" | "reviewed"; m?: true }

export interface PackageManifest {
  retransPackage: 1;
  format: Format;
  baseLocale: string;
  /** Target locales only; the base locale is always included in the package files. */
  locales: string[];
  localesPath: string;
  exportedAt: string;
  sourceProjectId: string;
  baseline: Record<KeyId, Record<string, CellSnapshot>>;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseBaseline(raw: unknown): PackageManifest["baseline"] | null {
  if (!isRecord(raw)) return null;
  const out: PackageManifest["baseline"] = {};
  for (const [id, cells] of Object.entries(raw)) {
    if (!isRecord(cells)) return null;
    const row: Record<string, CellSnapshot> = {};
    for (const [loc, c] of Object.entries(cells)) {
      if (!isRecord(c) || typeof c.v !== "string") return null;
      const snap: CellSnapshot = { v: c.v };
      if (c.s === "translated" || c.s === "reviewed") snap.s = c.s;
      if (c.m === true) snap.m = true;
      row[loc] = snap;
    }
    out[id] = row;
  }
  return out;
}

/** Returns null for missing or invalid input; never throws. */
export function parseManifest(text: string | null): PackageManifest | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.startsWith("﻿") ? text.slice(1) : text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.retransPackage !== 1) return null;
  if (raw.format !== "next-i18next" && raw.format !== "paraglide") return null;
  if (typeof raw.baseLocale !== "string" || typeof raw.localesPath !== "string") return null;
  if (typeof raw.exportedAt !== "string" || typeof raw.sourceProjectId !== "string") return null;
  if (!Array.isArray(raw.locales) || !raw.locales.every((l) => typeof l === "string")) return null;
  const baseline = parseBaseline(raw.baseline);
  if (!baseline) return null;
  return {
    retransPackage: 1,
    format: raw.format,
    baseLocale: raw.baseLocale,
    locales: raw.locales as string[],
    localesPath: raw.localesPath,
    exportedAt: raw.exportedAt,
    sourceProjectId: raw.sourceProjectId,
    baseline,
  };
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

export function serializeManifest(m: PackageManifest): string {
  return JSON.stringify(sorted(m as unknown as Json), null, 2) + "\n";
}

/** Value hash and status of every cell, so an import can tell what the translator changed. */
export function snapshotCells(session: ProjectSession, locales: string[]): PackageManifest["baseline"] {
  const out: PackageManifest["baseline"] = {};
  for (const id of session.data.keyOrder) {
    for (const locale of locales) {
      const value = session.value(id, locale);
      const entry = session.state.entries[id]?.[locale];
      if (!value && !entry) continue;
      const cell: CellSnapshot = { v: hashValue(value) };
      if (entry) {
        cell.s = entry.s;
        if (entry.m) cell.m = true;
      }
      (out[id] ??= {})[locale] = cell;
    }
  }
  return out;
}
