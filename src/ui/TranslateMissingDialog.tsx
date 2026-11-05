import { useMemo, useState } from "react";
import { parseKeyId } from "../core/model";
import type { ProjectSession } from "../core/session";
import { type BatchResult, missingItems } from "../mt/batch";
import { Dialog, btnGhost, btnPrimary, inputCls } from "./Dialog";
import { activeTranslator, useMt } from "./mt-store";
import { instructionsFor } from "./instructions";
import { cancelRun, clearRun, type RunPhase, startRun, UNTABBED, useRuns } from "./runs";
import { useApp, useSessionVersion } from "./store";

const LIST_MAX = 20;

export function TranslateMissingDialog(p: { session: ProjectSession; onClose: () => void; defaultLocale?: string }) {
  const { session } = p;
  const version = useSessionVersion();
  const mt = useMt();
  const { baseLocale, locales, namespaces, format } = session.data;
  const targets = useMemo(() => locales.filter((l) => l !== baseLocale), [locales, baseLocale]);
  const [picked, setPicked] = useState<string[]>(() => {
    const first = p.defaultLocale && targets.includes(p.defaultLocale) ? p.defaultLocale : targets[0];
    return first ? [first] : [];
  });
  const [ns, setNs] = useState("all");
  const translator = activeTranslator(mt, format, session.state.project.mtProvider);
  // The run lives in the tab, not in this dialog: hiding the dialog or switching tabs keeps it going.
  const tabId = useApp((s) => s.tabIdOf(session)) ?? UNTABBED;
  const run = useRuns((s) => s.byTab[tabId] as RunPhase | undefined);
  const phase: { kind: "setup" } | RunPhase = run ?? { kind: "setup" };

  const missing = useMemo(
    () => picked.reduce((n, l) => n + missingItems(session, l, ns).length, 0),
    [session, picked, ns, version],
  );
  const toggle = (l: string) => setPicked((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : targets.filter((t) => t === l || cur.includes(t))));
  const all = targets.length > 0 && picked.length === targets.length;

  const start = () => {
    if (!translator || !missing) return;
    startRun(tabId, session, picked, ns, translator, instructionsFor(session));
  };

  const cancel = () => cancelRun(tabId);
  const close = () => {
    if (phase.kind === "done") clearRun(tabId);
    p.onClose();
  };

  const running = phase.kind === "running";
  const sum = (k: "done" | "total") => (running ? Object.values(phase.perLocale).reduce((n, x) => n + x[k], 0) : 0);
  const done = sum("done");
  const total = sum("total");
  return (
    <Dialog title="Translate missing" onClose={running ? undefined : close}>
      {phase.kind === "setup" && (
        <div className="space-y-3">
          <fieldset className="text-sm">
            <legend>Languages</legend>
            <label className="mr-4 inline-flex items-center gap-1.5">
              <input type="checkbox" checked={all} onChange={() => setPicked(all ? [] : targets)} />
              All languages
            </label>
            {targets.map((l) => (
              <label key={l} className="mr-4 inline-flex items-center gap-1.5">
                <input type="checkbox" checked={picked.includes(l)} onChange={() => toggle(l)} />
                {l}
              </label>
            ))}
          </fieldset>
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
          <p className="text-sm text-muted">{missing} missing</p>
          {translator?.remote && <p className="text-xs text-muted">Uses {translator.label}.</p>}
          <div className="flex justify-end gap-2">
            <button className={btnGhost} onClick={p.onClose}>Close</button>
            <button className={btnPrimary} disabled={!missing || !translator} onClick={start}>Start</button>
          </div>
        </div>
      )}
      {phase.kind === "running" && (
        <div className="space-y-3">
          <p className="text-sm text-muted">Translating with {phase.label}…</p>
          <div
            role="progressbar"
            aria-label="Translation progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={total ? Math.round((done / total) * 100) : 0}
            className="h-2 overflow-hidden rounded bg-sunken"
          >
            <div className="h-full bg-brand" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
          </div>
          <p className="text-sm">{`${done} of ${total}`}</p>
          {phase.locales.length > 1 && (
            <ul className="text-xs text-muted">
              {phase.locales.map((l) => (
                <li key={l}>{`${l}: ${phase.perLocale[l]?.done ?? 0} of ${phase.perLocale[l]?.total ?? 0}`}</li>
              ))}
            </ul>
          )}
          {phase.current && <p className="truncate font-mono text-xs text-muted">{parseKeyId(phase.current).key}</p>}
          <div className="flex justify-end gap-2">
            <button className={btnGhost} onClick={p.onClose}>Hide (keeps running)</button>
            <button className={btnGhost} onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}
      {phase.kind === "done" && (
        <div className="space-y-4">
          {phase.locales.map((l) => (
            <section key={l} className="space-y-2">
              {phase.locales.length > 1 && <h3 className="text-sm font-semibold">{l}</h3>}
              <Summary result={phase.results[l]} />
            </section>
          ))}
          <p className="text-xs text-muted">Machine translations are marked for review.</p>
          <div className="flex justify-end">
            <button className={btnPrimary} onClick={close}>Close</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function Summary({ result: r }: { result: BatchResult }) {
  const keys = [...r.unsafe, ...r.failed.map((f) => f.id)].slice(0, LIST_MAX);
  return (
    <div className="space-y-2 text-sm">
      {r.cancelled && <p>Stopped.</p>}
      <p>Translated {r.translated}.</p>
      {r.unsafe.length > 0 && <p>{r.unsafe.length} couldn't be translated safely.</p>}
      {r.failed.length > 0 && (
        <>
          <p>{r.failed.length} failed.</p>
          <ul className="text-xs text-danger">
            {[...new Set(r.failed.map((f) => f.message))].map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </>
      )}
      {r.skipped > 0 && <p>{r.skipped} skipped (changed while running).</p>}
      {keys.length > 0 && (
        <ul className="max-h-40 overflow-auto font-mono text-xs text-muted">
          {keys.map((id) => (
            <li key={id}>{parseKeyId(id).key}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
