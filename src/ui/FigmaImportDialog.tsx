import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import type { ProjectSession } from "../core/session";
import { isValidLocale } from "../core/session-helpers";
import { parseTokens, suggestLocale } from "../figma/tokens";
import { joinPath } from "../platform/fs";
import { FIGMA_DEFAULT_DIR } from "../workspace/meta";
import { btnGhost, btnPrimary, Dialog, inputCls } from "./Dialog";
import { saveFigma } from "./figma-meta";
import { useApp } from "./store";

interface Picked {
  path: string;
  name: string;
  text: string;
  mode: string;
}

const baseName = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p;
/** "…/ALL (1)/ENG.tokens.json" -> "ALL": the folder Figma exported into, without a " (n)" copy suffix. */
const collectionOf = (p: string) => {
  const parts = p.replace(/\\/g, "/").split("/");
  return (parts[parts.length - 2] ?? "").replace(/\s*\(\d+\)$/, "").trim();
};

/** Import Figma files…: copies picked .tokens.json files into the workspace's Figma folder and maps their modes. */
export function FigmaImportDialog({ session, onClose }: { session: ProjectSession; onClose: () => void }) {
  const fs = useApp((s) => s.fs);
  const [files, setFiles] = useState<Picked[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [collection, setCollection] = useState("");
  const [modes, setModes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const known = session.workspace?.figma?.modes ?? {};

  useEffect(() => {
    let live = true;
    (async () => {
      const picked = await open({ multiple: true, filters: [{ name: "Figma Variables", extensions: ["json"] }] });
      const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
      if (!live) return;
      if (!paths.length) return onClose();
      const out: Picked[] = [];
      for (const path of paths) {
        const name = baseName(path);
        const text = await fs.readText(path);
        const parsed = parseTokens(text);
        if (!parsed.ok || parsed.mode === null) {
          if (live) setProblem(`${name} isn't a Figma Variables export.`);
          out.push({ path, name, text, mode: "" });
          continue;
        }
        out.push({ path, name, text, mode: parsed.mode });
      }
      const seen = new Set<string>();
      for (const f of out) {
        if (!f.mode) continue;
        if (seen.has(f.mode) && live) setProblem(`Two files are for mode ${f.mode}.`);
        seen.add(f.mode);
      }
      if (!live) return;
      setFiles(out);
      setCollection(collectionOf(paths[0]));
      setModes(Object.fromEntries([...seen].map((m) => [m, known[m] ?? suggestLocale(m) ?? ""])));
    })().catch((e) => live && setProblem(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (files === null && !problem) return null;
  const locales = session.data.locales;
  const ready = !!files && !problem && collection.trim() !== "" && !/[\\/]/.test(collection) && Object.values(modes).every((l) => isValidLocale(l));

  const doImport = async () => {
    if (!files || !ready) return;
    setBusy(true);
    try {
      const dir = session.workspace?.figma?.dir ?? FIGMA_DEFAULT_DIR;
      for (const f of files) await fs.writeTextAtomic(joinPath(session.data.root, dir, collection.trim(), f.name), f.text);
      saveFigma(session, { dir, modes: { ...known, ...modes } });
      onClose();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog title="Import Figma files" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <label className="block">
          Collection
          <input aria-label="Collection" className={inputCls} value={collection} onChange={(e) => setCollection(e.target.value)} />
        </label>
        {Object.keys(modes).map((m) => (
          <label key={m} className="block">
            Mode {m}
            <input
              aria-label={`Language for ${m}`}
              className={inputCls}
              list="figma-import-locales"
              value={modes[m]}
              onChange={(e) => setModes({ ...modes, [m]: e.target.value.trim() })}
            />
          </label>
        ))}
        <datalist id="figma-import-locales">
          {locales.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
        {problem && <p role="alert" className="text-danger">{problem}</p>}
        <div className="flex justify-end gap-2">
          <button className={btnGhost} onClick={onClose}>Cancel</button>
          <button className={btnPrimary} disabled={!ready || busy} onClick={() => void doImport()}>Import</button>
        </div>
      </div>
    </Dialog>
  );
}
