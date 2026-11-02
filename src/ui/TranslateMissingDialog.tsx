import { useEffect, useMemo, useRef, useState } from "react";
import { type KeyId, parseKeyId } from "../core/model";
import type { ProjectSession } from "../core/session";
import { type BatchResult, missingItems, translateMissing } from "../mt/batch";
import { nextReqId, translateText } from "../mt/translate";
import { Dialog, btnGhost, btnPrimary, inputCls } from "./Dialog";
import { activeModel, useMt } from "./mt-store";
import { useSessionVersion } from "./store";
import { useShallow } from "zustand/react/shallow";

type Phase =
  | { kind: "setup" }
  | { kind: "running"; done: number; total: number; current: KeyId | null }
  | { kind: "done"; result: BatchResult };

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
  const [phase, setPhase] = useState<Phase>({ kind: "setup" });
  const alive = useRef(true);
  const abort = useRef<AbortController | null>(null);
  const reqId = useRef<number | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abort.current?.abort();
      if (reqId.current !== null) void engine.cancel(reqId.current).catch(() => {});
    };
  }, [engine]);

  const items = useMemo(
    () => (locale ? missingItems(session, locale, ns) : []),
    [session, locale, ns, version],
  );

  const start = async () => {
    if (!model || !items.length) return;
    const ac = new AbortController();
    abort.current = ac;
    setPhase({ kind: "running", done: 0, total: items.length, current: null });
    const result = await translateMissing(
      session,
      items,
      locale,
      (source) => {
        const id = nextReqId();
        reqId.current = id;
        return translateText(engine, model, format, baseLocale, locale, source, id);
      },
      (pr) => alive.current && setPhase({ kind: "running", ...pr }),
      ac.signal,
    );
    reqId.current = null;
    abort.current = null;
    if (alive.current) setPhase({ kind: "done", result });
  };

  const cancel = () => {
    abort.current?.abort();
    if (reqId.current !== null) void engine.cancel(reqId.current).catch(() => {});
  };

  const running = phase.kind === "running";
  return (
    <Dialog title="Translate missing" onClose={running ? undefined : p.onClose}>
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
              Namespace
              <select className={inputCls} value={ns} onChange={(e) => setNs(e.target.value)}>
                <option value="all">All namespaces</option>
                {namespaces.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          )}
          <p className="text-sm text-gray-600">{items.length} missing</p>
          <div className="flex justify-end gap-2">
            <button className={btnGhost} onClick={p.onClose}>Close</button>
            <button className={btnPrimary} disabled={!items.length || !model} onClick={() => void start()}>Start</button>
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
          <div className="flex justify-end">
            <button className={btnGhost} onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}
      {phase.kind === "done" && <Summary result={phase.result} onClose={p.onClose} />}
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
      {r.failed.length > 0 && <p>{r.failed.length} failed.</p>}
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
