/**
 * Minimal-diff writer for TypeScript locale modules (spec §4, §8.1).
 *
 * Edits splice the original text at offsets taken from `parseLocaleModule`, so every
 * byte outside an edited literal, an inserted property or a removed property stays
 * as it was (quotes, indentation, comments, line endings, a leading BOM).
 */
import { parse } from "@babel/parser";
import type { LocaleModule, Quote, TsObjectRef } from "./parse";

export type TsEdit =
  | { kind: "set"; key: string; locale: string; value: string }
  | { kind: "add"; key: string; values: Record<string, string> }
  /** Without `locale`: the whole key. With `locale`: only that language's property (split) or pair field (table). */
  | { kind: "remove"; key: string; locale?: string }
  /**
   * Several languages of one key at once: a string sets that language, `null` removes it,
   * languages not listed are left alone. Lets a caller send one edit per key when a key
   * needs both sets and removals.
   */
  | { kind: "replace"; key: string; values: Record<string, string | null> };

/** Loose view of a Babel AST node; only the fields this module reads. */
interface Node {
  type: string;
  start: number;
  end: number;
  [field: string]: any;
}

interface Splice {
  start: number;
  end: number;
  text: string;
  seq: number;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A valid string literal in the given quote style. Only `\`, the quote, `\n`, `\t` and `\r` are escaped. */
export function encodeTsString(value: string, quote: Quote): string {
  let out = quote;
  for (const ch of value) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + quote;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else out += ch;
  }
  return out + quote;
}

/** A property key: bare when it is an identifier, otherwise a single-quoted string. */
function keyText(key: string): string {
  return IDENT.test(key) ? key : encodeTsString(key, "'");
}

const hasValue = (v: string | undefined): v is string => v !== undefined && v !== "";

/**
 * Applies `edits` to `text` (which `module` was parsed from). Rules:
 * - `set` replaces an existing literal (keeping its quote; an `undefined` token becomes a
 *   single-quoted literal), or inserts the language into the key's object(s). A language
 *   the file has no object/pair column for is skipped. A `set` on a key the file lacks
 *   acts as `add`. A `set` on a read-only value throws.
 * - `add` appends the key at the end of every language object (split) or as one
 *   `{ locale: value }` pair (table). Empty values and unknown languages are skipped.
 *   `add` on a key the file already has acts as a `set` per language.
 * - `replace` applies a `set` per string and a per-language `remove` per `null`
 *   (an `add` when the key is new).
 * - A whole-key `remove` together with any other edit of that key throws. The result is
 *   re-parsed; edits that would produce invalid syntax throw instead of returning it.
 * - `remove` deletes the property (its whole line when it sits on its own line) from
 *   every object (split) or the pair (table). With a `locale`, only that language's
 *   object (split) or that field of the key's pair (table) loses it.
 */
export function applyTsEdits(text: string, module: LocaleModule, edits: TsEdit[]): string {
  if (edits.length === 0) return text;

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const nodes = objectNodes(text);
  const nodeOf = (ref: TsObjectRef): Node => {
    const n = nodes.get(ref.open);
    if (!n) throw new Error(`object at offset ${ref.open} not found`);
    return n;
  };

  const literalSets = new Map<number, Splice>(); // by range start; a later set wins
  const inserts = new Map<TsObjectRef, string[]>();
  const removals = new Map<TsObjectRef, Set<Node>>();
  let seq = 0;

  const queueInsert = (ref: TsObjectRef, prop: string) => {
    const list = inserts.get(ref) ?? [];
    list.push(prop);
    inserts.set(ref, list);
  };
  const tables = module.objects.filter((o) => o.locale === null);
  const keyExists = (key: string) =>
    module.entries.some((e) => e.key === key) ||
    module.readOnly.some((r) => r.key === key) ||
    (module.pairObjects !== undefined && key in module.pairObjects);

  const set = (key: string, locale: string, value: string) => {
    const hits = module.entries.filter((e) => e.key === key && e.locale === locale);
    if (hits.length > 0) {
      for (const e of hits) {
        const quote: Quote = e.undefinedLiteral ? "'" : e.quote;
        literalSets.set(e.range[0], {
          start: e.range[0],
          end: e.range[1],
          text: encodeTsString(value, quote),
          seq: seq++,
        });
      }
      return;
    }
    const ro = module.readOnly.find(
      (r) => r.key === key && (module.style === "table" || r.locale === locale),
    );
    if (ro) throw new Error(`can't edit ${module.group} › ${key} (${locale}): ${ro.reason}`);

