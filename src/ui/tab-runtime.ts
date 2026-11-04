import type { ProjectSession } from "../core/session";
import { clearJournal, writeJournal } from "../core/recovery";
import type { Fs } from "../platform/fs";

const JOURNAL_DELAY_MS = 1000;

/** A tab's background machinery: journal writes, file watching, source sync. */
export interface TabRuntime {
  journalTimer: ReturnType<typeof setTimeout> | null;
  journalFile: string | null;
  /** The journal write in flight, if any; clearing waits for it so it can't land afterwards. */
  journalWrite: Promise<void> | null;
  stopWatch: (() => Promise<void>) | null;
  unsubscribe: (() => void) | null;
  /**
   * The sync from source held back while a recovery journal waits for Restore / Discard: syncing
   * first would merge the source against values the journal is about to replace (and mark the
   * source as merged), so a journaled edit could silently overwrite a source change.
   */
  deferredSync: (() => void) | null;
}

export function cancelJournal(rt: TabRuntime | undefined): void {
  if (rt?.journalTimer) clearTimeout(rt.journalTimer);
  if (rt) rt.journalTimer = null;
}

/** Cancels a scheduled write, waits for one in flight, then removes the journal. */
export async function dropJournal(rt: TabRuntime | undefined, fs: Fs, path: string): Promise<void> {
  cancelJournal(rt);
  while (rt?.journalWrite) await rt.journalWrite;
  await clearJournal(fs, path);
}

/** Debounced, best-effort: errors go to the console only. */
export function scheduleJournal(rt: TabRuntime, session: ProjectSession, fs: Fs, isOpen: () => boolean): void {
  cancelJournal(rt);
  rt.journalTimer = setTimeout(() => {
    rt.journalTimer = null;
    const path = rt.journalFile;
    if (!path || !isOpen() || !session.isDirty()) return;
    const w: Promise<void> = writeJournal(fs, path, session.toJournal())
      .catch((e) => console.warn("journal write failed", e))
      .finally(() => {
        if (rt.journalWrite === w) rt.journalWrite = null;
      });
    rt.journalWrite = w;
  }, JOURNAL_DELAY_MS);
}

export function runDeferredSync(rt: TabRuntime | undefined): void {
  const run = rt?.deferredSync;
  if (rt) rt.deferredSync = null;
  run?.();
}

export async function teardown(rt: TabRuntime): Promise<void> {
  rt.deferredSync = null;
  cancelJournal(rt);
  rt.journalFile = null;
  rt.unsubscribe?.();
  rt.unsubscribe = null;
  const stop = rt.stopWatch;
  rt.stopWatch = null;
  if (stop) await stop().catch(() => {});
}

export const newRuntime = (): TabRuntime => ({
  journalTimer: null, journalFile: null, journalWrite: null, stopWatch: null, unsubscribe: null, deferredSync: null,
});
