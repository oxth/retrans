import { open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import type { ProjectSession } from "../core/session";
import { joinPath } from "../platform/fs";
import { tauriFs } from "../platform/tauri-fs";
import { zipRead, zipWrite } from "../platform/zip";
import { buildPackage, ExportError, packageFileName } from "../package/build";
import { diffPackage, type ImportDiff, openIncoming, openIncomingFolder } from "../package/diff";
import { MANIFEST_PATH, parseManifest } from "../package/manifest";
import { btnGhost, btnPrimary } from "./Dialog";
import { ImportDialog } from "./ImportDialog";
import { useApp, useSessionVersion } from "./store";

const BAD_ZIP = "This file isn't a Retrans package or project.";
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function SharePage({ session }: { session: ProjectSession }) {
  const version = useSessionVersion();
  const dirty = version >= 0 && session.isDirty();
  const targets = session.data.locales.filter((l) => l !== session.data.baseLocale);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<ImportDiff | null>(null);
  const [fromPackage, setFromPackage] = useState(false);

  useEffect(() => {
    let live = true;
    session.fs.readText(joinPath(session.data.root, MANIFEST_PATH)).then(
      (t) => live && setFromPackage(parseManifest(t) !== null),
      () => live && setFromPackage(false),
    );
    return () => {
      live = false;
    };
  }, [session]);

  const chosen = targets.filter((l) => !off.has(l));
  const name = session.data.root.split("/").filter(Boolean).pop() ?? "project";

  async function doExport() {
    setBusy(true);
    setDone(null);
    setError(null);
    try {
      if (!session.state.project.id && !session.stateMalformed) {
        session.setProjectSetting({ id: crypto.randomUUID() });
        if (!(await useApp.getState().save())) return;
      }
      const entries = await buildPackage(session, { locales: chosen, now: new Date() });
      const dest = await save({
        defaultPath: packageFileName(name, new Date()),
        filters: [{ name: "Retrans package", extensions: ["zip"] }],
      });
      if (!dest) return;
      await zipWrite(dest, entries);
      setDone(`Exported ${dest.split(/[\\/]/).pop()}.`);
    } catch (e) {
      setError(e instanceof ExportError ? e.message : `Export failed: ${msg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function doImport(kind: "zip" | "folder") {
    setDone(null);
    setError(null);
    setBusy(true);
    try {
      const picked = await open(
        kind === "zip"
          ? { multiple: false, directory: false, filters: [{ name: "Retrans package", extensions: ["zip"] }] }
          : { multiple: false, directory: true },
      );
      if (typeof picked !== "string") return;
      const base = session.data.baseLocale;
      let r;
      if (kind === "zip") {
        let entries;
        try {
          entries = await zipRead(picked);
        } catch {
          setError(BAD_ZIP);
          return;
        }
        r = await openIncoming(entries, base);
      } else {
        r = await openIncomingFolder(tauriFs, picked, base);
      }
      setDiff(diffPackage(session, r.session, r.manifest));
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-8 p-6 text-sm">
      <h1 className="text-lg font-semibold">Import / Export</h1>
      <section aria-label="Export" className="space-y-3">
        <h2 className="font-medium">{fromPackage ? "Send back to the developer" : "Export for translator"}</h2>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {targets.map((l) => (
            <label key={l} className="flex items-center gap-1">
              <input
                type="checkbox"
                aria-label={l}
                checked={!off.has(l)}
                onChange={() =>
                  setOff((s) => {
                    const n = new Set(s);
                    if (!n.delete(l)) n.add(l);
                    return n;
                  })
                }
              />
              <span className="font-semibold uppercase">{l}</span>
            </label>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <button className={btnPrimary} disabled={dirty || busy || chosen.length === 0} onClick={() => void doExport()}>
            Export…
          </button>
          {dirty && <span className="text-xs text-amber-700">Save your changes first.</span>}
        </div>
      </section>
      <section aria-label="Import" className="space-y-3">
        <h2 className="font-medium">Import translator work</h2>
        <div className="flex gap-2">
          <button className={btnGhost + " border border-gray-300"} disabled={busy} onClick={() => void doImport("zip")}>
            Import package (.zip)…
          </button>
          <button className={btnGhost + " border border-gray-300"} disabled={busy} onClick={() => void doImport("folder")}>
            Import folder…
          </button>
        </div>
      </section>
      {done && <p role="status" className="text-green-700">{done}</p>}
      {error && <p role="alert" className="text-red-700">{error}</p>}
      {diff && (
        <ImportDialog
          session={session}
          diff={diff}
          onClose={() => setDiff(null)}
          onApplied={(n) => {
            setDiff(null);
            setDone(`Imported ${n} changes. Review and save.`);
          }}
        />
      )}
    </div>
  );
}
