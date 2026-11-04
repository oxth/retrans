/**
 * Pure parser for TypeScript/TSX locale modules (spec §4).
 *
 * Recognises two shapes:
 * - split style: `export const <name><XX> = { key: 'value', ... }` (one object per language);
 * - table style: `const t = { key: { th: '…', en: '…' } }` exported via `mapLocale(t, '<locale>')`.
 *
 * Every offset indexes into the original `text` (a leading BOM included), so later
 * writers can splice string literals in place and leave everything else byte-for-byte.
 */
import { parse } from "@babel/parser";

export type Quote = "'" | '"';

export interface TsEntry {
  key: string;
  locale: string;
  /** Decoded exactly as JS would decode the literal. */
  value: string;
  /** `[start, end)` of the whole literal, quotes included. */
  range: [number, number];
  quote: Quote;
  /**
   * The source value is the identifier `undefined` (e.g. `{ th: undefined, en: '…' }`).
   * `value` is "", `range` covers the `undefined` token and `quote` is `'` (used when a
   * writer replaces the token with a literal). Import treats the cell as missing.
   */
  undefinedLiteral?: true;
}

export interface TsObjectRef {
  /** null for a table-style object (the table itself, or one of its `{ th, en }` pairs). */
  locale: string | null;
  exportName?: string;
  /** Offset of `{`. */
  open: number;
  /** Offset of `}`. */
  close: number;
  /**
   * Leading whitespace of the object's properties when they sit on their own lines.
   * For an empty or single-line object it is the `{` line's indent plus two spaces.
   */
  propIndent: string;
  /** Whether the last property is followed by a comma. */
  trailingComma: boolean;
}

export interface LocaleModule {
  style: "split" | "table";
  group: string;
  locales: string[];
  entries: TsEntry[];
  readOnly: Array<{ key: string; locale?: string; reason: string }>;
  objects: TsObjectRef[];
  /** Table style only: each key's `{ th, en }` object, so a missing language can be inserted later. */
  pairObjects?: Record<string, TsObjectRef>;
}

/** Loose view of a Babel AST node; only the fields this module reads. */
interface Node {
  type: string;
  start: number;
  end: number;
  [field: string]: any;
}

type ReadOnly = LocaleModule["readOnly"][number];

const SPLIT_SUFFIX = /^(.*[^A-Z])([A-Z]{2})$/;
const MAP_LOCALE = "mapLocale";

/** Returns null when the file has no recognised locale exports. Throws on syntax errors. */
export function parseLocaleModule(text: string, fileName: string): LocaleModule | null {
  const ast = parse(text, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
    ranges: true,
  }) as unknown as { program: { body: Node[] } };

  const consts = new Map<string, Node>();
  const split: Array<{ exportName: string; locale: string; obj: Node }> = [];
  const mapped: Array<{ table: string; locale: string }> = [];

  for (const stmt of ast.program.body) {
    const exported = stmt.type === "ExportNamedDeclaration";
    const decl: Node | null = exported ? stmt.declaration : stmt;
    if (!decl || decl.type !== "VariableDeclaration") continue;
    for (const d of decl.declarations as Node[]) {
      if (d.id.type !== "Identifier" || !d.init) continue;
      const name: string = d.id.name;
      const init = unwrap(d.init);
      if (decl.kind === "const") consts.set(name, init);
      if (!exported) continue;

      const m = SPLIT_SUFFIX.exec(name);
      if (m && init.type === "ObjectExpression") {
        split.push({ exportName: name, locale: m[2].toLowerCase(), obj: init });
        continue;
      }
      if (
        init.type === "CallExpression" &&
        init.callee.type === "Identifier" &&
        init.callee.name === MAP_LOCALE &&
        init.arguments.length >= 2 &&
        init.arguments[0].type === "Identifier" &&
        init.arguments[1].type === "StringLiteral"
      ) {
        mapped.push({ table: init.arguments[0].name, locale: init.arguments[1].value });
      }
    }
  }

  const group = baseName(fileName);
  const tables = [...new Set(mapped.map((x) => x.table))].filter(
    (t) => consts.get(t)?.type === "ObjectExpression",
  );

  if (tables.length > 0) {
    const locales: string[] = [];
    const entries: TsEntry[] = [];
    const readOnly: ReadOnly[] = [];
    const objects: TsObjectRef[] = [];
    const pairObjects: Record<string, TsObjectRef> = {};
    for (const t of tables) {
      const table = consts.get(t)!;
      objects.push(objectRef(text, table, null));
      for (const prop of table.properties as Node[]) {
        const key = propKey(text, prop);
        if (key.reason) {
          readOnly.push({ key: key.name, reason: key.reason });
          continue;
        }
        const pair = unwrap(prop.value);
        if (pair.type !== "ObjectExpression") {
          readOnly.push({ key: key.name, reason: `not a { locale: text } pair (${describe(pair)})` });
          continue;
        }
        if (!(key.name in pairObjects)) pairObjects[key.name] = objectRef(text, pair, null);
        for (const lp of pair.properties as Node[]) {
          const loc = propKey(text, lp);
          if (loc.reason) {
            readOnly.push({ key: key.name, reason: `${loc.reason}: ${loc.name}` });
            continue;
          }
          addUnique(locales, loc.name);
          classify(text, key.name, loc.name, lp.value, entries, readOnly, false);
        }
      }
    }
    for (const m of mapped) if (tables.includes(m.table)) addUnique(locales, m.locale);
    return { style: "table", group, locales, entries, readOnly, objects, pairObjects };
  }

  if (split.length > 0) {
    const locales: string[] = [];
    const entries: TsEntry[] = [];
    const readOnly: ReadOnly[] = [];
    const objects: TsObjectRef[] = [];
    for (const { exportName, locale, obj } of split) {
      addUnique(locales, locale);
      objects.push({ ...objectRef(text, obj, locale), exportName });
      for (const prop of obj.properties as Node[]) {
        const key = propKey(text, prop);
        if (key.reason) {
          readOnly.push({ key: key.name, locale, reason: key.reason });
          continue;
        }
        classify(text, key.name, locale, prop.value, entries, readOnly, true);
      }
    }
    return { style: "split", group, locales, entries, readOnly, objects };
  }

  return null;
}