    if (module.style === "split") {
      const obj = module.objects.find((o) => o.locale === locale);
      if (obj) queueInsert(obj, `${keyText(key)}: ${encodeTsString(value, "'")}`);
      return;
    }
    if (!module.locales.includes(locale)) return;
    const pair = module.pairObjects?.[key];
    if (pair) queueInsert(pair, `${keyText(locale)}: ${encodeTsString(value, "'")}`);
    else add(key, { [locale]: value });
  };

  const add = (key: string, values: Record<string, string>) => {
    if (keyExists(key)) {
      for (const [loc, v] of Object.entries(values)) if (hasValue(v)) set(key, loc, v);
      return;
    }
    if (module.style === "split") {
      for (const obj of module.objects) {
        const v = values[obj.locale!];
        if (hasValue(v)) queueInsert(obj, `${keyText(key)}: ${encodeTsString(v, "'")}`);
      }
      return;
    }
    const pair = pairText(values, module.locales);
    if (pair && tables.length > 0) queueInsert(tables[0], `${keyText(key)}: ${pair}`);
  };

  const queueRemoval = (ref: TsObjectRef, name: string) => {
    for (const p of nodeOf(ref).properties as Node[]) {
      if (propName(p) !== name) continue;
      const s = removals.get(ref) ?? new Set<Node>();
      s.add(p);
      removals.set(ref, s);
    }
  };

  const remove = (key: string, locale?: string) => {
    if (locale !== undefined) {
      const ro = module.readOnly.find((r) => r.key === key && (module.style === "table" || r.locale === locale));
      if (ro) throw new Error(`can't edit ${module.group} › ${key} (${locale}): ${ro.reason}`);
    }
    if (locale !== undefined && module.style === "table") {
      const pair = module.pairObjects?.[key];
      if (pair) queueRemoval(pair, locale);
      return;
    }
    const targets =
      module.style === "split" ? module.objects.filter((o) => locale === undefined || o.locale === locale) : tables;
    for (const ref of targets) queueRemoval(ref, key);
  };

  const replace = (key: string, values: Record<string, string | null>) => {
    if (!keyExists(key)) {
      const vals: Record<string, string> = {};
      for (const [loc, v] of Object.entries(values)) if (v !== null) vals[loc] = v;
      add(key, vals);
      return;
    }
    for (const [loc, v] of Object.entries(values)) {
      if (v === null) remove(key, loc);
      else set(key, loc, v);
    }
  };

  // A key removed whole can't also be edited in the same call (the edits would overlap).
  const removedWhole = new Set(edits.filter((e) => e.kind === "remove" && e.locale === undefined).map((e) => e.key));
  for (const e of edits) {
    if (removedWhole.has(e.key) && !(e.kind === "remove" && e.locale === undefined)) {
      throw new Error(`conflicting edits for ${module.group} › ${e.key}: removed and edited in one call`);
    }
  }

  for (const e of edits) {
    if (e.kind === "set") set(e.key, e.locale, e.value);
    else if (e.kind === "add") add(e.key, e.values);
    else if (e.kind === "replace") replace(e.key, e.values);
    else remove(e.key, e.locale);
  }

  const splices: Splice[] = [...literalSets.values()];

  // Removals first (per object), so insertions can see which properties remain.
  const removalRanges: Splice[] = [];
  /** Objects whose every property is removed and that also get insertions: their inside is rewritten whole. */
  const emptied = new Set<TsObjectRef>();
  for (const [ref, removed] of removals) {
    const props = nodeOf(ref).properties as Node[];
    if (inserts.has(ref) && props.every((p) => removed.has(p))) {
      emptied.add(ref);
      continue;
    }
    let lastWasLine = false;
    for (const p of props) {
      if (!removed.has(p)) continue;
      const r = removalRange(text, p);
      removalRanges.push({ start: r.start, end: r.end, text: "", seq: seq++ });
      if (p === props[props.length - 1]) lastWasLine = r.line;
    }
    // Keep a no-trailing-comma object that way: drop the comma after the new last property.
    const remaining = props.filter((p) => !removed.has(p));
    const last = props[props.length - 1];
    if (
      !inserts.has(ref) &&
      !ref.trailingComma &&
      removed.has(last) &&
      lastWasLine &&
      remaining.length > 0
    ) {
      const c = skipBlanks(text, remaining[remaining.length - 1].end);
      if (text[c] === ",") removalRanges.push({ start: c, end: c + 1, text: "", seq: seq++ });
    }
  }
  splices.push(...mergeDeletions(removalRanges));

  const removedAt = (pos: number) => removalRanges.some((r) => r.start <= pos && pos < r.end);

  for (const [ref, props] of inserts) {
    const node = nodeOf(ref);
    const all = node.properties as Node[];
    const removed = removals.get(ref) ?? new Set<Node>();
    const remaining = all.filter((p) => !removed.has(p));
    const last = all[all.length - 1];
    const multiLine = text.slice(ref.open, ref.close).includes("\n");

    if (emptied.has(ref)) {
      // Every property goes: rewrite the inside of the braces.
      let inner: string;
      if (multiLine) {
        const at = lineStart(text, ref.close);
        const closeIndent = /^[ \t]*$/.test(text.slice(at, ref.close)) ? text.slice(at, ref.close) : "";
        inner = eol + props.map((p) => `${ref.propIndent}${p},${eol}`).join("") + closeIndent;
      } else {
        inner = ` ${props.join(", ")} `;
      }
      splices.push({ start: ref.open + 1, end: ref.close, text: inner, seq: seq++ });
      continue;
    }

    if (all.length === 0) {
      const inner = text.slice(ref.open + 1, ref.close);
      if (multiLine) {
        const at = lineStart(text, ref.close);
        if (/^[ \t]*$/.test(text.slice(at, ref.close))) {
          splices.push({ start: at, end: at, text: props.map((p) => `${ref.propIndent}${p},${eol}`).join(""), seq: seq++ });
        } else {
          splices.push({ start: ref.close, end: ref.close, text: props.map((p) => `${eol}${ref.propIndent}${p},`).join("") + eol, seq: seq++ });
        }
      } else if (/^\s*$/.test(inner)) {
        splices.push({ start: ref.open + 1, end: ref.close, text: ` ${props.join(", ")} `, seq: seq++ });
      } else {
        splices.push({ start: ref.close, end: ref.close, text: ` ${props.join(", ")} `, seq: seq++ });
      }
      continue;
    }

    // The property new ones follow: the last one that stays.
    const anchor = remaining[remaining.length - 1];
    const c = skipBlanks(text, anchor.end);
    const anchorComma = text[c] === "," && !removedAt(c);

    if (!multiLine) {
      if (anchorComma && !removed.has(last)) {
        splices.push({ start: c + 1, end: c + 1, text: props.map((p) => ` ${p},`).join(""), seq: seq++ });
      } else {
        splices.push({ start: anchor.end, end: anchor.end, text: props.map((p) => `, ${p}`).join(""), seq: seq++ });
      }
      continue;
    }

    // Multi-line: make sure the last remaining property ends with a comma.
    if (!anchorComma) splices.push({ start: anchor.end, end: anchor.end, text: ",", seq: seq++ });
    const at = lineStart(text, ref.close);
    if (/^[ \t]*$/.test(text.slice(at, ref.close))) {
      splices.push({ start: at, end: at, text: props.map((p) => `${ref.propIndent}${p},${eol}`).join(""), seq: seq++ });
    } else {
      // `}` shares a line with the last property: continue on new lines after it.
      const after = anchorComma ? c + 1 : anchor.end;
      splices.push({ start: after, end: after, text: props.map((p) => `${eol}${ref.propIndent}${p},`).join(""), seq: seq++ });
    }
  }

  const out = stitch(text, splices);
  // Safety net: never hand back text that no longer parses.
  try {
    objectNodes(out);
  } catch (e) {
    throw new Error(`applyTsEdits produced invalid TypeScript for ${module.group}: ${e instanceof Error ? e.message : e}`);
  }
  return out;
}

