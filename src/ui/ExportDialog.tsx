import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import type { ProjectSession } from "../core/session";
import { importTsLocales } from "../tssource/import";
import { type ExportPlan, planExport, recordWriteBack, writeExportPlan } from "../workspace/export";
import { type ExportTarget, jsonEqual } from "../workspace/meta";
import { btnGhost, btnPrimary, Dialog } from "./Dialog";
import { SOURCE_MISSING_MESSAGE, useApp } from "./store";

type Kind = ExportTarget["kind"];
type Namespaces = "per-group" | "single";

export const SOURCE_CONFLICTS_MESSAGE = "Resolve the changes from your code first.";
const FILE_CONFLICTS_MESSAGE = "Resolve conflicts before saving.";

const OPTIONS: Array<{ kind: Kind; label: string }> = [
  { kind: "ts-writeback", label: "Write back to the original files" },
  { kind: "ts-copy", label: "Write TypeScript files to another folder" },
  { kind: "i18next-json", label: "i18next JSON" },
  { kind: "paraglide", label: "Paraglide" },
  { kind: "ts-modules", label: "TypeScript modules (table style)" },
];

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The target to preselect: the last one (if still possible), else write-back / i18next JSON. */
function initial(session: ProjectSession): { kind: Kind; dir: string | null; namespaces: Namespaces } {
  const hasSource = !!session.workspace?.source;
  const last = session.workspace?.lastExport?.target;
  if (last && (last.kind !== "ts-writeback" || hasSource)) {
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
  const source = session.workspace?.source;
  const options = OPTIONS.filter((o) => o.kind !== "ts-writeback" || source);
  const target = targetOf(kind, dir, namespaces);

  async function chooseFolder() {
    const picked = await open({ directory: true, multiple: false, defaultPath: dir ?? undefined });
    if (typeof picked === "string") setDir(picked);
  }

  async function run(t: ExportTarget) {
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

    const ts = t.kind === "ts-writeback" || t.kind === "ts-copy";
    let imported;
    if (ts) {
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
    if (plan.blocked) return fail("Your code changed while exporting. Export again.");
    await writeExportPlan(session.fs, plan);

    const settings = { target: t };
    if (!jsonEqual(session.workspace?.lastExport, settings)) session.setWorkspaceMeta({ lastExport: settings });
    if (t.kind === "ts-writeback") {
      recordWriteBack(session, plan);
      // Markers and drafts now follow the files just written; nothing should be left to merge.
      await app().syncSource(session);
    }
    if (session.isDirty()) await app().save();
    return plan;
  }

  async function doExport() {
    if (!target) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const plan = await run(target);
      if (plan) setResult(plan);
    } catch (e) {
      setError(`Export failed: ${msg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const n = result?.files.length ?? 0;
  return (
    <Dialog title="Export" onClose={onClose} wide>
      <fieldset className="space-y-1 text-sm" disabled={busy}>
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
          <button className={`${btnGhost} border border-gray-300`} disabled={busy} onClick={() => void chooseFolder()}>
            Choose folder…
          </button>
          <span className="truncate font-mono text-xs text-gray-600">{dir ?? "No folder chosen"}</span>
        </div>
      )}

      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      {result && (
        <div className="mt-3 space-y-3 text-sm">
          <p role="status" className="text-green-700">Exported {n} {n === 1 ? "file" : "files"}.</p>
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
            <ul aria-label="Warnings" className="list-disc pl-5 text-amber-800">
              {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose}>Close</button>
        <button className={btnPrimary} disabled={busy || !target} onClick={() => void doExport()}>Export</button>
      </div>
    </Dialog>
  );
}

function Snippet({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-auto rounded-md bg-gray-50 p-3 pr-16 text-xs">{text}</pre>
      <button
        className={`${btnGhost} absolute right-1 top-1 border border-gray-300 bg-white text-xs`}
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
