import type { FormatAdapter, LoadedFile } from "../formats/adapter";
import { emptyDocument, removeAt, setAt } from "./json-text";
import { type KeyId, type MessageValue, parseKeyId } from "./model";

export type KeyErrorCode = "exists" | "prefix-collision" | "invalid";

export class KeyError extends Error {
  code: KeyErrorCode;
  constructor(code: KeyErrorCode, message: string) {
    super(message);
    this.name = "KeyError";
    this.code = code;
  }
}

export function validateKey(key: string): void {
  if (!key || key.startsWith(".") || key.endsWith(".") || key.includes("..") || key.includes("::")) {
    throw new KeyError("invalid", `"${key}" is not a valid key`);
  }
}

/**
 * `key` collides with an existing key `e` of the same namespace if they are equal, or one is a
 * dotted prefix of the other. Keys in `ignore` (e.g. the key being renamed) are skipped.
 */
export function checkCollision(order: KeyId[], ns: string, key: string, ignore: Set<KeyId> = new Set()): void {
  for (const id of order) {
    if (ignore.has(id)) continue;
    const p = parseKeyId(id);
    if (p.ns !== ns) continue;
    if (p.key === key) throw new KeyError("exists", `"${key}" already exists`);
    if (p.key.startsWith(key + ".") || key.startsWith(p.key + ".")) {
      throw new KeyError("prefix-collision", `"${key}" collides with "${p.key}"`);
    }
  }
}

export function isValidLocale(locale: string): boolean {
  if (!locale || locale.includes("/") || locale.includes("\\")) return false;
  try {
    return Intl.getCanonicalLocales(locale).length === 1;
  } catch {
    return false;
  }
}

export interface CellChange {
  id: KeyId;
  key: string;
  value: MessageValue | undefined; // undefined = remove
}

/**
 * setAt keeps a one-line `{}` compact on insert. An empty document carries no layout to keep,
 * so open it up first and let inserts use the file's indent style.
 */
function expandEmpty(text: string, eol: string): string {
  return /^\s*\{\s*\}\s*$/.test(text) ? text.replace(/\{\s*\}/, "{" + eol + "}") : text;
}

/** A fresh, not-yet-on-disk file for (locale, ns), styled after the project's existing files. */
export function newFile(
  adapter: FormatAdapter,
  files: LoadedFile[],
  baseLocale: string,
  relPath: string,
  locale: string,
  ns: string,
): LoadedFile {
  const { style, shape, prefix } = adapter.newFileStyle(files);
  let text = emptyDocument(style);
  const entries = Object.entries(prefix ?? {});
  if (entries.length) text = expandEmpty(text, style.eol);
  for (const [k, v] of entries) text = setAt(text, [k], v, style);
  const segIndex = new Map<string, string[]>();
  if (shape === "nested") {
    const base = files.find((f) => f.locale === baseLocale && f.ns === ns && !f.readOnly && f.shape === "nested");
    if (base) for (const [k, p] of base.segIndex) segIndex.set(k, p);
  }
  return { relPath, locale, ns, text, style, readOnly: false, shape, segIndex };
}

/**
 * Fold changes into a file's text. Removals are applied first so a rename like `a` -> `a.b`
 * lands cleanly. Returns the new text and the updated segIndex.
 */
export function applyChanges(
  adapter: FormatAdapter,
  file: LoadedFile,
  changes: CellChange[],
): { text: string; segIndex: Map<string, string[]>; hasSet: boolean } {
  const segIndex = new Map(file.segIndex);
  const view: LoadedFile = { ...file, segIndex };
  let text = file.text;
  let hasSet = false;
  for (const ch of changes) {
    if (ch.value) continue;
    text = removeAt(text, adapter.jsonPath(view, ch.key), file.style);
    segIndex.delete(ch.key);
  }
  if (changes.some((ch) => ch.value)) text = expandEmpty(text, file.style.eol);
  for (const ch of changes) {
    if (!ch.value) continue;
    const path = adapter.jsonPath(view, ch.key);
    text = setAt(text, path, adapter.encode(ch.value), file.style);
    segIndex.set(ch.key, path);
    hasSet = true;
  }
  return { text, segIndex, hasSet };
}
