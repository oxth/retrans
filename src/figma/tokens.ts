import { isValidLocale } from "../core/session-helpers";

export interface FigmaVar { id: string; path: string[]; name: string; type: string; value: unknown } // name = path.join(".")
export type ParsedTokens = { ok: true; mode: string | null; vars: FigmaVar[] } | { ok: false; error: string };

type JsonObject = Record<string, unknown>;

const MODE_BY_NAME = new Map<string, string>([
  ["EN", "en"], ["ENG", "en"], ["ENGLISH", "en"],
  ["TH", "th"], ["THA", "th"], ["THAI", "th"], ["ไทย", "th"],
  ["JA", "ja"], ["JP", "ja"], ["JPN", "ja"], ["JAPANESE", "ja"],
  ["ZH", "zh"], ["CN", "zh"], ["CHINESE", "zh"],
  ["KO", "ko"], ["KR", "ko"], ["KOREAN", "ko"],
  ["VI", "vi"], ["VIETNAMESE", "vi"],
  ["ID", "id"], ["INDONESIAN", "id"],
  ["MS", "ms"], ["MALAY", "ms"],
  ["FR", "fr"], ["FRENCH", "fr"],
  ["DE", "de"], ["GERMAN", "de"],
  ["ES", "es"], ["SPANISH", "es"],
]);

const isObject = (v: unknown): v is JsonObject => !!v && typeof v === "object" && !Array.isArray(v);

function modeNameOf(root: JsonObject): string | null {
  const ext = root.$extensions;
  if (!isObject(ext)) return null;
  const mode = ext["com.figma.modeName"];
  return typeof mode === "string" ? mode : null;
}

function collectVars(node: JsonObject, path: string[], vars: FigmaVar[]): void {
  if (Object.prototype.hasOwnProperty.call(node, "$value")) {
    const ext = node.$extensions;
    const id = isObject(ext) ? ext["com.figma.variableId"] : undefined;
    if (typeof id === "string") {
      vars.push({
        id,
        path,
        name: path.join("."),
        type: typeof node.$type === "string" ? node.$type : "",
        value: node.$value,
      });
    }
    return;
  }
  for (const key of Object.keys(node)) {
    if (key.startsWith("$")) continue;
    const child = node[key];
    if (!isObject(child)) continue;
    collectVars(child, [...path, key], vars);
  }
}

/** Parses one Figma .tokens.json file and returns its mode and variables. */
export function parseTokens(text: string): ParsedTokens {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) return { ok: true, mode: null, vars: [] };
    const vars: FigmaVar[] = [];
    collectVars(parsed, [], vars);
    return { ok: true, mode: modeNameOf(parsed), vars };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

function detectIndent(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const m = line.match(/^(\s+)\S/);
    if (m) return m[1];
  }
  return undefined;
}

function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function trailingNewline(text: string): boolean {
  return text.endsWith("\n");
}

function atPath(root: JsonObject, path: string[]): JsonObject | null {
  let cur: unknown = root;
  for (const seg of path) {
    if (!isObject(cur)) return null;
    cur = cur[seg];
  }
  return isObject(cur) ? cur : null;
}

/** Rewrites string $value fields for matching variable IDs, keeping style and newline. */
export function rewriteTokens(text: string, values: ReadonlyMap<string, string>): string {
  const parsed = parseTokens(text);
  if (!parsed.ok) return text;
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return text;
  }
  if (!isObject(root)) return text;

  let changed = false;
  for (const v of parsed.vars) {
    if (v.type !== "string") continue;
    if (!values.has(v.id)) continue;
    const next = values.get(v.id);
    if (next === undefined || next === v.value) continue;
    const node = atPath(root, v.path);
    if (!node || !Object.prototype.hasOwnProperty.call(node, "$value")) continue;
    node.$value = next;
    changed = true;
  }
  if (!changed) return text;

  const indent = detectIndent(text);
  const eol = detectEol(text);
  const tail = trailingNewline(text);
  let out = indent === undefined ? JSON.stringify(root) : JSON.stringify(root, null, indent);
  if (eol === "\r\n") out = out.replace(/\n/g, "\r\n");
  if (tail) out += eol;
  return out;
}

/** Builds one new mode file from a template, replacing mode name and string values. */
export function newModeFile(template: string, mode: string, values: ReadonlyMap<string, string>): string {
  let root: unknown;
  try {
    root = JSON.parse(template);
  } catch {
    return template;
  }
  if (!isObject(root)) return template;
  const ext = isObject(root.$extensions) ? root.$extensions : {};
  ext["com.figma.modeName"] = mode;
  root.$extensions = ext;
  const withValues = rewriteTokens(JSON.stringify(root), values);
  const indent = detectIndent(template);
  const eol = detectEol(template);
  const tail = trailingNewline(template);
  let out = withValues;
  if (indent !== undefined) out = JSON.stringify(JSON.parse(withValues), null, indent);
  if (eol === "\r\n") out = out.replace(/\n/g, "\r\n");
  if (tail) out += eol;
  return out;
}

/** Suggests a locale code from a Figma mode name. */
export function suggestLocale(mode: string): string | null {
  const trimmed = mode.trim();
  if (!trimmed) return null;
  const mapped = MODE_BY_NAME.get(trimmed.toUpperCase());
  if (mapped) return mapped;
  return isValidLocale(trimmed) ? trimmed : null;
}
