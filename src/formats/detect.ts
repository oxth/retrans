import type { Fs } from "../platform/fs";
import { FsError, joinPath } from "../platform/fs";
import { MANIFEST_PATH, parseManifest } from "../package/manifest";
import type { DetectResult } from "./adapter";
import { nextI18nextAdapter } from "./next-i18next";
import { paraglideAdapter } from "./paraglide";
import { detectWorkspace } from "../workspace/store";

async function readManifestText(fs: Fs, root: string): Promise<string | null> {
  try {
    return await fs.readText(joinPath(root, MANIFEST_PATH));
  } catch (e) {
    if (e instanceof FsError && e.code === "NotFound") return null;
    throw e;
  }
}

/**
 * A translator package manifest picks the format and base language (a package of a workspace opens
 * as that workspace). Otherwise: a Retrans workspace
 * (.retrans/workspace.json), then Paraglide (throws if its settings.json is malformed), then
 * next-i18next, else null.
 */
export async function detectProject(fs: Fs, root: string): Promise<DetectResult | null> {
  const manifest = parseManifest(await readManifestText(fs, root));
  if (manifest) {
    // A package built from a workspace holds the workspace itself (.retrans/workspace.json).
    const ws = await detectWorkspace(fs, root);
    if (ws) {
      const base = manifest.baseLocale;
      return ws.locales.includes(base) ? { ...ws, baseLocale: base, locales: [base, ...ws.locales.filter((l) => l !== base)] } : ws;
    }
    const adapter = manifest.format === "paraglide" ? paraglideAdapter : nextI18nextAdapter;
    const result = await adapter.detect(fs, root);
    if (!result) throw new Error("This file isn't a Retrans package or project.");
    return result.locales.includes(manifest.baseLocale) ? { ...result, baseLocale: manifest.baseLocale } : result;
  }
  return (
    (await detectWorkspace(fs, root)) ??
    (await paraglideAdapter.detect(fs, root)) ??
    (await nextI18nextAdapter.detect(fs, root))
  );
}
