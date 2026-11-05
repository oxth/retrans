import { create } from "zustand";
import type { KeyId } from "../core/model";
import type { ProjectSession } from "../core/session";
import { type BatchItem, type BatchResult, translateMissing } from "../mt/batch";
import type { TranslateResult } from "../mt/translate";
import { useApp } from "./store";

/** A Translate missing run, kept per tab so it outlives its dialog and keeps going in a background tab. */
export type RunPhase =
  | { kind: "running"; locale: string; done: number; total: number; current: KeyId | null }
  | { kind: "done"; locale: string; result: BatchResult };

/**
 * Translates one source text. Call `onRequest` with a function that cancels the engine request
 * now in flight, so Cancel (or closing the tab) stops it at once.
 */
export type RunTranslate = (source: string, onRequest: (cancel: () => void) => void) => Promise<TranslateResult>;

export const useRuns = create<{ byTab: Record<string, RunPhase> }>(() => ({ byTab: {} }));

const live = new Map<string, { abort: AbortController; cancelRequest: (() => void) | null }>();

function setPhase(tabId: string, phase: RunPhase | null): void {
  useRuns.setState((s) => {
    const byTab = { ...s.byTab };
    if (phase) byTab[tabId] = phase;
    else delete byTab[tabId];
    return { byTab };
  });
}

export function startRun(tabId: string, session: ProjectSession, items: BatchItem[], locale: string, translate: RunTranslate): void {
  if (live.has(tabId) || !items.length) return;
  const run = { abort: new AbortController(), cancelRequest: null as (() => void) | null };
  live.set(tabId, run);
  const { signal } = run.abort;
  const first = items[0].id;
  setPhase(tabId, { kind: "running", locale, done: 0, total: items.length, current: first });
  useApp.getState().markBusy(tabId, 1);
  const group = session.beginGroup(); // the run's own writes are one undo step
  const one = async (source: string): Promise<TranslateResult> => {
    try {
      const r = await translate(source, (cancel) => (run.cancelRequest = cancel));
      // Cancelled while this request was in flight: never write its result.
      return signal.aborted ? { ok: false, reason: "cancelled" } : r;
    } catch (e) {
      return { ok: false, reason: "error", message: e instanceof Error ? e.message : String(e) };
    } finally {
      run.cancelRequest = null;
    }
  };
  const progress = (p: { done: number; total: number; current: KeyId | null }) => {
    if (live.get(tabId) === run) setPhase(tabId, { kind: "running", locale, ...p, current: p.current ?? (p.done === 0 ? first : null) });
  };
  let result: BatchResult = { translated: 0, unsafe: [], failed: [], skipped: 0, cancelled: true };
  void translateMissing(session, items, locale, one, progress, signal, (fn) => session.inGroup(group, fn))
    .then((r) => (result = r))
    .catch((e) => console.warn("[mt] batch translation failed", e))
    .finally(() => {
      session.endGroup(group);
      if (live.get(tabId) !== run) return; // the tab was closed: its run is already forgotten
      live.delete(tabId);
      useApp.getState().markBusy(tabId, -1);
      setPhase(tabId, { kind: "done", locale, result });
    });
}

/** Stops the tab's run; the summary still shows what finished. */
export function cancelRun(tabId: string): void {
  const run = live.get(tabId);
  if (!run) return;
  run.abort.abort();
  run.cancelRequest?.();
}

/** Forgets a finished run's summary. */
export function clearRun(tabId: string): void {
  if (!live.has(tabId)) setPhase(tabId, null);
}

// A closed tab's run is cancelled and forgotten: nothing may write into its session afterwards.
useApp.subscribe((s) => {
  for (const tabId of live.keys()) {
    if (s.tabs.some((t) => t.id === tabId) || !isTabId(tabId)) continue;
    cancelRun(tabId);
    live.delete(tabId);
    setPhase(tabId, null);
  }
  for (const tabId of Object.keys(useRuns.getState().byTab)) {
    if (isTabId(tabId) && !s.tabs.some((t) => t.id === tabId)) setPhase(tabId, null);
  }
});

/** Runs on a session with no tab (tests, legacy callers) use this key and are never auto-cancelled. */
export const UNTABBED = "untabbed";
const isTabId = (id: string) => id !== UNTABBED;

/** Cancels and forgets every run (tests). */
export function resetRuns(): void {
  for (const tabId of [...live.keys()]) cancelRun(tabId);
  live.clear();
  useRuns.setState({ byTab: {} });
}
