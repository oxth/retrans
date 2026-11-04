/**
 * Test-only: the ts-locales fixture imported into a workspace and opened as a session.
 * Mirrors what the Import dialog does (Task 7): import values, create the workspace, write
 * every `<locale>/<group>.json`, the meta (source, markers, drafts, duplicates) and the baseline.
 */
import { resolve } from "node:path";
import { parseKeyId } from "../core/model";
import { ProjectSession } from "../core/session";
import { detectProject } from "../formats/detect";
import { loadFixtureDir, type MemoryFs } from "../platform/memory-fs";
import { joinPath } from "../platform/fs";
import { importTsLocales, type TsImport } from "../tssource/import";
import {
  BASELINE_PATH, parseWorkspaceMeta, serializeBaseline, serializeWorkspaceMeta, WORKSPACE_DIR, WORKSPACE_META_PATH,
} from "../workspace/meta";
import { createWorkspace } from "../workspace/store";
import { syncFromSource } from "../workspace/sync";

export const FIXTURE_ROOT = "/project";
export const FIXTURE_LOCALES_DIR = "src/assets/locales";
const FIXTURE = resolve(__dirname, "fixtures/ts-locales");

export async function openFixtureWorkspace(): Promise<{
  fs: MemoryFs; session: ProjectSession; root: string; localesDir: string; imported: TsImport;
}> {
  const root = FIXTURE_ROOT;
  const localesDir = FIXTURE_LOCALES_DIR;
  const fs = loadFixtureDir(FIXTURE, root);
  const imported = await importTsLocales(fs, root, localesDir, "th");
  const groups = [...imported.modules.values()].map((m) => m.module.group);
  await createWorkspace(fs, root, { name: "fixture", baseLocale: "th", locales: imported.locales, group: groups[0] });

  for (const locale of imported.locales) {
    for (const group of groups) {
      const flat: Record<string, string> = {};
      for (const id of imported.keyOrder) {
        const { ns, key } = parseKeyId(id);
        const v = imported.values.get(id)?.get(locale);
        if (ns === group && v?.kind === "text") flat[key] = v.text;
      }
      await fs.writeTextAtomic(joinPath(root, WORKSPACE_DIR, locale, `${group}.json`), JSON.stringify(flat, null, 2) + "\n");
    }
  }

  const metaPath = joinPath(root, WORKSPACE_META_PATH);
  const meta = parseWorkspaceMeta(await fs.readText(metaPath))!;
  await fs.writeTextAtomic(metaPath, serializeWorkspaceMeta({
    ...meta,
    source: { type: "ts", localesDir },
    markers: imported.markers,
    drafts: imported.drafts,
    duplicates: imported.duplicates,
    emptyKeys: imported.keyOrder
      .filter((id) => !imported.values.get(id)?.size && !imported.readOnly.some((r) => r.id === id))
      .sort(),
  }));
  await fs.writeTextAtomic(joinPath(root, BASELINE_PATH), serializeBaseline(imported.baseline));

  const d = (await detectProject(fs, root))!;
  const session = await ProjectSession.open(fs, root, d, { baseLocale: "th", localesPath: d.localesPath });
  session.setSourceReadOnly(imported.readOnly); // as the import (and every sync) does
  return { fs, session, root, localesDir, imported };
}

/**
 * A workspace imported from the TS sources already in `fs` (as the Import dialog does: fromImport,
 * first save), reopened from disk and synced, as opening a workspace does.
 */
export async function openWorkspaceFrom(fs: MemoryFs, root: string, localesDir: string): Promise<ProjectSession> {
  const imp = await importTsLocales(fs, root, localesDir, "th");
  const fresh = await ProjectSession.fromImport(fs, root, imp, { name: "test", localesDir, baseLocale: "th" });
  await fresh.save();
  const d = (await detectProject(fs, root))!;
  const session = await ProjectSession.open(fs, root, d, { baseLocale: "th", localesPath: d.localesPath });
  await syncFromSource(session);
  if (session.isDirty()) await session.save();
  return session;
}
