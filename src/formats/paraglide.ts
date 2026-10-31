import { DEFAULT_STYLE, detectStyle, parseJson, setAt } from "../core/json-text";
import { type CellMap, type KeyId, keyId, type MessageValue, type ProjectData } from "../core/model";
import { type Fs, FsError, joinPath, normalizePath } from "../platform/fs";
import type { DetectResult, FileError, FormatAdapter, LoadedFile, LoadResult, ProjectOptions } from "./adapter";

const SETTINGS_PATH = "project.inlang/settings.json";
const SCHEMA_URL = "https://inlang.com/schema/inlang-message-format";
const DEFAULT_PATTERN = "messages/{locale}.json";

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

interface Settings {
  baseLocale: string | null;
  locales: string[];
  pathPattern: string;
}

/** null when settings.json is missing; throws when it is malformed. */
async function readSettings(fs: Fs, root: string): Promise<Settings | null> {
  let text: string;
  try {
    text = await fs.readText(joinPath(root, SETTINGS_PATH));
  } catch (err) {
    if (err instanceof FsError && err.code === "NotFound") return null;
    throw err;
  }
  const { value, error } = parseJson(text);
  if (error || !isObj(value)) throw new Error(`${SETTINGS_PATH} is not valid JSON`);
  const baseLocale = typeof value.baseLocale === "string" ? value.baseLocale : null;
  const rawLocales = Array.isArray(value.locales) ? value.locales.filter((l): l is string => typeof l === "string") : [];
  const plugin = value["plugin.inlang.messageFormat"];
  let pattern: unknown = isObj(plugin) ? plugin.pathPattern : undefined;
  if (Array.isArray(pattern)) pattern = pattern[0];
  const pathPattern = typeof pattern === "string" && pattern ? pattern.replace(/^\.\//, "") : DEFAULT_PATTERN;
  const locales = baseLocale
    ? [baseLocale, ...rawLocales.filter((l) => l !== baseLocale)]
    : rawLocales;
  return { baseLocale, locales, pathPattern };
}

const subst = (pattern: string, locale: string) => pattern.split("{locale}").join(locale);

function flatten(tree: unknown): Map<string, { path: string[]; value: unknown }> {
  const out = new Map<string, { path: string[]; value: unknown }>();
  const walk = (node: unknown, seg: string[]) => {
    if (isObj(node)) {
      for (const [k, v] of Object.entries(node)) {
        if (seg.length === 0 && k === "$schema") continue;
        walk(v, [...seg, k]);
      }
      return;
    }
    if (seg.length === 0) return;
    const key = seg.join(".");
    if (!out.has(key)) out.set(key, { path: seg, value: node });
  };
  walk(tree, []);
  return out;
}

const toValue = (v: unknown): MessageValue =>
  typeof v === "string" ? { kind: "text", text: v } : { kind: "complex", raw: v };

async function readParsed(fs: Fs, root: string, rel: string): Promise<unknown | undefined> {
  try {
    const { value, error } = parseJson(await fs.readText(joinPath(root, rel)));
    return error ? undefined : value;
  } catch {
    return undefined;
  }
}

async function detect(fs: Fs, root: string): Promise<DetectResult | null> {
  const s = await readSettings(fs, root);
  if (!s) return null;
  let keyCount = 0;
  if (s.baseLocale) {
    const tree = await readParsed(fs, root, subst(s.pathPattern, s.baseLocale));
    if (tree !== undefined) keyCount = flatten(tree).size;
  }
  return {
    format: "paraglide",
    baseLocale: s.baseLocale,
    locales: s.locales,
    namespaces: [""],
    localesPath: s.pathPattern,
    keyCount,
  };
}

async function load(fs: Fs, root: string, opts: ProjectOptions): Promise<LoadResult> {
  const { baseLocale, localesPath } = opts;
  const settings = await readSettings(fs, root);
  const rest = (settings?.locales ?? []).filter((l) => l !== baseLocale);
  const locales = [baseLocale, ...rest];

  const files: LoadedFile[] = [];
  const errors: FileError[] = [];
  const values: CellMap = new Map();
  const baseOrder: KeyId[] = [];
  const baseSeen = new Set<KeyId>();
  const otherOrder: KeyId[] = [];
  const otherSeen = new Set<KeyId>();

  for (const locale of locales) {
    const relPath = subst(localesPath, locale);
    const abs = joinPath(root, relPath);
    let text: string;
    try {
      text = await fs.readText(abs);
    } catch (err) {
      if (err instanceof FsError && err.code === "NotFound") continue; // treated as empty
      errors.push({ relPath, message: err instanceof FsError ? err.message : String(err) });
      files.push({ relPath, locale, ns: "", text: "", style: DEFAULT_STYLE, readOnly: true, shape: "nested", segIndex: new Map() });
      continue;
    }
    const style = detectStyle(text);
    const { value, error } = parseJson(text);
    if (error || !isObj(value)) {
      errors.push({ relPath, message: error ?? "top-level value is not an object" });
      files.push({ relPath, locale, ns: "", text, style, readOnly: true, shape: "nested", segIndex: new Map() });
      continue;
    }
    const isBase = locale === baseLocale;
    const segIndex = new Map<string, string[]>();
    for (const [key, { path, value: leaf }] of flatten(value)) {
      segIndex.set(key, path);
      const id = keyId("", key);
      let cell = values.get(id);
      if (!cell) values.set(id, (cell = new Map()));
      cell.set(locale, toValue(leaf));
      if (isBase) {
        if (!baseSeen.has(id)) {
          baseSeen.add(id);
          baseOrder.push(id);
        }
      } else if (!baseSeen.has(id) && !otherSeen.has(id)) {
        otherSeen.add(id);
        otherOrder.push(id);
      }
    }
    files.push({ relPath, locale, ns: "", text, style, readOnly: false, shape: "nested", segIndex });
  }

  const data: ProjectData = {
    format: "paraglide",
    root: normalizePath(root),
    baseLocale,
    locales,
    namespaces: [""],
    keyOrder: [...baseOrder, ...otherOrder],
    values,
  };
  return { data, files, errors };
}

export const paraglideAdapter: FormatAdapter = {
  format: "paraglide",
  detect,
  load,
  filePath: (opts, locale) => subst(opts.localesPath, locale),
  jsonPath(file, key) {
    return file.segIndex.get(key) ?? key.split(".");
  },
  encode: (v) => (v.kind === "text" ? v.text : v.raw),
  newFileStyle(files) {
    const f = files.find((x) => !x.readOnly);
    return {
      style: f ? f.style : DEFAULT_STYLE,
      shape: "nested",
      prefix: { $schema: SCHEMA_URL },
    };
  },
  async onLocalesChanged(fs, root, locales) {
    const p = joinPath(root, SETTINGS_PATH);
    const text = await fs.readText(p);
    const next = setAt(text, ["locales"], locales, detectStyle(text));
    if (next === text) return {};
    await fs.writeTextAtomic(p, next);
    return { written: [SETTINGS_PATH] };
  },
};
