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
  | { kind: "remove"; key: string };

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
 * - `remove` deletes the property (its whole line when it sits on its own line) from
 *   every object (split) or the pair (table).
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

  const remove = (key: string) => {
    const targets = module.style === "split" ? module.objects : tables;
    for (const ref of targets) {
      for (const p of nodeOf(ref).properties as Node[]) {
        if (propName(p) !== key) continue;
        const s = removals.get(ref) ?? new Set<Node>();
        s.add(p);
        removals.set(ref, s);
      }
    }
  };

  for (const e of edits) {
    if (e.kind === "set") set(e.key, e.locale, e.value);
    else if (e.kind === "add") add(e.key, e.values);
    else remove(e.key);
  }

  const splices: Splice[] = [...literalSets.values()];

  // Removals first (per object), so insertions can see which properties remain.
  const removalRanges: Splice[] = [];
  for (const [ref, removed] of removals) {
    const props = nodeOf(ref).properties as Node[];
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

  for (const [ref, props] of inserts) {
    const node = nodeOf(ref);
    const all = node.properties as Node[];
    const removed = removals.get(ref) ?? new Set<Node>();
    const remaining = all.filter((p) => !removed.has(p));
    const last = all[all.length - 1];
    const multiLine = text.slice(ref.open, ref.close).includes("\n");

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

    if (!multiLine) {
      if (ref.trailingComma) {
        const c = skipBlanks(text, last.end);
        splices.push({ start: c + 1, end: c + 1, text: props.map((p) => ` ${p},`).join(""), seq: seq++ });
      } else {
        splices.push({ start: last.end, end: last.end, text: props.map((p) => `, ${p}`).join(""), seq: seq++ });
      }
      continue;
    }

    // Multi-line: make sure the last remaining property ends with a comma.
    if (remaining.length > 0 && !ref.trailingComma && !removed.has(last)) {
      splices.push({ start: last.end, end: last.end, text: ",", seq: seq++ });
    }
    const at = lineStart(text, ref.close);
    if (/^[ \t]*$/.test(text.slice(at, ref.close))) {
      splices.push({ start: at, end: at, text: props.map((p) => `${ref.propIndent}${p},${eol}`).join(""), seq: seq++ });
    } else {
      // `}` shares a line with the last property: continue on new lines after it.
      let after = last.end;
      if (ref.trailingComma) after = skipBlanks(text, last.end) + 1;
      splices.push({ start: after, end: after, text: props.map((p) => `${eol}${ref.propIndent}${p},`).join(""), seq: seq++ });
    }
  }

  return stitch(text, splices);
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

/** A JS identifier from a group name: `change-password` → `changePassword`. */
function groupIdent(group: string): string {
  const parts = group.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
  let id = parts.map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1))).join("");
  if (id === "" || /^[0-9]/.test(id)) id = "_" + id;
  return id;
}

/** A new table-style module (fixture style: 2-space indent, single quotes, `mapLocale`). */
export function newTableModule(
  group: string,
  values: Record<string, Record<string, string>>,
  locales: string[],
): string {
  const id = groupIdent(group);
  const rows: string[] = [];
  for (const [key, vals] of Object.entries(values)) {
    const pair = pairText(vals, locales);
    if (pair) rows.push(`  ${keyText(key)}: ${pair},`);
  }
  return [
    "import { mapLocale } from '@/assets/locales/mapLocale';",
    "",
    `const ${id} = {`,
    ...rows,
    "};",
    "",
    ...locales.map((l) => `export const ${id}${l.toUpperCase()} = mapLocale(${id}, ${encodeTsString(l, "'")});`),
    "",
  ].join("\n");
}

/** The import lines plus, per locale, the spread lines to paste into `i18n.ts`. */
export function i18nSnippet(groups: string[], locales: string[]): string {
  const imports = groups.map((g) => {
    const id = groupIdent(g);
    const names = locales.map((l) => `${id}${l.toUpperCase()}`).join(", ");
    return `import { ${names} } from '@/assets/locales/${g}';`;
  });
  const blocks = locales.map(
    (l) =>
      `// resources.${l}.translation:\n` +
      groups.map((g) => `...${groupIdent(g)}${l.toUpperCase()},`).join("\n") +
      "\n",
  );
  return [imports.join("\n") + "\n", ...blocks].join("\n");
}
