import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import type { ProjectSession } from "../core/session";
import { buildPreviewBundle } from "../preview/build";
import { serializePreview } from "../preview/format";
import { applyResults, type ResultsDiff } from "../preview/results";
import { btnGhost, btnPrimary, Dialog, inputCls } from "./Dialog";
import { useApp } from "./store";
import { languageWithCode } from "./locales";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Exports the drafts of one language as a preview file for the Retrans Preview Figma plugin. */
export function PreviewExportDialog({ session, onClose }: { session: ProjectSession; onClose: () => void }) {
  const fs = useApp((s) => s.fs);
  const targets = session.data.locales.filter((l) => l !== session.data.baseLocale);
  const [locale, setLocale] = useState(targets[0] ?? "");
  const [includeReviewed, setIncludeReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasId, setHasId] = useState(!!session.state.project.id);

  // The bundle names the project, so results can be checked against it; same rule as packages.
  useEffect(() => {
    if (hasId || session.stateMalformed) return;
    session.setProjectSetting({ id: crypto.randomUUID() });
    void useApp.getState().save().then((ok) => ok && setHasId(true));
  }, [hasId, session]);

  const attempt = useMemo(() => {
    if (!hasId || !locale) return null;
    try {
      return { built: buildPreviewBundle(session, locale, { includeReviewed }), error: null };
    } catch (e) {
      return { built: null, error: msg(e) };
    }
  }, [session, locale, includeReviewed, hasId]);
  const built = attempt?.built ?? null;

  const count = built?.bundle.strings.length ?? 0;
  const left = built ? built.leftOut.noVariable + built.leftOut.complex : 0;
  const name = session.data.root.split("/").filter(Boolean).pop() ?? "project";

  async function doExport() {
    if (!built) return;
    setBusy(true);
    setError(null);
    try {
      const dest = await save({
        defaultPath: `${name}-${locale}.retrans-preview.json`,
        filters: [{ name: "Retrans preview", extensions: ["json"] }],
      });
      if (!dest) return;
      await fs.writeTextAtomic(dest, serializePreview(built.bundle));
      setDone(`Saved ${fileName(dest)}.`);
    } catch (e) {
      setError(`Export failed: ${msg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Export preview for a designer" onClose={busy ? undefined : onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-muted">
          A designer loads this file in the Retrans Preview Figma plugin to check that the drafts fit, then sends you a results file.
        </p>
        <label className="flex items-center gap-2">
          Language
          <select aria-label="Language" className={inputCls} value={locale} onChange={(e) => setLocale(e.target.value)} disabled={busy}>
            {targets.map((l) => <option key={l} value={l}>{languageWithCode(l)}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={includeReviewed} onChange={(e) => setIncludeReviewed(e.target.checked)} disabled={busy} />
          Include reviewed translations
        </label>
        {built && count > 0 && (
          <p>
            {count} {count === 1 ? "string" : "strings"} · {left} left out (no Figma variable: {built.leftOut.noVariable}, plural: {built.leftOut.complex})
          </p>
        )}
        {built && count === 0 && <p className="text-warn">Nothing to preview in {languageWithCode(locale)}: no {includeReviewed ? "" : "unreviewed "}drafts are linked to Figma.</p>}
        {(error ?? attempt?.error) && <p role="alert" className="text-danger">{error ?? attempt?.error}</p>}
        {done && <p role="status" className="text-ok">{done}</p>}
        <div className="flex justify-end gap-2">
          <button className={btnGhost} onClick={onClose} disabled={busy}>{done ? "Close" : "Cancel"}</button>
          <button className={btnPrimary} onClick={() => void doExport()} disabled={busy || count === 0}>Export…</button>
        </div>
      </div>
    </Dialog>
  );
}

/** What a designer's results file would change, before it is applied. */
export function PreviewResultsDialog({ session, diff, onClose, onApplied }: {
  session: ProjectSession;
  diff: ResultsDiff;
  onClose: () => void;
  onApplied: (count: number) => void;
}) {
  const skipped = diff.changedSinceChecked + diff.missingKeys + diff.unreadable;
  const notes = diff.apply.filter((r) => r.note).length;
  return (
    <Dialog title="Import designer results" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>Results for {languageWithCode(diff.locale)}</p>
        <p>
          {diff.fits} fit · {diff.tooLong} too long
          {notes > 0 && ` · ${notes} with ${notes === 1 ? "a note" : "notes"}`}
        </p>
        {diff.changedSinceChecked > 0 && <p className="text-muted">{diff.changedSinceChecked} changed since checked (skipped)</p>}
        {diff.missingKeys > 0 && <p className="text-muted">{diff.missingKeys} no longer in this project (skipped)</p>}
        {diff.unreadable > 0 && <p className="text-muted">{diff.unreadable} couldn't be read (skipped)</p>}
        {diff.otherProject && <p className="text-warn">This file was made for another project. Check it's the right one before applying.</p>}
        {diff.apply.length === 0 && skipped > 0 && <p>Nothing left to apply.</p>}
        <div className="flex justify-end gap-2">
          <button className={btnGhost} onClick={onClose}>Cancel</button>
          <button className={btnPrimary} disabled={diff.apply.length === 0} onClick={() => onApplied(applyResults(session, diff))}>Apply</button>
        </div>
      </div>
    </Dialog>
  );
}
