import { DEFAULT_STYLE, detectStyle, parseJson } from "../core/json-text";
import { expandPluralKeys } from "../core/plurals";
import { type CellMap, type KeyId, keyId, type MessageValue, type ProjectData } from "../core/model";
import { type Fs, FsError, joinPath, normalizePath } from "../platform/fs";
import type {
  DetectResult,
  FileError,
  FormatAdapter,
  LoadedFile,
  LoadResult,
  ProjectOptions,
} from "./adapter";

const DEFAULT_LOCALES_PATH = "public/locales";
const CONFIG_NAMES = [
  "next-i18next.config.js",
  "next-i18next.config.cjs",
  "next-i18next.config.mjs",
  "next-i18next.config.ts",
];

interface StaticConfig {
  defaultLocale: string | null;
  locales: string[];
  localePath: string | null;
}

/** Static (regex-only) config parsing. The config is never evaluated. */
async function readConfig(fs: Fs, root: string): Promise<StaticConfig | null> {
  for (const name of CONFIG_NAMES) {
    const p = joinPath(root, name);
    if (!(await fs.exists(p))) continue;
    let text: string;
    try {
      text = await fs.readText(p);
    } catch {
      continue;
    }
    const dl = /defaultLocale:\s*['"]([^'"]+)/.exec(text);
    const ls = /locales:\s*\[([^\]]*)\]/.exec(text);
    const lp = /localePath:\s*['"]([^'"]+)['"]/.exec(text);
    const locales = ls ? [...ls[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]) : [];
    const rel = lp ? lp[1].replace(/^\.\//, "").replace(/\/+$/, "") : null;
    return { defaultLocale: dl ? dl[1] : null, locales, localePath: rel || null };
  }
  return null;
}

interface Entry {
  locale: string;
  ns: string;
  relPath: string; // relative to root
}

async function listEntries(fs: Fs, root: string, localesPath: string): Promise<Entry[]> {
  let files: string[];
  try {
    files = await fs.listFiles(joinPath(root, localesPath), 2);
  } catch (err) {
    if (err instanceof FsError && err.code === "NotFound") return [];
    throw err;
  }
  const out: Entry[] = [];
  for (const f of files) {
    const parts = f.split("/");
    if (parts.length !== 2 || !parts[1].endsWith(".json")) continue;
    out.push({
      locale: parts[0],
      ns: parts[1].slice(0, -".json".length),
      relPath: joinPath(localesPath, f),
    });
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Walk a parsed tree; dotted key -> {path, value}. First occurrence of a dotted key wins. */
function flatten(tree: unknown): Map<string, { path: string[]; value: unknown }> {
  const out = new Map<string, { path: string[]; value: unknown }>();
  const walk = (node: unknown, seg: string[]) => {
    if (isObj(node)) {
      for (const [k, v] of Object.entries(node)) walk(v, [...seg, k]);
      return;
    }
    if (seg.length === 0) return;
    const key = seg.join(".");
    if (!out.has(key)) out.set(key, { path: seg, value: node });
  };
  walk(tree, []);
  return out;
}

/** undefined when the file is ambiguous (e.g. only undotted top-level strings). */
function detectShape(tree: unknown): "nested" | "flat" | undefined {
  if (!isObj(tree)) return undefined;
  const entries = Object.entries(tree);
  if (entries.some(([, v]) => isObj(v))) return "nested";
  if (entries.some(([k]) => k.includes("."))) return "flat";
  return undefined;
}

function toValue(v: unknown): MessageValue {
  return typeof v === "string" ? { kind: "text", text: v } : { kind: "complex", raw: v };
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function detect(fs: Fs, root: string): Promise<DetectResult | null> {
  const cfg = await readConfig(fs, root);
  const localesPath = cfg?.localePath ?? DEFAULT_LOCALES_PATH;
  const entries = await listEntries(fs, root, localesPath);
  if (entries.length === 0 && !cfg) return null;

  const folderLocales = [...new Set(entries.map((e) => e.locale))].sort(byName);
  const locales = folderLocales.length > 0 ? folderLocales : (cfg?.locales ?? []);
  if (locales.length === 0) return null;
  const namespaces = [...new Set(entries.map((e) => e.ns))].sort(byName);
  const baseLocale = cfg?.defaultLocale && locales.includes(cfg.defaultLocale) ? cfg.defaultLocale : null;

  const perLocale = new Map<string, Set<string>>();
  for (const e of entries) {
    let text: string;
    try {
      text = await fs.readText(joinPath(root, e.relPath));
    } catch {
      continue;
    }
    const { value, error } = parseJson(text);
    if (error) continue;
    let set = perLocale.get(e.locale);
    if (!set) perLocale.set(e.locale, (set = new Set()));
    for (const k of flatten(value).keys()) set.add(keyId(e.ns, k));
  }
  const keyCount = baseLocale
    ? (perLocale.get(baseLocale)?.size ?? 0)
    : Math.max(0, ...[...perLocale.values()].map((s) => s.size));

  return { format: "next-i18next", baseLocale, locales, namespaces, localesPath, keyCount };
}

async function load(fs: Fs, root: string, opts: ProjectOptions): Promise<LoadResult> {
  const { baseLocale, localesPath } = opts;
  const entries = await listEntries(fs, root, localesPath);
  const locales = [
    baseLocale,
    ...[...new Set(entries.map((e) => e.locale))].filter((l) => l !== baseLocale).sort(byName),
  ];
  const namespaces = [...new Set(entries.map((e) => e.ns))].sort(byName);

  // Base locale first, then by locale, then ns.
  const rank = (l: string) => locales.indexOf(l);
  entries.sort((a, b) => rank(a.locale) - rank(b.locale) || byName(a.ns, b.ns));

  const files: LoadedFile[] = [];
  const errors: FileError[] = [];
  const values: CellMap = new Map();
  const baseOrder: KeyId[] = [];
  const baseSeen = new Set<KeyId>();
  const otherOrder: KeyId[] = [];
  const otherSeen = new Set<KeyId>();
  const baseShape = new Map<string, "nested" | "flat">(); // ns -> shape
  const baseFiles = new Map<string, LoadedFile>();
  let firstBaseShape: "nested" | "flat" | undefined;

  for (const e of entries) {
    const abs = joinPath(root, e.relPath);
    let text = "";
    try {
      text = await fs.readText(abs);
    } catch (err) {
      errors.push({ relPath: e.relPath, message: err instanceof FsError ? err.message : String(err) });
      files.push({
        relPath: e.relPath, locale: e.locale, ns: e.ns, text, style: DEFAULT_STYLE,
        readOnly: true, shape: "nested", segIndex: new Map(),
      });
      continue;
    }
    const style = detectStyle(text);
    const { value, error } = parseJson(text);
    if (error || !isObj(value)) {
      errors.push({ relPath: e.relPath, message: error ?? "top-level value is not an object" });
      files.push({
        relPath: e.relPath, locale: e.locale, ns: e.ns, text, style,
        readOnly: true, shape: "nested", segIndex: new Map(),
      });
      continue;
    }
    const isBase = e.locale === baseLocale;
    const strict = detectShape(value);
    const shape = strict ?? baseShape.get(e.ns) ?? firstBaseShape ?? "nested";
    if (isBase) {
      baseShape.set(e.ns, shape);
      if (strict) firstBaseShape ??= strict;
    }
    const segIndex = new Map<string, string[]>();
    const baseFile = baseFiles.get(e.ns);
    if (!isBase && baseFile && !baseFile.readOnly && baseFile.shape === "nested" && shape === "nested") {
      for (const [k, p] of baseFile.segIndex) segIndex.set(k, p);
    }
    for (const [key, { path, value: leaf }] of flatten(value)) {
      segIndex.set(key, path);
      const id = keyId(e.ns, key);
      let cell = values.get(id);
      if (!cell) values.set(id, (cell = new Map()));
      cell.set(e.locale, toValue(leaf));
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
    const lf: LoadedFile = { relPath: e.relPath, locale: e.locale, ns: e.ns, text, style, readOnly: false, shape, segIndex };
    if (isBase) baseFiles.set(e.ns, lf);
    files.push(lf);
  }

  const data: ProjectData = {
    format: "next-i18next",
    root: normalizePath(root),
    baseLocale,
    locales,
    namespaces,
    keyOrder: [...baseOrder, ...otherOrder],
    values,
  };
  data.keyOrder = expandPluralKeys(data);
  return { data, files, errors };
}

/** The copyable `locales` line shown instead of editing next-i18next.config.*. */
export function localesSnippet(locales: string[]): string {
  return `locales: [${locales.map((l) => `'${l}'`).join(", ")}],`;
}

export const nextI18nextAdapter: FormatAdapter = {
  format: "next-i18next",
  detect,
  load,
  filePath: (opts, locale, ns) => joinPath(opts.localesPath, locale, `${ns}.json`),
  jsonPath(file, key) {
    return file.segIndex.get(key) ?? (file.shape === "flat" ? [key] : key.split("."));
  },
  encode: (v) => (v.kind === "text" ? v.text : v.raw),
  /** `files` from load() are ordered base locale first, so the first parsed file is the base's. */
  newFileStyle(files) {
    const f = files.find((x) => !x.readOnly);
    return f ? { style: f.style, shape: f.shape } : { style: DEFAULT_STYLE, shape: "nested" };
  },
  async onLocalesChanged(_fs, _root, locales) {
    return { configSnippet: localesSnippet(locales) };
  },
};
