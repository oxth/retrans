import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  type ParseError,
  printParseErrorCode,
} from "jsonc-parser";

export interface JsonStyle {
  indent: string;
  eol: "\n" | "\r\n";
  finalNewline: boolean;
}

export const DEFAULT_STYLE: JsonStyle = { indent: "  ", eol: "\n", finalNewline: true };

export function detectStyle(text: string): JsonStyle {
  const eol: JsonStyle["eol"] = text.includes("\r\n") ? "\r\n" : "\n";
  const m = /\n([ \t]+)\S/.exec(text);
  const indent = m ? (m[1].startsWith("\t") ? "\t" : m[1]) : DEFAULT_STYLE.indent;
  return { indent, eol, finalNewline: text.endsWith(eol) };
}

export function parseJson(text: string): { value: unknown; error?: string } {
  const errors: ParseError[] = [];
  parse(text, errors, { allowTrailingComma: false, disallowComments: true });
  if (errors.length > 0) {
    const e = errors[0];
    return { value: undefined, error: `${printParseErrorCode(e.error)} at offset ${e.offset}` };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    return { value: undefined, error: err instanceof Error ? err.message : String(err) };
  }
}

function formatting(style: JsonStyle) {
  const tab = style.indent.startsWith("\t");
  return { insertSpaces: !tab, tabSize: tab ? 1 : style.indent.length || 2, eol: style.eol };
}

function applyStyleEnd(text: string, style: JsonStyle, original: string): string {
  const origTail = /\s*$/.exec(original)![0];
  const trimmed = text.replace(/\s+$/, "");
  if (style.finalNewline && origTail.includes("\n")) return trimmed + origTail;
  return style.finalNewline ? trimmed + style.eol : trimmed;
}

function edit(text: string, path: string[], value: unknown, style: JsonStyle): string {
  const edits = modify(text, path, value, { formattingOptions: formatting(style) });
  return applyEdits(text, edits);
}

/** Splice a new member into a single-line object, matching its separator style. */
function compactInsert(text: string, path: string[], value: unknown): string | undefined {
  const tree = parseTree(text);
  if (!tree || findNodeAtLocation(tree, path)) return undefined;
  let k = path.length - 1;
  let obj = findNodeAtLocation(tree, path.slice(0, k));
  while (!obj && k > 0) {
    k--;
    obj = findNodeAtLocation(tree, path.slice(0, k));
  }
  if (!obj || obj.type !== "object") return undefined;
  if (/[\r\n]/.test(text.slice(obj.offset, obj.offset + obj.length))) return undefined;
  let nested: unknown = value;
  for (let i = path.length - 1; i > k; i--) nested = { [path[i]]: nested };
  const kids = obj.children ?? [];
  let colon = ":";
  let comma = ",";
  const first = kids[0]?.children;
  if (first && first.length === 2) {
    colon = text.slice(first[0].offset + first[0].length, first[1].offset);
  }
  if (kids.length > 1) {
    const sep = text.slice(kids[0].offset + kids[0].length, kids[1].offset);
    comma = sep;
  } else if (colon.endsWith(" ")) {
    comma = ", ";
  }
  const member = JSON.stringify(path[k]) + colon + JSON.stringify(nested);
  if (kids.length === 0) {
    return text.slice(0, obj.offset + 1) + member + text.slice(obj.offset + obj.length - 1);
  }
  const last = kids[kids.length - 1];
  const at = last.offset + last.length;
  return text.slice(0, at) + comma + member + text.slice(at);
}

/** Replace an existing one-line value in place, reusing that node's separator style. */
function compactReplace(text: string, path: string[], value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const tree = parseTree(text);
  const node = tree && findNodeAtLocation(tree, path);
  if (!node) return undefined;
  const span = text.slice(node.offset, node.offset + node.length);
  if (/[\r\n]/.test(span)) return undefined;
  let comma = ", ";
  let colon = ": ";
  const kids = node.children ?? [];
  if (node.type === "array" && kids.length > 1) {
    comma = text.slice(kids[0].offset + kids[0].length, kids[1].offset);
  } else if (node.type === "object" && kids.length > 0) {
    const f = kids[0].children;
    if (f && f.length === 2) colon = text.slice(f[0].offset + f[0].length, f[1].offset);
    if (kids.length > 1) comma = text.slice(kids[0].offset + kids[0].length, kids[1].offset);
  }
  const ser = (v: unknown): string => {
    if (Array.isArray(v)) return "[" + v.map(ser).join(comma) + "]";
    if (v !== null && typeof v === "object") {
      return "{" + Object.entries(v).map(([k, x]) => JSON.stringify(k) + colon + ser(x)).join(comma) + "}";
    }
    return JSON.stringify(v);
  };
  return text.slice(0, node.offset) + ser(value) + text.slice(node.offset + node.length);
}

export function setAt(text: string, path: string[], value: unknown, style: JsonStyle): string {
  const out =
    compactInsert(text, path, value) ?? compactReplace(text, path, value) ?? edit(text, path, value, style);
  if (out === text) return text;
  return applyStyleEnd(out, style, text);
}

function getAt(root: unknown, path: string[]): unknown {
  let cur = root;
  for (const k of path) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, k)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Remove one property textually, without reformatting any other line. */
function removeProperty(text: string, path: string[], style: JsonStyle): string {
  const tree = parseTree(text);
  const value = tree && findNodeAtLocation(tree, path);
  const prop = value?.parent;
  const obj = prop?.parent;
  if (!prop || !obj || obj.type !== "object" || !obj.children) {
    return edit(text, path, undefined, style);
  }
  const kids = obj.children;
  const idx = kids.indexOf(prop);
  let from: number;
  let to: number;
  if (kids.length === 1) {
    from = obj.offset + 1;
    to = obj.offset + obj.length - 1;
  } else if (idx > 0) {
    from = kids[idx - 1].offset + kids[idx - 1].length;
    to = prop.offset + prop.length;
  } else {
    from = prop.offset;
    to = kids[1].offset;
  }
  return text.slice(0, from) + text.slice(to);
}

export function removeAt(text: string, path: string[], style: JsonStyle): string {
  if (getAt(parse(text), path) === undefined) return text;
  let out = removeProperty(text, path, style);
  for (let i = path.length - 1; i >= 1; i--) {
    const parent = getAt(parse(out), path.slice(0, i));
    if (
      parent !== null &&
      typeof parent === "object" &&
      !Array.isArray(parent) &&
      Object.keys(parent).length === 0
    ) {
      out = removeProperty(out, path.slice(0, i), style);
    } else break;
  }
  return applyStyleEnd(out, style, text);
}

export function emptyDocument(style: JsonStyle): string {
  return "{}" + (style.finalNewline ? style.eol : "");
}
