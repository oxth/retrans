import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { appDataDir } from "@tauri-apps/api/path";
import type { DetectResult, ProjectOptions } from "../formats/adapter";
import { ProjectSession } from "../core/session";
import type { Conflict } from "../core/merge";
import { clearJournal, type Journal, journalPath, readJournal, writeJournal } from "../core/recovery";
import { parseState, STATE_PATH } from "../core/state-file";
import { isRelevantChange } from "../core/watch-filter";
import { type Fs, FsError, joinPath } from "../platform/fs";
import { tauriFs } from "../platform/tauri-fs";
import { addRecent } from "../platform/prefs";
import { watchDir } from "../platform/watch";

export interface PendingRecovery { journal: Journal; path: string }

export interface AppState {
  fs: Fs;
  session: ProjectSession | null;
  /** What detection found for the open project (before state.json overrides). */
  detected: DetectResult | null;
  version: number;
  conflicts: Conflict[];
  recovery: PendingRecovery | null;
  error: string | null;
  /** Set while the Save / Discard / Cancel prompt is up; `then` is what happens afterwards. */
  closePrompt: { then: "project" | "window" } | null;
  openProject(root: string, d: DetectResult, opts: ProjectOptions): Promise<void>;
  closeProject(): Promise<void>;
  restoreRecovery(): Promise<void>;
  discardRecovery(): Promise<void>;
  /**
   * Saves (reloading and merging if files changed on disk). True when the session ended up clean.
   * Refuses (false, with an error) while conflicts are unresolved.
   */
  save(): Promise<boolean>;
  requestClose(then: "project" | "window"): Promise<void>;
  answerClosePrompt(choice: "save" | "discard" | "cancel"): Promise<void>;
  resolveConflict(c: Conflict, pick: "mine" | "theirs"): void;
  resolveAllConflicts(pick: "mine" | "theirs"): void;
}

const JOURNAL_DELAY_MS = 1000;
let journalTimer: ReturnType<typeof setTimeout> | null = null;
let journalFile: string | null = null;
/** The journal write in flight, if any; clearing waits for it so it can't land afterwards. */
let journalWrite: Promise<void> | null = null;

function cancelJournal(): void {
  if (journalTimer) clearTimeout(journalTimer);
  journalTimer = null;
}

/** Cancels a scheduled write, waits for one in flight, then removes the journal. */
async function dropJournal(fs: Fs, path: string): Promise<void> {
  cancelJournal();
  while (journalWrite) await journalWrite;
  await clearJournal(fs, path);
}

/** Debounced, best-effort: errors go to the console only. */
function scheduleJournal(session: ProjectSession, fs: Fs): void {
  cancelJournal();
  journalTimer = setTimeout(() => {
    journalTimer = null;
    const path = journalFile;
    if (!path || useApp.getState().session !== session || !session.isDirty()) return;
    const w: Promise<void> = writeJournal(fs, path, session.toJournal())
      .catch((e) => console.warn("journal write failed", e))
      .finally(() => {
        if (journalWrite === w) journalWrite = null;
      });
    journalWrite = w;
  }, JOURNAL_DELAY_MS);
}

let stopWatch: (() => Promise<void>) | null = null;
let unsubscribe: (() => void) | null = null;

async function teardown(): Promise<void> {
  cancelJournal();
  journalFile = null;
  unsubscribe?.();
  unsubscribe = null;
  const stop = stopWatch;
  stopWatch = null;
  if (stop) await stop().catch(() => {});
}

async function readState(fs: Fs, root: string): Promise<string | null> {
  try {
    return await fs.readText(joinPath(root, STATE_PATH));
  } catch (err) {
    if (err instanceof FsError && err.code === "NotFound") return null;
    throw err;
  }
}

/** The base language persisted for a project whose detection can't tell (null if none/invalid). */
export async function savedBaseLocale(fs: Fs, root: string, d: DetectResult): Promise<string | null> {
  let text: string | null;
  try {
    text = await readState(fs, root);
  } catch {
    return null;
  }
  const b = parseState(text).state.project.baseLocale;
  return b && d.locales.includes(b) ? b : null;
}

