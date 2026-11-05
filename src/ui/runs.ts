import { create } from "zustand";
import type { KeyId } from "../core/model";
import type { ProjectSession } from "../core/session";
import type { BatchResult } from "../mt/batch";
import { type MultiProgress, type Translator, translateMissingMulti } from "../mt/translator";
import { useApp } from "./store";

/** A Translate missing run, kept per tab so it outlives its dialog and keeps going in a background tab. */
export type RunPhase =
  | { kind: "running"; label: string; locales: string[]; perLocale: MultiProgress["perLocale"]; current: KeyId | null }
  | { kind: "done"; label: string; locales: string[]; results: Record<string, BatchResult> };

export const useRuns = create<{ byTab: Record<string, RunPhase> }>(() => ({ byTab: {} }));

const live = new Map<string, { abort: AbortController }>();

function setPhase(tabId: string, phase: RunPhase | null): void {
  useRuns.setState((s) => {
    const byTab = { ...s.byTab };
    if (phase) byTab[tabId] = phase;
    else delete byTab[tabId];
    return { byTab };
  });
}

/**
 * Translates every missing cell of `locales` (in group `ns`, or "all") with `translator`. The run's
 * writes are one undo step; results are machine translations needing review.
 */
export function startRun(
  tabId: string,
  session: ProjectSession,
  locales: string[],
  ns: string,
  translator: Translator,
  instructions: (locale: string) => string = () => "",
): void {
  if (live.has(tabId) || !locales.length) return;
  const run = { abort: new AbortController() };
  live.set(tabId, run);
  const { signal } = run.abort;
  const label = translator.label;
  setPhase(tabId, { kind: "running", label, locales, perLocale: {}, current: null });
  useApp.getState().markBusy(tabId, 1);
  const group = session.beginGroup(); // the run's own writes are one undo step
  const progress = (p: MultiProgress) => {
    if (live.get(tabId) === run) setPhase(tabId, { kind: "running", label, locales, perLocale: p.perLocale, current: p.current });
  };
  const empty = (): BatchResult => ({ translated: 0, unsafe: [], failed: [], skipped: 0, cancelled: true });
  let results: Record<string, BatchResult> = Object.fromEntries(locales.map((l) => [l, empty()]));
  void translateMissingMulti(session, locales, ns, translator, progress, signal, (fn) => session.inGroup(group, fn), instructions)
    .then((r) => (results = r))
    .catch((e) => console.warn("[mt] batch translation failed", e))
    .finally(() => {
      session.endGroup(group);
      if (live.get(tabId) !== run) return; // the tab was closed: its run is already forgotten
      live.delete(tabId);
      useApp.getState().markBusy(tabId, -1);
      setPhase(tabId, { kind: "done", label, locales, results });
    });
}

/** Stops the tab's run; the summary still shows what finished. */
export function cancelRun(tabId: string): void {
  const run = live.get(tabId);
  if (!run) return;
  run.abort.abort();
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
