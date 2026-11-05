import { useEffect, useState } from "react";
import { isValidLocale } from "../core/session-helpers";
import type { ProjectSession } from "../core/session";
import { readFigmaFolder } from "../figma/sync";
import { joinPath } from "../platform/fs";
import { FIGMA_DEFAULT_DIR, isSafeLocalesDir } from "../workspace/meta";
import { btnGhost, inputCls } from "./Dialog";
import { FigmaImportDialog } from "./FigmaImportDialog";
import { saveFigma } from "./figma-meta";
import { useApp, useSessionVersion } from "./store";

const NEW = "__new";

/** Settings → Figma (workspaces only): the Figma folder, which language each Figma mode is, and Import. */
export function FigmaSettings({ session }: { session: ProjectSession }) {
  useSessionVersion();
  const fs = useApp((s) => s.fs);
  const figma = session.workspace?.figma;
  const [dir, setDir] = useState(figma?.dir ?? FIGMA_DEFAULT_DIR);
  const [dirNote, setDirNote] = useState<string | null>(null);
  const [found, setFound] = useState<string[]>([]);
  const [adding, setAdding] = useState<{ mode: string; code: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const currentDir = figma?.dir ?? FIGMA_DEFAULT_DIR;

  useEffect(() => {
    let live = true;
    (async () => {
      if (!(await fs.exists(joinPath(session.data.root, currentDir)))) return [];
      const folder = await readFigmaFolder(fs, session.data.root, currentDir);
      return folder.files.flatMap((f) => (f.parsed.ok && f.parsed.mode !== null ? [f.parsed.mode] : []));
    })().then(
      (modes) => live && setFound([...new Set(modes)]),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [fs, session, currentDir, figma]);

  if (!session.workspace) return null;
  const mapped = figma?.modes ?? {};
  const modes = [...new Set([...Object.keys(mapped), ...found])].sort();
  const setMode = (mode: string, locale: string) => {
    const next = { ...mapped };
    if (locale) next[mode] = locale;
    else delete next[mode];
    saveFigma(session, { modes: next });
  };

  return (
    <div className="space-y-3">
      <label className="block">
        Figma folder
        <div className="flex gap-2">
          <input aria-label="Figma folder" className={inputCls} value={dir} onChange={(e) => setDir(e.target.value)} />
          <button
            className={btnGhost}
            onClick={() => {
              const d = dir.trim().replace(/\/+$/, "");
              if (!d || !isSafeLocalesDir(d)) return setDirNote("The folder must be inside the project.");
              setDirNote(null);
              saveFigma(session, { dir: d });
            }}
          >
            Save folder
          </button>
        </div>
      </label>
      {dirNote && <p role="alert" className="text-danger">{dirNote}</p>}
      {modes.length > 0 && (
        <div className="space-y-2">
          {modes.map((m) => (
            <label key={m} className="flex items-center gap-2">
              <span className="w-24 shrink-0">Mode {m}</span>
              <select
                aria-label={`Language for ${m}`}
                className={inputCls}
                value={mapped[m] ?? ""}
                onChange={(e) => (e.target.value === NEW ? setAdding({ mode: m, code: "" }) : setMode(m, e.target.value))}
              >
                <option value="">(not set)</option>
                {[...new Set([...session.data.locales, ...(mapped[m] ? [mapped[m]] : [])])].map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
                <option value={NEW}>Add new…</option>
              </select>
            </label>
          ))}
        </div>
      )}
      {adding && (
        <div className="flex items-center gap-2">
          <input
            aria-label={`New language code for ${adding.mode}`}
            className={inputCls}
            value={adding.code}
            onChange={(e) => setAdding({ ...adding, code: e.target.value.trim() })}
          />
          <button
            className={btnGhost}
            disabled={!isValidLocale(adding.code)}
            onClick={() => {
              setMode(adding.mode, adding.code);
              setAdding(null);
            }}
          >
            Add
          </button>
        </div>
      )}
      <button className={btnGhost} onClick={() => setImporting(true)}>Import Figma files…</button>
      {importing && <FigmaImportDialog session={session} onClose={() => setImporting(false)} />}
    </div>
  );
}