let openGen = 0;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useApp = create<AppState>((set, get) => ({
  fs: tauriFs,
  session: null,
  detected: null,
  version: 0,
  conflicts: [],
  recovery: null,
  error: null,
  closePrompt: null,

  async openProject(root, d, opts) {
    const { fs } = get();
    const my = ++openGen;
    const stale = () => my !== openGen;
    await teardown();
    // .paratrans/state.json may override the locales path (Settings). The base language comes from
    // `opts` (detected, or picked/persisted when detection returned null) and is never overridden.
    const { state: st } = parseState(await readState(fs, root));
    const effective: ProjectOptions = {
      baseLocale: opts.baseLocale,
      localesPath: st.project.localesPath ?? opts.localesPath,
    };
    const session = await ProjectSession.open(fs, root, d, effective);
    if (stale()) return;
    if (d.baseLocale === null && st.project.baseLocale !== opts.baseLocale) {
      // Ask once (spec §7.1): remember the user's pick.
      await session.pinBaseLocale(opts.baseLocale).catch((e) => console.warn("could not record base language", e));
      if (stale()) return;
    }
    const name = root.split("/").filter(Boolean).pop() ?? root;
    try {
      await addRecent({ root, name, format: d.format });
    } catch {
      /* best effort */
    }
    let recovery: PendingRecovery | null = null;
    try {
      const path = journalPath(await appDataDir(), root);
      journalFile = path;
      const journal = await readJournal(fs, path);
      if (journal) recovery = { journal, path };
    } catch {
      /* best effort */
    }
    if (stale()) return;

    unsubscribe = session.subscribe(() => {
      set((s) => ({ version: s.version + 1 }));
      if (session.isDirty()) scheduleJournal(session, fs);
    });
    set({ session, detected: d, conflicts: [], recovery, error: null, version: 0, closePrompt: null });

    try {
      const scope = { root, format: d.format, localesPath: session.opts.localesPath };
      const stop = await watchDir(root, (paths) => {
        if (get().session !== session || !isRelevantChange(paths, scope)) return;
        session.reloadFromDisk().then(
          (c) => {
            if (get().session === session) set((s) => ({ conflicts: session.refreshConflicts([...s.conflicts, ...c]) }));
          },
          (e) => {
            if (get().session === session) set({ error: `Reload failed: ${msg(e)}` });
          },
        );
      });
      if (stale()) {
        await stop().catch(() => {});
        return;
      }
      stopWatch = stop;
    } catch (e) {
      if (!stale()) set({ error: `File watching unavailable: ${msg(e)}` });
    }
  },

  async closeProject() {
    openGen++;
    await teardown();
    set({ session: null, detected: null, conflicts: [], recovery: null, error: null, version: 0, closePrompt: null });
  },

  async restoreRecovery() {
    const { session, recovery, fs } = get();
    if (!session || !recovery) return;
    try {
      const c = session.applyJournal(recovery.journal);
      set((s) => ({ recovery: null, conflicts: session.refreshConflicts([...s.conflicts, ...c]) }));
    } catch (e) {
      set({ recovery: null, error: `Could not restore unsaved changes: ${msg(e)}` });
      await dropJournal(fs, recovery.path).catch(() => {});
    }
  },

  async discardRecovery() {
    const { fs, recovery } = get();
    if (recovery) await dropJournal(fs, recovery.path);
    set({ recovery: null });
  },

  async save() {
    const { session, fs } = get();
    if (!session) return false;
    if (!session.isDirty()) return true;
    if (get().conflicts.length > 0) {
      set({ error: "Resolve conflicts before saving." });
      return false;
    }
    const current = () => get().session === session;
    try {
      let r = await session.save();
      if (r.stale.length) {
        const c = await session.reloadFromDisk();
        if (current()) set((s) => ({ conflicts: session.refreshConflicts([...s.conflicts, ...c]) }));
        if (c.length) return false;
        r = await session.save();
        if (r.stale.length) {
          if (current()) set({ error: "Files changed on disk again while saving. Try saving again." });
          return false;
        }
      }
      if (!current()) return false;
      if (session.isDirty()) {
        if (session.stateMalformed) {
          set({ error: `Review statuses weren't saved: ${STATE_PATH} can't be parsed. Fix it (e.g. resolve merge markers) and save again.` });
        }
        return false;
      }
      if (journalFile) await dropJournal(fs, journalFile).catch((e) => console.warn("journal clear failed", e));
      else cancelJournal();
      return true;
    } catch (e) {
      if (current()) set({ error: `Save failed: ${msg(e)}` });
      return false;
    }
  },

  async requestClose(then) {
    const { session } = get();
    if (session?.isDirty()) {
      set({ closePrompt: { then } });
      return;
    }
    await finishClose(then, get().closeProject);
  },

  async answerClosePrompt(choice) {
    const prompt = get().closePrompt;
    if (!prompt) return;
    set({ closePrompt: null });
    if (choice === "cancel") return;
    if (choice === "save") {
      if (!(await get().save())) return;
    } else {
      const { fs } = get();
      if (journalFile) await dropJournal(fs, journalFile).catch((e) => console.warn("journal clear failed", e));
      else cancelJournal();
    }
    await finishClose(prompt.then, get().closeProject);
  },

  resolveConflict(c, pick) {
    get().session?.resolveConflict(c, pick);
    set((s) => ({ conflicts: s.conflicts.filter((x) => x.id !== c.id || x.locale !== c.locale) }));
  },

  resolveAllConflicts(pick) {
    const { session, conflicts } = get();
    for (const c of conflicts) session?.resolveConflict(c, pick);
    set({ conflicts: [] });
  },
}));

async function finishClose(then: "project" | "window", closeProject: () => Promise<void>): Promise<void> {
  if (then === "project") await closeProject();
  else await getCurrentWindow().destroy();
}

/** Re-renders on every session change; returns the change counter. */
export function useSessionVersion(): number {
  return useApp((s) => s.version);
}
