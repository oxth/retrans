import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import type { ProjectSession } from "../core/session";
import { importTsLocales } from "../tssource/import";
import {
  type ExportPlan, PartialExportError, planExport, recordWriteBack, SOURCE_CHANGED_MESSAGE, writeExportPlan,
} from "../workspace/export";
import { type ExportTarget, jsonEqual } from "../workspace/meta";
import { btnGhost, btnPrimary, Dialog, btnSecondary } from "./Dialog";
import { SOURCE_MISSING_MESSAGE, useApp } from "./store";
import { isFigmaRow } from "./ListView";
import { mergeBaseline } from "../figma/export";
import { joinPath } from "../platform/fs";

type Kind = ExportTarget["kind"];
type Namespaces = "per-group" | "single";

export const SOURCE_CONFLICTS_MESSAGE = "Resolve the changes from your code first.";
const FILE_CONFLICTS_MESSAGE = "Resolve conflicts before exporting.";

const OPTIONS: Array<{ kind: Kind; label: string }> = [
  { kind: "ts-writeback", label: "Write back to the original files" },
  { kind: "ts-copy", label: "Write TypeScript files to another folder" },
  { kind: "i18next-json", label: "i18next JSON" },
  { kind: "paraglide", label: "Paraglide" },
  { kind: "ts-modules", label: "TypeScript modules (table style)" },
  { kind: "figma", label: "Figma Variables (.tokens.json)" },
];

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Targets that write TypeScript from the workspace's source files. */
const fromSource = (kind: Kind) => kind === "ts-writeback" || kind === "ts-copy";

/** The target to preselect: the last one (if still possible), else write-back / i18next JSON. */
function initial(session: ProjectSession): { kind: Kind; dir: string | null; namespaces: Namespaces } {
  const hasSource = !!session.workspace?.source;
  const last = session.workspace?.lastExport?.target;
  if (last && (!fromSource(last.kind) || hasSource) && (last.kind !== "figma" || session.workspace?.figma)) {
    return {
      kind: last.kind,
      dir: "dir" in last ? last.dir : null,
      namespaces: last.kind === "i18next-json" ? last.namespaces : "per-group",
    };
  }
  return { kind: hasSource ? "ts-writeback" : "i18next-json", dir: null, namespaces: "per-group" };
}

function targetOf(kind: Kind, dir: string | null, namespaces: Namespaces): ExportTarget | null {
  if (kind === "ts-writeback") return { kind };
  if (dir === null) return null;
  return kind === "i18next-json" ? { kind, dir, namespaces } : { kind, dir };
}

/** An open conflict's message, or null when there is none. */
function conflictMessage(): string | null {
  const { conflicts } = useApp.getState();
  if (conflicts.some((c) => c.origin === "source")) return SOURCE_CONFLICTS_MESSAGE;
  return conflicts.length > 0 ? FILE_CONFLICTS_MESSAGE : null;
}

