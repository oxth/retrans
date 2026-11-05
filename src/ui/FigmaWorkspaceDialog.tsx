import { useState } from "react";
import { isValidLocale } from "../core/session-helpers";
import { detectProject } from "../formats/detect";
import { suggestLocale } from "../figma/tokens";
import { readFigmaFolder } from "../figma/sync";
import type { Fs } from "../platform/fs";
import { createWorkspace } from "../workspace/store";
import { btnGhost, btnPrimary, Dialog, inputCls } from "./Dialog";
import { useApp } from "./store";

/** The Figma modes of the `*.tokens.json` files in `root` (and one folder down), or [] when there are none. */
export async function figmaModesIn(fs: Fs, root: string): Promise<string[]> {
  try {
    const folder = await readFigmaFolder(fs, root, ".");
    return [...new Set(folder.files.flatMap((f) => (f.parsed.ok && f.parsed.mode !== null ? [f.parsed.mode] : [])))].sort();
  } catch {
    return [];
  }
}

/**
 * Open project on a folder of Figma Variables exports: makes that folder a Retrans workspace whose
 * Figma folder is the folder itself, then opens it. The Figma files are not changed.
 */
export function FigmaWorkspaceDialog({ root, modes, onClose }: { root: string; modes: string[]; onClose: () => void }) {
  const fs = useApp((s) => s.fs);
  const [map, setMap] = useState<Record<string, string>>(() => Object.fromEntries(modes.map((m) => [m, suggestLocale(m) ?? ""])));
  const locales = [...new Set(Object.values(map).filter((l) => isValidLocale(l)))];
  const [base, setBase] = useState<string>(() => (locales.includes("en") ? "en" : (locales[0] ?? "")));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const baseNow = locales.includes(base) ? base : (locales[0] ?? "");
  const ready = modes.every((m) => isValidLocale(map[m] ?? "")) && !!baseNow;
  const name = root.split("/").filter(Boolean).pop() ?? root;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await createWorkspace(fs, root, {
        name, baseLocale: baseNow, locales,
        figma: { dir: ".", modes: map, vars: {}, baseline: {} },
      });
      const d = await detectProject(fs, root);
      if (!d) throw new Error("The workspace was created but couldn't be opened.");
      await useApp.getState().openProject(root, d, { baseLocale: baseNow, localesPath: d.localesPath });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog title="Create a workspace from Figma files" onClose={busy ? undefined : onClose}>
      <div className="space-y-3 text-sm">
        <p>
          This folder has Figma Variables files ({modes.join(", ")}). Retrans will add a <span className="font-mono">.retrans</span> folder
          here for its workspace; the Figma files stay as they are.
        </p>
        {modes.map((m) => (
          <label key={m} className="block">
            Mode {m}
            <input
              aria-label={`Language for ${m}`}
              className={inputCls}
              value={map[m] ?? ""}
              onChange={(e) => setMap({ ...map, [m]: e.target.value.trim() })}
            />
          </label>
        ))}
        <label className="block">
          Base language
          <select aria-label="Base language" className={inputCls} value={baseNow} onChange={(e) => setBase(e.target.value)}>
            {locales.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </label>
        {error && <p role="alert" className="text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className={btnGhost} disabled={busy} onClick={onClose}>Cancel</button>
          <button className={btnPrimary} disabled={!ready || busy} onClick={() => void create()}>Create workspace</button>
        </div>
      </div>
    </Dialog>
  );
}
