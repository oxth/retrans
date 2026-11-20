import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { isValidLocale } from "../core/session-helpers";
import type { ProjectSession } from "../core/session";
import { readFigmaFolder } from "../figma/sync";
import { parseResults } from "../preview/format";
import { diffResults, type ResultsDiff } from "../preview/results";
import { joinPath } from "../platform/fs";
import { FIGMA_DEFAULT_DIR, isSafeLocalesDir } from "../workspace/meta";
import { btnPrimary, btnSecondary } from "./Dialog";
import { btnRow, fieldBase, fieldCls, Group, Row, useSaveNote } from "./settings-ui";
import { languageWithCode } from "./locales";
import { FigmaImportDialog } from "./FigmaImportDialog";
import { PreviewExportDialog, PreviewResultsDialog } from "./PreviewDialogs";
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
  const [previewing, setPreviewing] = useState(false);
  const [results, setResults] = useState<ResultsDiff | null>(null);
  const [previewNote, setPreviewNote] = useState<{ ok: boolean; text: string } | null>(null);
  const currentDir = figma?.dir ?? FIGMA_DEFAULT_DIR;
  const dirSaved = useSaveNote();
  const modesSaved = useSaveNote();

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
    modesSaved.trackProject(() => saveFigma(session, { modes: next }));
  };


  async function importResults() {
    setPreviewNote(null);
    try {
      const picked = await open({ multiple: false, directory: false, filters: [{ name: "Retrans results", extensions: ["json"] }] });
      if (typeof picked !== "string") return;
      const parsed = parseResults(await fs.readText(picked));
      if (!parsed.ok) return setPreviewNote({ ok: false, text: parsed.error });
      const d = diffResults(session, parsed.results, parsed.unreadable);
      if (!d.ok) return setPreviewNote({ ok: false, text: d.error });
      setResults(d.diff);
    } catch (e) {
      setPreviewNote({ ok: false, text: `Import failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  return (
    <>
      <Group label="Folder" footer={dirNote ? <span role="alert" className="text-danger">{dirNote}</span> : dirSaved.footer}>
        <Row label="Figma folder" hint="Where exported Figma variable files are kept, inside the project." htmlFor="figma-dir">
          <input id="figma-dir" aria-label="Figma folder" className={`${fieldBase} w-52 font-mono`} value={dir} onChange={(e) => setDir(e.target.value)} />
          <button
            type="button"
            className={btnRow}
            onClick={() => {
              const d = dir.trim().replace(/\/+$/, "");
              if (!d || !isSafeLocalesDir(d)) return setDirNote("The folder must be inside the project.");
              setDirNote(null);
              dirSaved.trackProject(() => saveFigma(session, { dir: d }));
            }}
          >
            Save folder
          </button>
        </Row>
      </Group>
      <Group label="Modes" footer={modesSaved.footer ?? "Each Figma mode is one language of this workspace."}>
        {modes.length === 0 && <Row label="No modes found" hint={`Add Figma files to ${currentDir} and they show up here.`} />}
        {modes.map((m) => (
          <Row key={m} label={<>Mode <span className="font-mono">{m}</span></>} htmlFor={`figma-mode-${m}`}>
            <select
              id={`figma-mode-${m}`}
              aria-label={`Language for ${m}`}
              className={fieldCls}
              value={mapped[m] ?? ""}
              onChange={(e) => (e.target.value === NEW ? setAdding({ mode: m, code: "" }) : setMode(m, e.target.value))}
            >
              <option value="">(not set)</option>
              {[...new Set([...session.data.locales, ...(mapped[m] ? [mapped[m]] : [])])].map((l) => (
                <option key={l} value={l}>{languageWithCode(l)}</option>
              ))}
              <option value={NEW}>Add new…</option>
            </select>
          </Row>
        ))}
        {adding && (
          <Row label={<>New language for <span className="font-mono">{adding.mode}</span></>} hint="A language code, e.g. th or pt-BR." htmlFor="figma-new-code">
            <input
              id="figma-new-code"
              aria-label={`New language code for ${adding.mode}`}
              className={`${fieldBase} w-36 font-mono`}
              value={adding.code}
              onChange={(e) => setAdding({ ...adding, code: e.target.value.trim() })}
            />
            <button
              type="button"
              className={btnRow}
              disabled={!isValidLocale(adding.code)}
              onClick={() => {
                setMode(adding.mode, adding.code);
                setAdding(null);
              }}
            >
              Add
            </button>
          </Row>
        )}
      </Group>
      <Group label="Import">
        <Row label="Import Figma files" hint="Bring translations in from Figma variable exports.">
          <button type="button" className={btnPrimary} onClick={() => setImporting(true)}>Import Figma files…</button>
        </Row>
      </Group>
      {figma && <Group
        label="Designer preview"
        footer={previewNote ? <span role={previewNote.ok ? "status" : "alert"} className={previewNote.ok ? "text-ok" : "text-danger"}>{previewNote.text}</span> : "A designer checks drafts in Figma with the Retrans Preview plugin."}
      >
        <Row label="Export preview" hint="Drafts of one language, for the designer to load in Figma.">
          <button type="button" className={btnSecondary} onClick={() => setPreviewing(true)}>Export preview for a designer…</button>
        </Row>
        <Row label="Import results" hint="The designer's Fits / Too long marks.">
          <button type="button" className={btnSecondary} onClick={() => void importResults()}>Import designer results…</button>
        </Row>
      </Group>}
      {importing && <FigmaImportDialog session={session} onClose={() => setImporting(false)} />}
      {previewing && <PreviewExportDialog session={session} onClose={() => setPreviewing(false)} />}
      {results && (
        <PreviewResultsDialog
          session={session}
          diff={results}
          onClose={() => setResults(null)}
          onApplied={(n) => {
            setResults(null);
            setPreviewNote({ ok: true, text: `Added ${n} designer ${n === 1 ? "verdict" : "verdicts"}. Review and save.` });
          }}
        />
      )}
    </>
  );
}
