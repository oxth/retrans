import { useEffect, useState } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import type { DetectResult } from "../formats/adapter";
import { detectProject } from "../formats/detect";
import { destHasFiles, extractPackage, safeEntryPath } from "../package/extract";
import { MANIFEST_PATH, parseManifest } from "../package/manifest";
import { joinPath } from "../platform/fs";
import { zipRead } from "../platform/zip";
import { getRecent, type RecentProject } from "../platform/prefs";
import { resolveTsSource } from "../tssource/import";
import { btnGhost, btnPrimary, Dialog } from "./Dialog";
import { ImportTsDialog } from "./ImportTsDialog";
import { NewProjectWizard } from "./NewProjectWizard";
import { OpenProjectDialog } from "./OpenProjectDialog";
import { savedBaseLocale, useApp } from "./store";

export function StartScreen() {
  const { fs, openProject } = useApp();
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [pending, setPending] = useState<{ root: string; detected: DetectResult; savedBase?: string | null } | null>(null);
  const [wizard, setWizard] = useState(false);
  /** TypeScript locale modules found where no project was: offered for import. */
  const [importing, setImporting] = useState<{ root: string; localesDir: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** A package's folder that already holds that package (re-opened zip): offered instead of extracting. */
  const [existing, setExisting] = useState<string | null>(null);

  useEffect(() => {
    void getRecent().then(setRecent).catch(() => {});
  }, []);

  const detect = async (root: string): Promise<DetectResult | null> => {
    setMessage(null);
    try {
      const d = await detectProject(fs, root);
      if (!d) setMessage("No next-i18next or Paraglide project found in this folder.");
      return d;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      return null;
    }
  };

  const chooseFolder = async () => {
    try {
      const p = await pickFile({ directory: true });
      if (typeof p !== "string") return;
      const root = p.replace(/\\/g, "/");
      const found = await findProject(root);
      if (found) setPending({ ...found, savedBase: await savedBaseLocale(fs, found.root, found.detected) });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * The project in `root`. Failing that, TypeScript locale modules: the workspace of the project
   * around them when it has one (the user picked the locales folder), else the Import dialog is
   * shown and null returned. null with a message when there is nothing at all.
   */
  const findProject = async (root: string): Promise<{ root: string; detected: DetectResult } | null> => {
    setMessage(null);
    const detected = await detectProject(fs, root);
    if (detected) return { root, detected };
    const ts = await resolveTsSource(fs, root);
    if (ts && ts.root !== root) {
      const d = await detectProject(fs, ts.root);
      if (d?.workspace) return { root: ts.root, detected: d };
    }
    if (ts) setImporting(ts);
    else setMessage("No next-i18next or Paraglide project found in this folder.");
    return null;
  };

  /** Open an extracted package folder: ask for the base language only when detection can't tell. */
  const openPackageFolder = async (root: string) => {
    const detected = await detect(root);
    if (!detected) return;
    if (detected.baseLocale === null) {
      setPending({ root, detected, savedBase: await savedBaseLocale(fs, root, detected) });
    } else {
      await openProject(root, detected, { baseLocale: detected.baseLocale, localesPath: detected.localesPath });
    }
  };

  /** The manifest in `root`, or null when missing or unreadable. */
  const manifestIn = async (root: string) => {
    try {
      return parseManifest(await fs.readText(joinPath(root, MANIFEST_PATH)));
    } catch {
      return null;
    }
  };

  const openPackage = async () => {
    setMessage(null);
    try {
      const zipPath = await pickFile({ filters: [{ name: "Retrans package", extensions: ["zip"] }] });
      if (typeof zipPath !== "string") return;
      const parent = await pickFile({ directory: true, title: "Choose where to put the project" });
      if (typeof parent !== "string") return;
      const zipName = zipPath.replace(/\\/g, "/").split("/").pop()!.replace(/\.zip$/i, "") || "retrans-package";
      const root = `${parent.replace(/\\/g, "/").replace(/\/+$/, "")}/${zipName}`;
      const entries = await zipRead(zipPath);
      // Never extract over a folder with files: it may hold the translator's saved work.
      if (await destHasFiles(fs, root)) {
        const incoming = parseManifest(entries.find((e) => safeEntryPath(e.path) === MANIFEST_PATH)?.text ?? null);
        const there = await manifestIn(root);
        if (incoming && there && incoming.sourceProjectId === there.sourceProjectId) return setExisting(root);
        throw new Error("Choose an empty folder.");
      }
      await extractPackage(fs, entries, root);
      await openPackageFolder(root);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const openExisting = async () => {
    const root = existing!;
    setExisting(null);
    try {
      await openPackageFolder(root);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const openRecent = async (r: RecentProject) => {
    let found: Awaited<ReturnType<typeof findProject>>;
    try {
      found = await findProject(r.root); // an import never saved is offered again
    } catch (e) {
      return setMessage(e instanceof Error ? e.message : String(e));
    }
    if (!found) return;
    const { root, detected: d } = found;
    const base = d.baseLocale ?? (await savedBaseLocale(fs, root, d));
    if (base === null) return setPending({ root, detected: d });
    try {
      await openProject(root, d, { baseLocale: base, localesPath: d.localesPath });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <main className="flex min-h-0 flex-1 justify-center overflow-auto bg-gray-50 p-8 text-gray-900">
      <div className="my-auto w-full max-w-xl">
        <h1 className="text-3xl font-bold text-indigo-600">Retrans</h1>
        <p className="mt-1 text-gray-500">Edit next-i18next and Paraglide translations side by side.</p>
        <div className="mt-6 flex gap-3">
          <button onClick={chooseFolder} className="rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-700">
            Open project
          </button>
          <button onClick={() => setWizard(true)} className="rounded-lg border border-gray-300 bg-white px-4 py-2 font-medium hover:bg-gray-100">
            New project
          </button>
          <button onClick={openPackage} className="rounded-lg border border-gray-300 bg-white px-4 py-2 font-medium hover:bg-gray-100">
            Open translator package…
          </button>
        </div>
        {message && <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{message}</p>}
        {recent.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm font-semibold text-gray-500">Recent projects</h2>
            <ul className="mt-2 divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
              {recent.map((r) => (
                <li key={r.root}>
                  <button onClick={() => openRecent(r)} className="block w-full px-4 py-3 text-left hover:bg-gray-50">
                    <span className="font-medium">{r.name}</span>
                    <span className="block truncate font-mono text-xs text-gray-500">{r.root}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {pending && <OpenProjectDialog {...pending} onCancel={() => setPending(null)} />}
      {wizard && <NewProjectWizard onCancel={() => setWizard(false)} />}
      {importing && <ImportTsDialog {...importing} onCancel={() => setImporting(null)} />}
      {existing && (
        <Dialog title="Package already open" onClose={() => setExisting(null)}>
          <p className="break-words text-sm">This package is already open in {existing}. Open it?</p>
          <div className="mt-5 flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setExisting(null)}>Cancel</button>
            <button className={btnPrimary} onClick={() => void openExisting()}>Open existing</button>
          </div>
        </Dialog>
      )}
    </main>
  );
}
