export type Format = "next-i18next" | "paraglide";
export type Status = "untranslated" | "translated" | "reviewed";
export type MessageValue = { kind: "text"; text: string } | { kind: "complex"; raw: unknown };
export type KeyId = string; // `${ns}::${key}`; ns is "" for Paraglide; key is dotted

export function keyId(ns: string, key: string): KeyId {
  return `${ns}::${key}`;
}

export function parseKeyId(id: KeyId): { ns: string; key: string } {
  const i = id.indexOf("::");
  if (i < 0) return { ns: "", key: id };
  return { ns: id.slice(0, i), key: id.slice(i + 2) };
}

export type CellMap = Map<KeyId, Map<string, MessageValue>>; // locale -> value; absent = untranslated

export interface ProjectData {
  format: Format;
  root: string;
  baseLocale: string;
  locales: string[]; // base first
  namespaces: string[]; // [""] for Paraglide
  keyOrder: KeyId[]; // base-file order, then keys only in other locales
  values: CellMap;
}

export interface CellMeta {
  status: Status;
  needsReview: boolean;
  machine: boolean;
}

export interface Warning {
  kind: "placeholder-missing" | "placeholder-extra" | "orphan";
  names?: string[];
}

/**
 * A cell counts as translated when it has a value that isn't the empty string. An empty string on
 * disk is shown and counted as missing, but stays on disk until that cell is edited.
 */
export function isTranslated(v: MessageValue | undefined): boolean {
  return v !== undefined && !(v.kind === "text" && v.text === "");
}

export function valuesEqual(a?: MessageValue, b?: MessageValue): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind === "text" && b.kind === "text") return a.text === b.text;
  if (a.kind === "complex" && b.kind === "complex") {
    return JSON.stringify(a.raw) === JSON.stringify(b.raw);
  }
  return false;
}
