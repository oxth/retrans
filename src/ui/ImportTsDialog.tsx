import { useEffect, useState } from "react";
import { ProjectSession } from "../core/session";
import type { DetectResult } from "../formats/adapter";
import { joinPath } from "../platform/fs";
import { importTsLocales, type TsImport } from "../tssource/import";
import { WORKSPACE_DIR } from "../workspace/meta";
import { btnGhost, btnPrimary, Dialog } from "./Dialog";
import { useApp } from "./store";

interface Props {
  /** Where the workspace will live (.retrans/ is created there on the first Save). */
  root: string;
  /** The TypeScript locales folder, relative to `root` ("." = root itself). */
  localesDir: string;
  onCancel(): void;
}

/** Languages actually present in the modules (an import always lists its base first, present or not). */
const sourceLocales = (imp: TsImport) => [...new Set([...imp.modules.values()].flatMap((m) => m.module.locales))];

/**
 * Shown when Open project finds TypeScript locale modules but no workspace or JSON project.
 * Import builds the workspace in memory; nothing is written until the first Save.
 */
export function ImportTsDialog({ root, localesDir, onCancel }: Props) {
  const fs = useApp((s) => s.fs);
  const openProject = useApp((s) => s.openProject);
  const [preview, setPreview] = useState<TsImport | null>(null);
  const [base, setBase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    importTsLocales(fs, root, localesDir, "th").then(
      (imp) => {
        if (!live) return;
        const locales = sourceLocales(imp);
        setPreview(imp);
        setBase(locales.includes("th") ? "th" : (locales[0] ?? ""));
      },
      (e) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [fs, root, localesDir]);

  const doImport = async () => {
    setBusy(true);
    setError(null);
    try {
      // Drafts depend on the base language: import again with the one chosen.
      const imp = base === "th" && preview ? preview : await importTsLocales(fs, root, localesDir, base);
      const name = root.split("/").filter(Boolean).pop() ?? root;
      const session = await ProjectSession.fromImport(fs, root, imp, { name, localesDir, baseLocale: base });
      const d: DetectResult = {
        format: "next-i18next",
        baseLocale: base,
        locales: session.data.locales,
        namespaces: session.data.namespaces,
        localesPath: WORKSPACE_DIR,
        keyCount: session.data.keyOrder.length,
        workspace: session.workspace!,
      };
      await openProject(root, d, { baseLocale: base, localesPath: WORKSPACE_DIR }, session);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const locales = preview ? sourceLocales(preview) : [];
  const markers = preview ? Object.values(preview.markers).reduce((n, cells) => n + Object.keys(cells).length, 0) : 0;
  return (
    <Dialog title="Import TypeScript translations" onClose={onCancel}>
      <p className="break-all font-mono text-xs text-gray-500">{joinPath(root, localesDir)}</p>
      {preview ? (
        <ul className="mt-4 space-y-0.5 text-sm">
          <li>{preview.modules.size} files</li>
          <li>{preview.keyOrder.length} keys</li>
          <li>{locales.length} languages ({locales.join(", ")})</li>
          <li>{markers} marked "(EN)" (shown as missing)</li>
          <li>{preview.duplicates.length} duplicate keys</li>
          {preview.errors.length > 0 && (
            <li className="text-amber-700">{preview.errors.length} files couldn't be read and are skipped</li>
          )}
        </ul>
      ) : (
        !error && <p className="mt-4 text-sm text-gray-500">Reading…</p>
      )}
      {preview && (
        <label className="mt-4 block text-sm">
          <span className="text-gray-700">Base language</span>
          <select
            aria-label="Base language"
            value={base}
            onChange={(e) => setBase(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5"
          >
            {locales.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </label>
      )}
      <p className="mt-3 text-xs text-gray-500">The workspace is saved in .retrans/ on the first Save. Your source files aren't changed.</p>
      {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button className={btnGhost} onClick={onCancel}>Cancel</button>
        <button className={btnPrimary} disabled={!preview || !base || busy} onClick={() => void doImport()}>Import</button>
      </div>
    </Dialog>
  );
}
