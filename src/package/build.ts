import { detectStyle, setAt } from "../core/json-text";
import type { ProjectSession } from "../core/session";
import { serializeState, STATE_PATH, type StateFile } from "../core/state-file";
import { FsError, joinPath } from "../platform/fs";
import { serializeWorkspaceMeta, WORKSPACE_META_PATH } from "../workspace/meta";
import { MANIFEST_PATH, parseManifest, serializeManifest, snapshotCells, type PackageManifest } from "./manifest";

export class ExportError extends Error {}

const SETTINGS_PATH = "project.inlang/settings.json";
const CONFIG_NAMES = ["js", "mjs", "cjs", "ts"].map((e) => `next-i18next.config.${e}`);

async function readOrNull(session: ProjectSession, rel: string): Promise<string | null> {
  try {
    return await session.fs.readText(joinPath(session.data.root, rel));
  } catch (err) {
    if (err instanceof FsError && err.code === "NotFound") return null;
    throw err;
  }
}

/**
 * Files of a translator package: a complete, openable project limited to the base locale plus the
 * chosen targets. The session must be clean so the loaded text equals what is on disk.
 *
 * A workspace package holds the workspace itself (`.retrans/workspace/**`, its meta and
 * state.json) but no TypeScript sources and no source baseline. Its meta has no `source`, so the
 * translator's copy never syncs (and never marks keys removed in source); the last export target
 * (a path on the developer's machine) is left out too.
 */
export async function buildPackage(
  session: ProjectSession,
  opts: { locales: string[]; now: Date },
): Promise<Array<{ path: string; text: string }>> {
  if (session.isDirty()) throw new ExportError("Save your changes first.");
  if (session.stateMalformed) throw new ExportError("Fix .retrans/state.json before exporting.");
  const projectId = session.state.project.id;
  if (!projectId) throw new ExportError("Save your changes first.");

  const { baseLocale, locales: all } = session.data;
  const targets = new Set(all.filter((l) => l !== baseLocale));
  const requested = [...new Set(opts.locales)].filter((l) => targets.has(l));
  const included = [baseLocale, ...requested];
  const includedSet = new Set(included);

  const out = new Map<string, string>();
  for (const f of session.files) if (includedSet.has(f.locale)) out.set(f.relPath, f.text);

  const entries: StateFile["entries"] = {};
  for (const [id, cells] of Object.entries(session.state.entries)) {
    const kept = Object.fromEntries(Object.entries(cells).filter(([l]) => includedSet.has(l)));
    if (Object.keys(kept).length) entries[id] = kept;
  }
  out.set(STATE_PATH, serializeState({ version: 1, project: { ...session.state.project }, entries }));

  const meta = session.workspace;
  if (meta) {
    const packaged = structuredClone(meta);
    delete packaged.source;
    delete packaged.lastExport;
    out.set(WORKSPACE_META_PATH, serializeWorkspaceMeta(packaged));
  } else if (session.data.format === "paraglide") {
    const text = await readOrNull(session, SETTINGS_PATH);
    if (text !== null) out.set(SETTINGS_PATH, setAt(text, ["locales"], included, detectStyle(text)));
  } else {
    for (const name of CONFIG_NAMES) {
      const text = await readOrNull(session, name);
      if (text !== null) out.set(name, text);
    }
  }

  // A project opened from a package keeps the original baseline and source id, so the developer's
  // import can still tell what the translator changed.
  const existing = parseManifest(await readOrNull(session, MANIFEST_PATH));
  const manifest: PackageManifest = existing
    ? {
        ...existing,
        locales: requested.filter((l) => existing.locales.includes(l)),
        exportedAt: opts.now.toISOString(),
      }
    : {
        retransPackage: 1,
        format: session.data.format,
        baseLocale,
        locales: requested,
        localesPath: session.opts.localesPath,
        exportedAt: opts.now.toISOString(),
        sourceProjectId: projectId,
        baseline: snapshotCells(session, requested),
      };
  out.set(MANIFEST_PATH, serializeManifest(manifest));

  return [...out].map(([path, text]) => ({ path, text })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function packageFileName(projectName: string, now: Date): string {
  return `${projectName}-translation-${now.toISOString().slice(0, 10)}.zip`;
}
