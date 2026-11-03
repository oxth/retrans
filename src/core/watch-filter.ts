import type { Format } from "./model";
import { STATE_PATH } from "./state-file";

const SETTINGS_PATH = "project.inlang/settings.json";

/** Forward slashes, no duplicate or trailing slash, lower-case Windows drive letter. */
function norm(p: string): string {
  let out = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  if (/^[A-Za-z]:/.test(out)) out = out[0].toLowerCase() + out.slice(1);
  return out;
}

function trimRel(p: string): string {
  return norm(p.replace(/^\.\//, "")).replace(/^\/+/, "");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface WatchScope {
  root: string;
  format: Format;
  /** next-i18next: the locales directory; Paraglide: the pathPattern, e.g. "messages/{locale}.json". */
  localesPath: string;
  /** More root-relative files that count (e.g. a workspace's meta and baseline). */
  extraPaths?: string[];
  /** Workspace imported from TypeScript: its root-relative source folder (`source.localesDir`) counts too. */
  sourceDir?: string;
}

/**
 * True when a watcher batch touches a workspace's TypeScript source folder (root-relative
 * `sourceDir`; "." is the root itself, minus .retrans/), or removes/moves one of its ancestors.
 */
export function isSourceChange(paths: string[], root: string, sourceDir: string): boolean {
  const r = norm(root);
  const dir = trimRel(sourceDir) === "." ? "" : trimRel(sourceDir);
  for (const raw of paths) {
    const p = norm(raw);
    if (p !== r && !p.startsWith(r + "/")) continue;
    const rel = p === r ? "" : p.slice(r.length + 1);
    if (!dir) {
      if (rel !== ".retrans" && !rel.startsWith(".retrans/")) return true;
      continue;
    }
    if (rel === dir || rel.startsWith(dir + "/")) return true;
    if (rel === "" || dir.startsWith(rel + "/")) return true; // an ancestor moved or was removed
  }
  return false;
}

/**
 * True when a watcher batch can affect the open project: a path inside (or an ancestor of) the
 * locales directory, project.inlang/settings.json, or .retrans/state.json (and, for a workspace
 * with `sourceDir`, its TypeScript source folder; see isSourceChange). For Paraglide the
 * locales directory is the part of pathPattern before "{locale}"; when that is the root itself,
 * only paths matching the pattern count.
 */
export function isRelevantChange(paths: string[], scope: WatchScope): boolean {
  if (scope.sourceDir !== undefined && isSourceChange(paths, scope.root, scope.sourceDir)) return true;
  const root = norm(scope.root);
  const pattern = trimRel(scope.localesPath);
  let dir = pattern;
  let match: RegExp | null = null;
  if (scope.format === "paraglide") {
    const i = pattern.indexOf("{locale}");
    const before = i < 0 ? pattern : pattern.slice(0, i);
    dir = before.includes("/") ? before.slice(0, before.lastIndexOf("/")) : "";
    match = new RegExp("^" + pattern.split("{locale}").map(escapeRe).join("[^/]+") + "$");
  }
  const exact = new Set([STATE_PATH, SETTINGS_PATH, ...(scope.extraPaths ?? []).map(trimRel)]);
  for (const raw of paths) {
    const p = norm(raw);
    if (p !== root && !p.startsWith(root + "/")) continue;
    const rel = p === root ? "" : p.slice(root.length + 1);
    if (exact.has(rel) || match?.test(rel)) return true;
    if (!dir) continue;
    if (rel === dir || rel.startsWith(dir + "/")) return true;
    if (rel === "" || dir.startsWith(rel + "/")) return true; // an ancestor moved or was removed
  }
  return false;
}