/** `{ th: '…', en: '…' }` in `locales` order with only non-empty values, or null when none. */
function pairText(values: Record<string, string>, locales: string[]): string | null {
  const parts = locales
    .filter((l) => hasValue(values[l]))
    .map((l) => `${keyText(l)}: ${encodeTsString(values[l], "'")}`);
  return parts.length > 0 ? `{ ${parts.join(", ")} }` : null;
}

/**
 * The text a removed property occupies. When it sits alone on its line(s), the whole
 * line goes: leading indent, the property, its comma, a trailing `//` comment and the
 * line break. Otherwise (inline object) the property and one adjoining comma go.
 */
function removalRange(text: string, p: Node): { start: number; end: number; line: boolean } {
  let end = p.end;
  const c = skipBlanks(text, end);
  const hasComma = text[c] === ",";
  if (hasComma) end = c + 1;

  const ls = lineStart(text, p.start);
  if (/^[ \t]*$/.test(text.slice(ls, p.start))) {
    let k = skipBlanks(text, end);
    if (text.startsWith("//", k)) {
      const nl = text.indexOf("\n", k);
      k = nl < 0 ? text.length : text[nl - 1] === "\r" ? nl - 1 : nl;
    }
    if (text.startsWith("\r\n", k)) return { start: ls, end: k + 2, line: true };
    if (text[k] === "\n") return { start: ls, end: k + 1, line: true };
    if (k === text.length) return { start: ls, end: k, line: true };
  }
  if (hasComma) return { start: p.start, end: skipBlanks(text, end), line: false };
  // Last inline property without a comma: take the comma before it instead.
  let b = p.start;
  while (b > 0 && /\s/.test(text[b - 1])) b--;
  if (text[b - 1] === ",") return { start: b - 1, end: p.end, line: false };
  return { start: p.start, end: p.end, line: false };
}