/** Workspace export (spec §8): write back to the TypeScript sources, or write another format. */
export function ExportDialog({ session, onClose }: { session: ProjectSession; onClose: () => void }) {
  const start = initial(session);
  const [kind, setKind] = useState<Kind>(start.kind);
  const [dir, setDir] = useState<string | null>(start.dir);
  const [namespaces, setNamespaces] = useState<Namespaces>(start.namespaces);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportPlan | null>(null);
  /** A plan waiting for Replace / Cancel because some of its files already exist. */
  const [confirm, setConfirm] = useState<{ t: ExportTarget; plan: ExportPlan; existing: string[] } | null>(null);
  const source = session.workspace?.source;
  const figma = session.workspace?.figma;
  const options = OPTIONS.filter((o) => (!fromSource(o.kind) || source) && (o.kind !== "figma" || figma));
  // Figma files go back into the Figma folder unless another folder is chosen.
  const shownDir = dir ?? (kind === "figma" && figma ? joinPath(session.data.root, figma.dir) : null);
  const target = targetOf(kind, shownDir, namespaces);
  const unmapped = session.data.keyOrder.filter((id) => isFigmaRow(session, id)).length;

  async function chooseFolder() {
    const picked = await open({ directory: true, multiple: false, defaultPath: dir ?? undefined });
    if (typeof picked === "string") setDir(picked);
  }

  /** Plans the export; null when it can't go ahead (`error` set) or waits for Replace / Cancel. */
  async function prepare(t: ExportTarget): Promise<ExportPlan | null> {
    const app = useApp.getState;
    const fail = (m: string) => {
      setError(m);
      return null;
    };
    // Any open conflict blocks: save() wouldn't check when there is nothing to save.
    const blocked = conflictMessage();
    if (blocked) return fail(blocked);
    if (session.isDirty() && !(await app().save())) {
      return fail(conflictMessage() ?? app().error ?? "Couldn't save your changes.");
    }

    if (t.kind === "figma") {
      // Take the latest Figma files first: export never overwrites a change made in Figma.
      await app().syncSource(session);
      const after = conflictMessage();
      if (after) return fail(after);
      if (session.isDirty() && !(await app().save())) return fail(app().error ?? "Couldn't save your changes.");
    }

    let imported;
    if (fromSource(t.kind)) {
      if (!source) return fail("This workspace has no TypeScript source.");
      // Merge source changes first: export never overwrites a change made in the code.
      const r = await app().syncSource(session);
      if (!r.sourceAvailable) return fail(SOURCE_MISSING_MESSAGE);
      if (r.conflicts.length > 0) return fail(SOURCE_CONFLICTS_MESSAGE);
      if (session.isDirty() && !(await app().save())) {
        return fail(conflictMessage() ?? app().error ?? "Couldn't save your changes.");
      }
      imported = await importTsLocales(session.fs, session.data.root, source.localesDir, session.data.baseLocale);
    }

    const plan = await planExport(session, t, imported);
    if (plan.blocked?.reason === "duplicates") {
      return fail(`Can't export while these keys are duplicated: ${plan.blocked.keys.join(", ")}`);
    }
    if (plan.blocked) return fail(SOURCE_CHANGED_MESSAGE);
    if (t.kind !== "ts-writeback") {
      const existing: string[] = [];
      for (const f of plan.files) if (await session.fs.exists(f.path)) existing.push(f.path);
      if (existing.length > 0) {
        setConfirm({ t, plan, existing });
        return null;
      }
    }
    return plan;
  }

  /** Writes the plan, then brings the workspace up to date; null when nothing was written (`error` set). */
  async function write(t: ExportTarget, plan: ExportPlan): Promise<ExportPlan | null> {
    try {
      await writeExportPlan(session.fs, plan);
    } catch (e) {
      const m = msg(e);
      setError(e instanceof PartialExportError || m === SOURCE_CHANGED_MESSAGE ? m : `Export failed: ${m}`);
      return null;
    }
    // The files are written: from here on a failure is only a warning.
    const app = useApp.getState;
    const warnings = [...plan.warnings];
    const warn = (m: string) => warnings.push(`The files were written, but updating the workspace afterwards failed: ${m}`);
    try {
      const settings = { target: t };
      if (!jsonEqual(session.workspace?.lastExport, settings)) session.setWorkspaceMeta({ lastExport: settings });
      const f = session.workspace?.figma;
      if (plan.figmaModes && f) {
        session.setWorkspaceMeta({
          figma: { ...f, modes: { ...f.modes, ...plan.figmaModes }, baseline: mergeBaseline(f.baseline, plan.figmaBaseline ?? {}) },
        });
      }
      if (t.kind === "ts-writeback") {
        recordWriteBack(session, plan);
        // Markers and drafts now follow the files just written; nothing should be left to merge.
        await app().syncSource(session);
      }
      if (session.isDirty() && !(await app().save())) warn(app().error ?? "Couldn't save your changes.");
    } catch (e) {
      warn(msg(e));
    }
    return { ...plan, warnings };
  }

  async function go(step: () => Promise<ExportPlan | null>) {
    setBusy(true);
    setError(null);
    setResult(null);
    setConfirm(null);
    try {
      const plan = await step();
      if (plan) setResult(plan);
    } catch (e) {
      setError(`Export failed: ${msg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function doExport() {
    if (!target) return;
    await go(async () => {
      const plan = await prepare(target);
      return plan && write(target, plan);
    });
  }

  async function replace() {
    if (!confirm) return;
    const { t, plan } = confirm;
    await go(() => write(t, plan));
  }

  const n = result?.files.length ?? 0;
  return (
    <Dialog title="Export" onClose={busy ? undefined : onClose} wide>
      <fieldset className="space-y-1 text-sm" disabled={busy || !!confirm}>
        {options.map((o) => (
          <div key={o.kind}>
            <label className="flex items-center gap-2">
              <input type="radio" name="export-target" checked={kind === o.kind} onChange={() => setKind(o.kind)} />
              {o.label}
            </label>
            {o.kind === "i18next-json" && kind === "i18next-json" && (
              <div className="ml-6 space-y-1">
                <label className="flex items-center gap-2">
                  <input type="radio" name="export-namespaces" checked={namespaces === "per-group"} onChange={() => setNamespaces("per-group")} />
                  One file per group
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="export-namespaces" checked={namespaces === "single"} onChange={() => setNamespaces("single")} />
                  One translation file (translation.json)
                </label>
              </div>
            )}
          </div>
        ))}
      </fieldset>
      {kind !== "ts-writeback" && (
        <div className="mt-3 flex items-center gap-2 text-sm">
          <button className={`${btnSecondary}`} disabled={busy || !!confirm} onClick={() => void chooseFolder()}>
            Choose folder…
          </button>
          <span className="truncate font-mono text-xs text-muted">{shownDir ?? "No folder chosen"}</span>
        </div>
      )}
      {unmapped > 0 && kind !== "figma" && (
        <p className="mt-3 text-sm text-muted">
          {unmapped} Figma {unmapped === 1 ? "string has" : "strings have"} no code key yet —{" "}
          {fromSource(kind) ? "write-back skips them." : "they use their Figma names as keys."}
        </p>
      )}

      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      {confirm && (
        <section aria-label="Files to replace" className="mt-3 space-y-2 text-sm">
          <p>These files already exist and will be replaced:</p>
          <ul className="max-h-40 list-disc overflow-auto pl-5 font-mono text-xs">
            {confirm.existing.map((p) => <li key={p}>{p}</li>)}
          </ul>
          <div className="flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setConfirm(null)}>Cancel</button>
            <button className={btnPrimary} onClick={() => void replace()}>Replace</button>
          </div>
        </section>
      )}
      {result && (
        <div className="mt-3 space-y-3 text-sm">
          <p role="status" className="text-ok">
            {n === 0 ? "Already up to date." : `Exported ${n} ${n === 1 ? "file" : "files"}.`}
          </p>
          {result.leftOutLocales.length > 0 && (
            <section aria-label="Left-out languages" className="space-y-1">
              <p>
                Not written to the TypeScript files: {result.leftOutLocales.join(", ")} — export them in another format, or add them to your code:
              </p>
              {result.leftOutSnippet && <Snippet text={result.leftOutSnippet} />}
            </section>
          )}
          {result.snippets.length > 0 && (
            <section aria-label="Snippets" className="space-y-2">
              {result.snippets.map((s, i) => <Snippet key={i} text={s} />)}
            </section>
          )}
          {result.warnings.length > 0 && (
            <ul aria-label="Warnings" className="list-disc pl-5 text-warn">
              {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button className={btnGhost} disabled={busy} onClick={onClose}>Close</button>
        <button className={btnPrimary} disabled={busy || !target || !!confirm} onClick={() => void doExport()}>Export</button>
      </div>
    </Dialog>
  );
}

function Snippet({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-auto rounded-md bg-panel p-3 pr-16 text-xs">{text}</pre>
      <button
        className={`${btnSecondary} absolute right-1 top-1 bg-surface text-xs`}
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false));
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
