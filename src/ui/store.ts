import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { appDataDir } from "@tauri-apps/api/path";
import type { DetectResult, ProjectOptions } from "../formats/adapter";
import { ProjectSession } from "../core/session";
import type { Conflict } from "../core/merge";
import { clearJournal, type Journal, journalPath, readJournal, writeJournal } from "../core/recovery";
import { parseState, STATE_PATH } from "../core/state-file";
import { isRelevantChange, isSourceChange } from "../core/watch-filter";
import { resolveSyncConflict, syncFromSource } from "../workspace/sync";
import { BASELINE_PATH, WORKSPACE_META_PATH } from "../workspace/meta";
import { type Fs, FsError, joinPath } from "../platform/fs";
import { tauriFs } from "../platform/tauri-fs";
import { addRecent } from "../platform/prefs";
import { watchDir } from "../platform/watch";

export interface PendingRecovery { journal: Journal; path: string }

/**
 * A conflict shown in the Resolve conflicts dialog. `origin: "source"`: changed both in the
 * workspace and in the TypeScript source (from syncFromSource; resolved with resolveSyncConflict).
 * Otherwise: changed both here and in the workspace files on disk (session.resolveConflict).
 */
export type UiConflict = Conflict & { origin?: "source" };

export const SOURCE_MISSING_MESSAGE = "Source files not found — showing the saved workspace.";

