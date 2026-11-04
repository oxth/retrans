import { useMemo, useState } from "react";
import { parseKeyId } from "../core/model";
import type { ProjectSession } from "../core/session";
import { type BatchResult, missingItems } from "../mt/batch";
import { nextReqId, translateText } from "../mt/translate";
import { Dialog, btnGhost, btnPrimary, inputCls } from "./Dialog";
import { activeModel, useMt } from "./mt-store";
import { cancelRun, clearRun, type RunPhase, startRun, UNTABBED, useRuns } from "./runs";
import { useApp, useSessionVersion } from "./store";
import { useShallow } from "zustand/react/shallow";

const LIST_MAX = 20;

export function TranslateMissingDialog(p: { session: ProjectSession; onClose: () => void; defaultLocale?: string }) {
  const { session } = p;
  const version = useSessionVersion();
  const engine = useMt((s) => s.engine);
  const model = useMt(useShallow((s) => activeModel(s)));
  const { baseLocale, locales, namespaces, format } = session.data;
  const targets = useMemo(() => locales.filter((l) => l !== baseLocale), [locales, baseLocale]);
  const [locale, setLocale] = useState(p.defaultLocale && targets.includes(p.defaultLocale) ? p.defaultLocale : (targets[0] ?? ""));
  const [ns, setNs] = useState("all");
  // The run lives in the tab, not in this dialog: hiding the dialog or switching tabs keeps it going.
  const tabId = useApp((s) => s.tabIdOf(session)) ?? UNTABBED;
  const run = useRuns((s) => s.byTab[tabId] as RunPhase | undefined);
  const phase: { kind: "setup" } | RunPhase = run ?? { kind: "setup" };

  const items = useMemo(
    () => (locale ? missingItems(session, locale, ns) : []),
    [session, locale, ns, version],
  );

  const start = () => {
    if (!model || !items.length) return;
    startRun(tabId, session, items, locale, async (source, onRequest) => {
      const id = nextReqId();
      onRequest(() => void engine.cancel(id).catch(() => {}));
      return translateText(engine, model, format, baseLocale, locale, source, id);
    });
  };

  const cancel = () => cancelRun(tabId);
  const close = () => {
    if (phase.kind === "done") clearRun(tabId);
    p.onClose();
  };

  const running = phase.kind === "running";
  return (
    <Dialog title="Translate missing" onClose={running ? undefined : close}>
      {phase.kind === "setup" && (
        <div className="space-y-3">
          <label className="block text-sm">
            Language
            <select className={inputCls} value={locale} onChange={(e) => setLocale(e.target.value)}>
              {targets.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </label>
          {format === "next-i18next" && (
            <label className="block text-sm">
              {session.workspace ? "Group" : "Namespace"}
              <select className={inputCls} value={ns} onChange={(e) => setNs(e.target.value)}>
                <option value="all">{session.workspace ? "All groups" : "All namespaces"}</option>
                {namespaces.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          )}
          <p className="text-sm text-gray-600">{items.length} missing</p>
          <div className="flex justify-end gap-2">
            <button className={btnGhost} onClick={p.onClose}>Close</button>
            <button className={btnPrimary} disabled={!items.length || !model} onClick={start}>Start</button>
          </div>
        </div>
      )}
      {phase.kind === "running" && (
        <div className="space-y-3">
          <div
            role="progressbar"
            aria-label="Translation progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={phase.total ? Math.round((phase.done / phase.total) * 100) : 0}
            className="h-2 overflow-hidden rounded bg-gray-200"
          >
            <div className="h-full bg-indigo-600" style={{ width: `${phase.total ? (phase.done / phase.total) * 100 : 0}%` }} />
          </div>
          <p className="text-sm">{phase.done} of {phase.total}</p>
          {phase.current && <p className="truncate font-mono text-xs text-gray-600">{parseKeyId(phase.current).key}</p>}
          <div className="flex justify-end gap-2">
            <button className={btnGhost} onClick={p.onClose}>Hide (keeps running)</button>
            <button className={btnGhost} onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}
      {phase.kind === "done" && <Summary result={phase.result} onClose={close} />}
    </Dialog>
  );
}

function Summary({ result: r, onClose }: { result: BatchResult; onClose: () => void }) {
  const keys = [...r.unsafe, ...r.failed.map((f) => f.id)].slice(0, LIST_MAX);
  return (
    <div className="space-y-2 text-sm">
      {r.cancelled && <p>Stopped.</p>}
      <p>Translated {r.translated}.</p>
      {r.unsafe.length > 0 && <p>{r.unsafe.length} couldn't be translated safely.</p>}
      {r.failed.length > 0 && (
        <>
          <p>{r.failed.length} failed.</p>
          <ul className="text-xs text-red-600">
            {[...new Set(r.failed.map((f) => f.message))].map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </>
      )}
      {r.skipped > 0 && <p>{r.skipped} skipped (changed while running).</p>}
      {keys.length > 0 && (
        <ul className="max-h-40 overflow-auto font-mono text-xs text-gray-600">
          {keys.map((id) => (
            <li key={id}>{parseKeyId(id).key}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-gray-500">Machine translations are marked for review.</p>
      <div className="flex justify-end">
        <button className={btnPrimary} onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