/** Records a property value as an editable entry or as read-only. */
function classify(
  text: string,
  key: string,
  locale: string,
  rawValue: Node,
  entries: TsEntry[],
  readOnly: ReadOnly[],
  split: boolean,
) {
  const value = unwrap(rawValue);
  if (value.type === "StringLiteral") {
    const quote = (value.extra?.raw as string | undefined)?.[0] ?? text[value.start];
    entries.push({
      key,
      locale,
      value: value.value,
      range: [value.start, value.end],
      quote: quote as Quote,
    });
    return;
  }
  if (value.type === "Identifier" && value.name === "undefined") {
    entries.push({
      key,
      locale,
      value: "",
      range: [value.start, value.end],
      quote: "'",
      undefinedLiteral: true,
    });
    return;
  }
  let reason: string;
  if (value.type === "TemplateLiteral") {
    reason = value.expressions.length > 0 ? "template literal with expressions" : "template literal";
  } else if (split && value.type === "ObjectExpression") {
    reason = "nested object";
  } else {
    reason = `computed value (${describe(value)})`;
  }
  readOnly.push({ key, locale, reason });
}

/** The property's key, or a read-only reason when it is not a plain `key: value` property. */
function propKey(text: string, prop: Node): { name: string; reason?: string } {
  if (prop.type === "SpreadElement") {
    return { name: `...${text.slice(prop.argument.start, prop.argument.end)}`, reason: "spread" };
  }
  const k: Node = prop.key;
  if (prop.computed) {
    return { name: `[${text.slice(k.start, k.end)}]`, reason: "computed key" };
  }
  const name =
    k.type === "Identifier"
      ? (k.name as string)
      : k.type === "StringLiteral" || k.type === "NumericLiteral"
        ? String(k.value)
        : text.slice(k.start, k.end);
  if (prop.type !== "ObjectProperty") return { name, reason: "method or accessor" };
  return { name };
}

function objectRef(text: string, obj: Node, locale: string | null): TsObjectRef {
  const props = obj.properties as Node[];
  let propIndent: string | null = null;
  if (props.length > 0) {
    const first = props[0].start;
    const lead = text.slice(lineStart(text, first), first);
    if (/^[ \t]*$/.test(lead) && lineStart(text, first) > obj.start) propIndent = lead;
  }
  if (propIndent === null) {
    const ls = lineStart(text, obj.start);
    propIndent = /^[ \t]*/.exec(text.slice(ls, obj.start))![0] + "  ";
  }
  return {
    locale,
    open: obj.start,
    close: obj.end - 1,
    propIndent,
    trailingComma: props.length > 0 && obj.extra?.trailingComma !== undefined,
  };
}

function lineStart(text: string, pos: number): number {
  return text.lastIndexOf("\n", pos - 1) + 1;
}

/** Strips TypeScript-only wrappers (`as const`, `satisfies T`, `!`, `<T>x`). */
function unwrap(node: Node): Node {
  let n = node;
  while (
    n.type === "TSAsExpression" ||
    n.type === "TSSatisfiesExpression" ||
    n.type === "TSNonNullExpression" ||
    n.type === "TSTypeAssertion" ||
    n.type === "ParenthesizedExpression"
  ) {
    n = n.expression;
  }
  return n;
}

function describe(node: Node): string {
  switch (node.type) {
    case "Identifier":
      return "identifier";
    case "CallExpression":
      return "function call";
    default:
      return node.type;
  }
}

function addUnique(list: string[], item: string) {
  if (!list.includes(item)) list.push(item);
}

function baseName(fileName: string): string {
  const file = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}