export interface AppState {
  fs: Fs;
  session: ProjectSession | null;
  /** What detection found for the open project (before state.json overrides). */
  detected: DetectResult | null;
  version: number;
  conflicts: UiConflict[];
  /** Workspace imported from TypeScript whose source folder is gone (or has no locale modules). */
  sourceMissing: boolean;
  recovery: PendingRecovery | null;
  error: string | null;
  /**
   * Set while the Save / Discard / Cancel prompt is up; `then` is what happens afterwards
   * ("proceed": the caller of confirmUnsaved goes on, e.g. installing an update).
   */
  closePrompt: { then: "project" | "window" } | { then: "proceed"; resolve: (go: boolean) => void } | null;
  /**
   * Opens `root`. `prebuilt`: a session already made in memory (an imported TypeScript project,
   * see ProjectSession.fromImport) instead of loading one from disk. A workspace with a source is
   * synced from it right after opening, and again whenever its source folder changes.
   */
  openProject(root: string, d: DetectResult, opts: ProjectOptions, prebuilt?: ProjectSession): Promise<void>;
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
  /** True when there's nothing unsaved, or after the user saved or discarded; false on Cancel. */
  confirmUnsaved(): Promise<boolean>;
  resolveConflict(c: UiConflict, pick: "mine" | "theirs"): void;
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

/** File conflicts brought up to date with `more` added; source conflicts are kept as they are. */
function withFileConflicts(session: ProjectSession, list: UiConflict[], more: Conflict[]): UiConflict[] {
  const source = list.filter((c) => c.origin === "source");
  return [...session.refreshConflicts([...list.filter((c) => c.origin !== "source"), ...more]), ...source];
}

let openGen = 0;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useApp = create<AppState>((set, get) => ({
  fs: tauriFs,
  session: null,
  detected: null,
  version: 0,
  conflicts: [],
  sourceMissing: false,
  recovery: null,
  error: null,
  closePrompt: null,

  async openProject(root, d, opts, prebuilt) {
    const { fs } = get();
    const my = ++openGen;
    const stale = () => my !== openGen;
    await teardown();
    const session = prebuilt ?? (await openSession(fs, root, d, opts));
    if (stale()) return;
    if (!prebuilt && d.baseLocale === null) {
      const { state: st } = parseState(await readState(fs, root));
      if (st.project.baseLocale !== opts.baseLocale) {
        // Ask once (spec §7.1): remember the user's pick.
        await session.pinBaseLocale(opts.baseLocale).catch((e) => console.warn("could not record base language", e));
        if (stale()) return;
      }
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
    set({ session, detected: d, conflicts: [], sourceMissing: false, recovery, error: null, version: 0, closePrompt: null });

    const sourceDir = session.workspace?.source?.localesDir;
    const sync = () => {
      syncFromSource(session).then(
        (r) => {
          if (get().session !== session) return;
          if (!r.sourceAvailable) return set({ sourceMissing: true });
          // Each sync reports every open source conflict: they replace the previous ones.
          const fresh: UiConflict[] = r.conflicts.map((c) => ({ ...c, origin: "source" }));
          set((s) => ({ sourceMissing: false, conflicts: [...s.conflicts.filter((c) => c.origin !== "source"), ...fresh] }));
        },
        (e) => {
          if (get().session === session) set({ error: `Sync from source failed: ${msg(e)}` });
        },
      );
    };
    if (sourceDir !== undefined) sync();

    try {
      const scope = {
        root, format: d.format, localesPath: session.opts.localesPath,
        extraPaths: d.workspace ? [WORKSPACE_META_PATH, BASELINE_PATH] : undefined,
      };
      const stop = await watchDir(root, (paths) => {
        if (get().session !== session) return;
        if (sourceDir !== undefined && isSourceChange(paths, root, sourceDir)) sync();
        if (!isRelevantChange(paths, scope)) return;
        session.reloadFromDisk().then(
          (c) => {
            if (get().session === session) set((s) => ({ conflicts: withFileConflicts(session, s.conflicts, c) }));
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
    set({ session: null, detected: null, conflicts: [], sourceMissing: false, recovery: null, error: null, version: 0, closePrompt: null });
  },

  async restoreRecovery() {
    const { session, recovery, fs } = get();
    if (!session || !recovery) return;
    try {
      const c = session.applyJournal(recovery.journal);
      set((s) => ({ recovery: null, conflicts: withFileConflicts(session, s.conflicts, c) }));
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
        if (current()) set((s) => ({ conflicts: withFileConflicts(session, s.conflicts, c) }));
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
    const proceed = prompt.then === "proceed" ? prompt.resolve : null;
    if (choice === "cancel") return proceed?.(false);
    if (choice === "save") {
      if (!(await get().save())) return proceed?.(false);
    } else {
      const { fs } = get();
      if (journalFile) await dropJournal(fs, journalFile).catch((e) => console.warn("journal clear failed", e));
      else cancelJournal();
    }
    if (proceed) proceed(true);
    else await finishClose(prompt.then as "project" | "window", get().closeProject);
  },

  confirmUnsaved() {
    if (!get().session?.isDirty()) return Promise.resolve(true);
    const prev = get().closePrompt;
    if (prev?.then === "proceed") prev.resolve(false); // a newer request replaces an open one
    return new Promise<boolean>((resolve) => set({ closePrompt: { then: "proceed", resolve } }));
  },

  resolveConflict(c, pick) {
    const { session } = get();
    if (session) resolveOne(session, c, pick);
    set((s) => ({ conflicts: s.conflicts.filter((x) => x.id !== c.id || x.locale !== c.locale || x.origin !== c.origin) }));
  },

  resolveAllConflicts(pick) {
    const { session, conflicts } = get();
    if (session) session.batch(() => { for (const c of conflicts) resolveOne(session, c, pick); });
    set({ conflicts: [] });
  },
}));

function resolveOne(session: ProjectSession, c: UiConflict, pick: "mine" | "theirs"): void {
  const { origin, ...conflict } = c;
  if (origin === "source") resolveSyncConflict(session, conflict, pick);
  else session.resolveConflict(conflict, pick);
}

/**
 * Loads a project from disk. .retrans/state.json may override the locales path (Settings). The
 * base language comes from `opts` (detected, or picked/persisted when detection returned null)
 * and is never overridden.
 */
async function openSession(fs: Fs, root: string, d: DetectResult, opts: ProjectOptions): Promise<ProjectSession> {
  const { state: st } = parseState(await readState(fs, root));
  const effective: ProjectOptions = {
    baseLocale: opts.baseLocale,
    // A workspace's files always live in .retrans/workspace.
    localesPath: d.workspace ? d.localesPath : (st.project.localesPath ?? opts.localesPath),
  };
  return ProjectSession.open(fs, root, d, effective);
}

async function finishClose(then: "project" | "window", closeProject: () => Promise<void>): Promise<void> {
  if (then === "project") await closeProject();
  else await getCurrentWindow().destroy();
}

/** Re-renders on every session change; returns the change counter. */
export function useSessionVersion(): number {
  return useApp((s) => s.version);
}