/** Merges overlapping or touching deletions (e.g. two adjacent inline properties). */
function mergeDeletions(list: Splice[]): Splice[] {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const out: Splice[] = [];
  for (const s of sorted) {
    const prev = out[out.length - 1];
    if (prev && s.start < prev.end) prev.end = Math.max(prev.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/**
 * Builds the result from the original text and non-overlapping splices (offsets into
 * the original). Insertions at the same offset keep their queue order and come before a
 * replacement starting there.
 */
function stitch(text: string, splices: Splice[]): string {
  const sorted = [...splices].sort(
    (a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start) || a.seq - b.seq,
  );
  let out = "";
  let cursor = 0;
  for (const s of sorted) {
    if (s.start < cursor) throw new Error(`overlapping edits at offset ${s.start}`);
    out += text.slice(cursor, s.start) + s.text;
    cursor = s.end;
  }
  return out + text.slice(cursor);
}

function skipBlanks(text: string, pos: number): number {
  while (pos < text.length && (text[pos] === " " || text[pos] === "\t")) pos++;
  return pos;
}

function lineStart(text: string, pos: number): number {
  return text.lastIndexOf("\n", pos - 1) + 1;
}

function propName(p: Node): string | null {
  if (p.type !== "ObjectProperty" && p.type !== "ObjectMethod") return null;
  if (p.computed) return null;
  const k: Node = p.key;
  if (k.type === "Identifier") return k.name as string;
  if (k.type === "StringLiteral" || k.type === "NumericLiteral") return String(k.value);
  return null;
}

/** Every object literal in the file, by the offset of its `{`. */
function objectNodes(text: string): Map<number, Node> {
  const ast = parse(text, { sourceType: "module", plugins: ["typescript", "jsx"] }) as unknown as Node;
  const map = new Map<number, Node>();
  const SKIP = new Set(["loc", "extra", "leadingComments", "trailingComments", "innerComments", "comments", "tokens"]);
  const walk = (n: unknown) => {
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    if (!n || typeof n !== "object" || typeof (n as Node).type !== "string") return;
    const node = n as Node;
    if (node.type === "ObjectExpression") map.set(node.start, node);
    for (const [k, v] of Object.entries(node)) if (!SKIP.has(k) && v && typeof v === "object") walk(v);
  };
  walk(ast);
  return map;
}

const RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum",
  "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null",
  "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
  "let", "static", "implements", "interface", "package", "private", "protected", "public", "await", "arguments",
  "eval", "undefined", "NaN", "Infinity",
  "mapLocale", // the helper every generated module imports
]);

/** A JS identifier from an ASCII group name (`change-password` → `changePassword`); null for a non-ASCII one. */
function baseIdent(group: string): string | null {
  if (/[^\x00-\x7F]/.test(group)) return null;
  const parts = group.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
  let id = parts.map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1))).join("");
  if (id === "") return null;
  if (/^[0-9]/.test(id) || RESERVED.has(id)) id = "_" + id;
  return id;
}

