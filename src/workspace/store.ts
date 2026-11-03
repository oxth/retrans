import { DEFAULT_STYLE, detectStyle, emptyDocument, parseJson, setAt } from "../core/json-text";
import { parseState, serializeState, STATE_PATH } from "../core/state-file";
import type { DetectResult, FormatAdapter } from "../formats/adapter";
import { detectAt, nextI18nextAdapter } from "../formats/next-i18next";
import { type Fs, FsError, joinPath } from "../platform/fs";
import {
  parseWorkspaceMeta, serializeWorkspaceMeta, WORKSPACE_DIR, WORKSPACE_META_ERROR, WORKSPACE_META_PATH, type WorkspaceMeta,
} from "./meta";

async function readOrNull(fs: Fs, path: string): Promise<string | null> {
  try {
    return await fs.readText(path);
  } catch (err) {
    if (err instanceof FsError && err.code === "NotFound") return null;
    throw err;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** A workspace file is flat unless someone nested objects in it by hand. */
function workspaceShape(text: string): "nested" | "flat" {
  const { value } = parseJson(text);
  return isObj(value) && Object.values(value).some(isObj) ? "nested" : "flat";
}

/**
 * next-i18next over WORKSPACE_DIR, except: files are always flat (new ones, and existing ones
 * without nested objects, e.g. `{}`), and there is no config to update when locales change.
 */
export const workspaceAdapter: FormatAdapter = {
  ...nextI18nextAdapter,
  async load(fs, root, opts) {
    const r = await nextI18nextAdapter.load(fs, root, opts);
    for (const f of r.files) {
      // No nested objects: every segIndex path is already [key].
      if (!f.readOnly && f.shape === "nested" && workspaceShape(f.text) === "flat") f.shape = "flat";
    }
    return r;
  },
  newFileStyle(files) {
    return { style: nextI18nextAdapter.newFileStyle(files).style, shape: "flat" };
  },
  async onLocalesChanged() {
    return {};
  },
};

/**
 * A workspace is a folder with a .retrans/workspace.json (throws when it can't be parsed). Its translations are the
 * next-i18next layout under WORKSPACE_DIR; the base language is the one pinned in state.json
 * (listed first), else null.
 */
export async function detectWorkspace(fs: Fs, root: string): Promise<DetectResult | null> {
  const text = await readOrNull(fs, joinPath(root, WORKSPACE_META_PATH));
  if (text === null) return null;
  const meta = parseWorkspaceMeta(text);
  // Never fall through to another format: that would open the folder as something it isn't.
  if (!meta) throw new Error(WORKSPACE_META_ERROR);
  const d = (await detectAt(fs, root, WORKSPACE_DIR)) ?? {
    format: "next-i18next" as const, baseLocale: null, locales: [], namespaces: [], localesPath: WORKSPACE_DIR, keyCount: 0,
  };
  const pinned = parseState(await readOrNull(fs, joinPath(root, STATE_PATH))).state.project.baseLocale;
  const base = pinned && d.locales.includes(pinned) ? pinned : null;
  const locales = base ? [base, ...d.locales.filter((l) => l !== base)] : d.locales;
  return { ...d, baseLocale: base, locales, localesPath: WORKSPACE_DIR, workspace: meta };
}

/**
 * Writes the meta, an empty `<group>.json` per locale (existing files are kept), and pins the
 * base language in .retrans/state.json (left alone when that file is malformed).
 */
export async function createWorkspace(
  fs: Fs, root: string, opts: { name: string; baseLocale: string; locales: string[]; group?: string },
): Promise<void> {
  const meta: WorkspaceMeta = {
    retransWorkspace: 1, name: opts.name, drafts: {}, markers: {}, removedInSource: [], duplicates: [], emptyKeys: [], renames: {}, deletedKeys: [],
  };
  const group = opts.group ?? "common";
  const locales = [opts.baseLocale, ...opts.locales.filter((l) => l !== opts.baseLocale)];
  for (const locale of locales) {
    const path = joinPath(root, WORKSPACE_DIR, locale, `${group}.json`);
    if (!(await fs.exists(path))) await fs.writeTextAtomic(path, emptyDocument(DEFAULT_STYLE));
  }

  const statePath = joinPath(root, STATE_PATH);
  const disk = await readOrNull(fs, statePath);
  if (disk === null) {
    await fs.writeTextAtomic(statePath, serializeState({ version: 1, project: { baseLocale: opts.baseLocale }, entries: {} }));
  } else if (!parseState(disk).error) {
    const text = setAt(disk, ["project", "baseLocale"], opts.baseLocale, detectStyle(disk));
    if (text !== disk) await fs.writeTextAtomic(statePath, text);
  }
  // Written last: a workspace is only detected once its files exist.
  await fs.writeTextAtomic(joinPath(root, WORKSPACE_META_PATH), serializeWorkspaceMeta(meta));
}
