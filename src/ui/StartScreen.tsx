import { useEffect, useRef, useState } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import type { DetectResult } from "../formats/adapter";
import { detectProject } from "../formats/detect";
import { destHasFiles, extractPackage, safeEntryPath } from "../package/extract";
import { MANIFEST_PATH, parseManifest } from "../package/manifest";
import { joinPath } from "../platform/fs";
import { zipRead } from "../platform/zip";
import { getRecent, removeRecent, type RecentProject } from "../platform/prefs";
import { resolveTsSource } from "../tssource/import";
import { btnGhost, btnPrimary, Dialog, sectionLabel } from "./Dialog";
import { AppIcon } from "./AppIcon";
import { Icon } from "./Icon";
import { ImportTsDialog } from "./ImportTsDialog";
import { NewProjectWizard } from "./NewProjectWizard";
import { OpenProjectDialog } from "./OpenProjectDialog";
import { savedBaseLocale, useApp } from "./store";
import { FigmaWorkspaceDialog, figmaModesIn } from "./FigmaWorkspaceDialog";

export function StartScreen() {
  const { fs, openProject, openPrefs } = useApp();
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [pending, setPending] = useState<{ root: string; detected: DetectResult; savedBase?: string | null } | null>(null);
  const [wizard, setWizard] = useState(false);
  /** TypeScript locale modules found where no project was: offered for import. */
  const [importing, setImporting] = useState<{ root: string; localesDir: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** Figma Variables files found where no project was: offered as a new workspace. */
  const [figmaHere, setFigmaHere] = useState<{ root: string; modes: string[] } | null>(null);
  /** A package's folder that already holds that package (re-opened zip): offered instead of extracting. */
  const [existing, setExisting] = useState<string | null>(null);

  /** Recent projects whose folder no longer exists (moved, renamed or deleted). */
  const [gone, setGone] = useState<Set<string>>(new Set());
  /** A missing recent project the user clicked: asked whether to take it off the list. */
  const [missing, setMissing] = useState<RecentProject | null>(null);

  useEffect(() => {
    let live = true;
    void getRecent()
      .then(async (list) => {
        if (!live) return;
        setRecent(list);
        const flags = await Promise.all(list.map((r) => fs.exists(r.root).catch(() => true)));
        if (live) setGone(new Set(list.filter((_, i) => !flags[i]).map((r) => r.root)));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [fs]);

  const forget = async (r: RecentProject) => {
    try {
      await removeRecent(r.root);
      setRecent((list) => list.filter((x) => x.root !== r.root));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  // Menu requests: File → New Project… / Open Project….
  const uiRequest = useApp((s) => s.uiRequest);
  useEffect(() => {
    if (uiRequest?.kind === "new-project") setWizard(true);
    else if (uiRequest?.kind === "open-project") void chooseFolderRef.current();
    else return;
    useApp.getState().clearUiRequest();
  }, [uiRequest]);

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
  const chooseFolderRef = useRef(chooseFolder);
  chooseFolderRef.current = chooseFolder;

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
    if (ts) {
      setImporting(ts);
      return null;
    }
    const modes = await figmaModesIn(fs, root);
    if (modes.length) setFigmaHere({ root, modes });
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
    setMessage(null);
    // Checked again on click: the folder may have gone since the list was drawn.
    if (!(await fs.exists(r.root).catch(() => true))) {
      setGone((g) => new Set(g).add(r.root));
      return setMissing(r);
    }
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
    <main className="flex min-h-0 flex-1 justify-center overflow-auto bg-panel p-8 text-fg">
      <div className="my-auto w-full max-w-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <AppIcon size={44} />
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Retrans</h1>
              <p className="text-sm text-muted">Edit next-i18next and Paraglide translations side by side.</p>
            </div>
          </div>
          <button className={btnGhost} onClick={() => openPrefs()}>
            <Icon name="settings" size={15} />
            Settings
          </button>
        </div>
        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          {(
            [
              { label: "Open project", hint: "A folder with next-i18next, Paraglide or TypeScript translations.", icon: "folder", run: chooseFolder, main: true },
              { label: "New project", hint: "Start an empty project and pick its languages.", icon: "folderPlus", run: () => setWizard(true) },
              { label: "Open translator package…", hint: "A .zip a developer sent you to translate.", icon: "package", run: openPackage },
            ] as const
          ).map((a, i) => (
            <button
              key={a.label}
              aria-label={a.label}
              aria-describedby={`start-hint-${i}`}
              onClick={() => void a.run()}
              className={`flex flex-col items-start gap-2 rounded-xl border p-4 text-left ${
                "main" in a ? "border-brand bg-brand text-on-brand hover:bg-brand-hover" : "border-line bg-surface hover:border-line-strong hover:bg-hover"
              }`}
            >
              <Icon name={a.icon} size={20} className={"main" in a ? "" : "text-brand"} />
              <span className="font-semibold">{a.label}</span>
              <span id={`start-hint-${i}`} className={`text-xs ${"main" in a ? "opacity-90" : "text-muted"}`}>{a.hint}</span>
            </button>
          ))}
        </div>
        {message && (
          <p role="alert" className="mt-4 flex items-center gap-2 rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger">
            <Icon name="alert" size={15} />
            {message}
          </p>
        )}
        {recent.length > 0 && (
          <section className="mt-10">
            <h2 className={`${sectionLabel} flex items-center gap-1.5`}>
              <Icon name="clock" size={13} />
              Recent projects
            </h2>
            <ul className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {recent.map((r) => {
                const isGone = gone.has(r.root);
                return (
                  <li key={r.root} className="group/item relative">
                    <button onClick={() => openRecent(r)} className="group flex w-full items-center gap-3 py-3 pl-4 pr-12 text-left hover:bg-hover">
                      <Icon name={isGone ? "alert" : "folder"} size={18} className={isGone ? "text-warn" : "text-muted group-hover:text-brand"} />
                      <span className="min-w-0 flex-1">
                        <span className={`block font-medium ${isGone ? "text-muted" : ""}`}>{r.name}</span>
                        <span className={`block truncate font-mono text-xs text-muted ${isGone ? "line-through" : ""}`}>{r.root}</span>
                      </span>
                      {isGone && <span className="shrink-0 rounded bg-warn-soft px-1.5 py-0.5 text-[11px] font-medium text-warn">Folder not found</span>}
                    </button>
                    <button
                      aria-label={`Remove ${r.name} from recent projects`}
                      title="Remove from recent projects (the folder is not touched)"
                      onClick={() => void forget(r)}
                      className={`absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted hover:bg-sunken hover:text-fg focus-visible:opacity-100 ${
                        isGone ? "" : "opacity-0 group-hover/item:opacity-100"
                      }`}
                    >
                      <Icon name="x" size={15} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
      {missing && (
        <Dialog title="Folder not found" onClose={() => setMissing(null)}>
          <p className="text-sm">
            <span className="font-medium">{missing.name}</span> is no longer at this location. It may have been moved, renamed or deleted.
          </p>
          <p className="mt-2 break-all rounded-md bg-panel px-2 py-1.5 font-mono text-xs text-muted">{missing.root}</p>
          <p className="mt-3 text-sm text-muted">Remove it from recent projects? Nothing on disk is changed.</p>
          <div className="mt-5 flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setMissing(null)}>Keep</button>
            <button
              className={btnPrimary}
              onClick={() => {
                const r = missing;
                setMissing(null);
                void forget(r);
              }}
            >
              Remove from recent
            </button>
          </div>
        </Dialog>
      )}
      {pending && <OpenProjectDialog {...pending} onCancel={() => setPending(null)} />}
      {wizard && <NewProjectWizard onCancel={() => setWizard(false)} />}
      {importing && <ImportTsDialog {...importing} onCancel={() => setImporting(null)} />}
      {figmaHere && <FigmaWorkspaceDialog {...figmaHere} onClose={() => setFigmaHere(null)} />}
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