/**
 * A unique identifier per group, for the generated `const` and export names: camelCased, `_` before
 * a reserved word or a leading digit, `group<N>` for a non-ASCII name, a number after a clash.
 */
export function groupIdents(groups: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  const fallback: string[] = [];
  for (const g of groups) {
    if (out.has(g)) continue;
    const base = baseIdent(g);
    if (base === null) {
      fallback.push(g);
      continue;
    }
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}${n}`;
    taken.add(id);
    out.set(g, id);
  }
  let n = 1;
  for (const g of fallback) {
    while (taken.has(`group${n}`)) n++;
    const id = `group${n}`;
    taken.add(id);
    out.set(g, id);
  }
  return out;
}

/** The export-name suffix for a locale: `TH` for `th`, `zhHant` for `zh-Hant`. */
export function localeSuffix(locale: string): string {
  if (/^[A-Za-z]+$/.test(locale)) return locale.toUpperCase();
  const parts = locale.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return parts.map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1))).join("") || "_";
}

/** The specifier a module imports `mapLocale` from (e.g. `@/assets/locales/mapLocale`), else null. */
export function mapLocaleImport(text: string): string | null {
  const m = /import\s*\{\s*mapLocale\s*\}\s*from\s*(['"])([^'"\n]+)\1/.exec(text);
  return m ? m[2] : null;
}

/**
 * A new table-style module (fixture style: 2-space indent, single quotes, `mapLocale`).
 * `mapLocaleFrom` is the import specifier of the `mapLocale` helper; `ident` the identifier for
 * the group (see groupIdents).
 */
export function newTableModule(
  group: string,
  values: Record<string, Record<string, string>>,
  locales: string[],
  mapLocaleFrom = "./mapLocale",
  ident = groupIdents([group]).get(group)!,
): string {
  const id = ident;
  const rows: string[] = [];
  for (const [key, vals] of Object.entries(values)) {
    const pair = pairText(vals, locales);
    if (pair) rows.push(`  ${keyText(key)}: ${pair},`);
  }
  return [
    `import { mapLocale } from ${encodeTsString(mapLocaleFrom, "'")};`,
    "",
    `const ${id} = {`,
    ...rows,
    "};",
    "",
    ...locales.map((l) => `export const ${id}${localeSuffix(l)} = mapLocale(${id}, ${encodeTsString(l, "'")});`),
    "",
  ].join("\n");
}

/**
 * The import lines plus, per locale, the spread lines to paste into `i18n.ts`. `from` is the
 * folder prefix of the import paths (as the `mapLocale` import has it, e.g. `@/assets/locales/`).
 */
export function i18nSnippet(groups: string[], locales: string[], from = "./", idents = groupIdents(groups)): string {
  const imports = groups.map((g) => {
    const id = idents.get(g)!;
    const names = locales.map((l) => `${id}${localeSuffix(l)}`).join(", ");
    return `import { ${names} } from ${encodeTsString(from + g, "'")};`;
  });
  const blocks = locales.map(
    (l) =>
      `// resources.${l}.translation:\n` +
      groups.map((g) => `...${idents.get(g)!}${localeSuffix(l)},`).join("\n") +
      "\n",
  );
  return [imports.join("\n") + "\n", ...blocks].join("\n");
}
