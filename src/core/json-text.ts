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

function applyStyleEnd(text: string, style: JsonStyle): string {
  const trimmed = text.replace(/(\r?\n)+$/, "");
  return style.finalNewline ? trimmed + style.eol : trimmed;
}

function edit(text: string, path: string[], value: unknown, style: JsonStyle): string {
  const edits = modify(text, path, value, { formattingOptions: formatting(style) });
  return applyEdits(text, edits);
}

export function setAt(text: string, path: string[], value: unknown, style: JsonStyle): string {
  const out = edit(text, path, value, style);
  if (out === text) return text;
  return applyStyleEnd(out, style);
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
  return applyStyleEnd(out, style);
}

export function emptyDocument(style: JsonStyle): string {
  return "{}" + (style.finalNewline ? style.eol : "");
}
