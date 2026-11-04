import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { appDataDir } from "@tauri-apps/api/path";
import type { DetectResult, ProjectOptions } from "../formats/adapter";
import { ProjectSession } from "../core/session";
import type { Conflict } from "../core/merge";
import { type Journal, journalPath, readJournal } from "../core/recovery";
import { parseState, STATE_PATH } from "../core/state-file";
import { isRelevantChange, isSourceChange } from "../core/watch-filter";
import { resolveSyncConflict, syncFromSource, type SyncResult } from "../workspace/sync";
import { BASELINE_PATH, WORKSPACE_META_PATH } from "../workspace/meta";
import { type Fs, FsError, joinPath } from "../platform/fs";
import { tauriFs } from "../platform/tauri-fs";
import { addRecent } from "../platform/prefs";
import { watchDir } from "../platform/watch";
import { defaultTabUi, type TabUi } from "./tab-ui";
import {
  cancelJournal, dropJournal, newRuntime, runDeferredSync, scheduleJournal, teardown, type TabRuntime,
} from "./tab-runtime";

export interface PendingRecovery { journal: Journal; path: string }

/**
 * A conflict shown in the Resolve conflicts dialog. `origin: "source"`: changed both in the
 * workspace and in the TypeScript source (from syncFromSource; resolved with resolveSyncConflict).
 * Otherwise: changed both here and in the workspace files on disk (session.resolveConflict).
 */
export type UiConflict = Conflict & { origin?: "source" };

export const SOURCE_MISSING_MESSAGE = "Source files not found — showing the saved workspace.";
export const SOURCE_INVALID_MESSAGE = "The workspace's source folder setting is invalid — showing the saved workspace.";

/** Everything about a tab that isn't on screen; the active tab's live copy is the flat AppState fields. */
export interface TabSnapshot {
  session: ProjectSession;
  detected: DetectResult;
  version: number;
  conflicts: UiConflict[];
  sourceMissing: boolean;
  recovery: PendingRecovery | null;
  error: string | null;
  ui: TabUi;
}

/** One open project. `snap` is null for the active tab (its state is in the flat fields). */
export interface Tab {
  id: string;
  root: string;
  name: string;
  /** Background work in flight (Translate missing runs, source syncs). */
  busy: number;
  snap: TabSnapshot | null;
}

/** A project folder path without trailing slashes: two spellings of one folder are one tab. */
export const normRoot = (root: string) => root.replace(/[\\/]+$/, "") || root;

export interface AppState {
  fs: Fs;
  /** Open projects, in tab order. */
  tabs: Tab[];
  /** The tab on screen; null shows the start screen (other tabs may still be open). */
  activeId: string | null;
  /** The active tab's page, filters and hidden languages. */
  ui: TabUi;
  /** App-level message, e.g. tabs that couldn't be reopened. */
  notice: string | null;
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
  switchTab(id: string): void;
  /** The "+" button: keeps every tab and shows the start screen. */
  showStart(): void;
  /** Activates the tab, then closes it like Close project (asking about unsaved changes). */
  closeTab(id: string): Promise<void>;
  /** Closes every tab without asking (quit after the prompt, tests). */
  closeAllTabs(): Promise<void>;
  setUi(p: Partial<TabUi>): void;
  /** The tab holding `session`, or null when it is closed (or was never opened in a tab). */
  tabIdOf(session: ProjectSession): string | null;
  /** Updates a tab: the flat fields when it's active, else its snapshot. */
  patchTab(id: string, p: Partial<TabSnapshot> | ((cur: TabSnapshot) => Partial<TabSnapshot>)): void;
  markBusy(id: string, delta: 1 | -1): void;
  /**
   * Opens `root` in a new tab, or switches to the tab already showing it. `prebuilt`: a session already made in memory (an imported TypeScript project,
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
  /**
   * Runs syncFromSource on `session` and, while it is still the open one, shows the outcome:
   * its source conflicts replace the previous ones; a missing source sets `sourceMissing`.
   * Rejects when the sync fails.
   */
  syncSource(session: ProjectSession): Promise<SyncResult>;
}

const runtimes = new Map<string, TabRuntime>();
/** Opens in flight, by root, so opening a folder twice at once makes one tab. */
const opening = new Map<string, Promise<void>>();

function activeRuntime(): TabRuntime | undefined {
  const id = useApp.getState().activeId;
  return id ? runtimes.get(id) : undefined;
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

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Flat = Pick<AppState, "session" | "detected" | "version" | "conflicts" | "sourceMissing" | "recovery" | "error" | "ui">;
const emptyFlat = (): Flat => ({
  session: null, detected: null, version: 0, conflicts: [], sourceMissing: false, recovery: null, error: null, ui: defaultTabUi(),
});
/** The active tab's live state as a snapshot. */
const snapOf = (s: AppState): TabSnapshot => ({
  session: s.session!, detected: s.detected!, version: s.version, conflicts: s.conflicts,
  sourceMissing: s.sourceMissing, recovery: s.recovery, error: s.error, ui: s.ui,
});
/** The tab list with the active tab's live state stored in its snapshot. */
const parked = (s: AppState): Tab[] =>
  s.tabs.map((t) => (t.id === s.activeId && s.session ? { ...t, snap: snapOf(s) } : t));

export const useApp = create<AppState>((set, get) => {
  /** Updates whichever tab holds `session`; also the legacy case of a session set without a tab. */
  const patchSession = (session: ProjectSession, p: Partial<TabSnapshot> | ((cur: TabSnapshot) => Partial<TabSnapshot>)) => {
    const id = get().tabIdOf(session);
    if (id) get().patchTab(id, p);
    else if (get().session === session) set((s) => (typeof p === "function" ? p(snapOf(s)) : p));
  };

  /** Removes a tab and stops its machinery; the right (else left) neighbour becomes active. */
  const removeTab = async (id: string) => {
    const rt = runtimes.get(id);
    runtimes.delete(id);
    set((s) => {
      const i = s.tabs.findIndex((t) => t.id === id);
      if (i < 0) return {};
      const rest = s.tabs.filter((t) => t.id !== id);
      if (id !== s.activeId) return { tabs: rest };
      const next = s.tabs[i + 1] ?? s.tabs[i - 1];
      if (!next?.snap) return { tabs: rest, activeId: null, ...emptyFlat(), closePrompt: null };
      return {
        tabs: rest.map((t) => (t.id === next.id ? { ...t, snap: null } : t)),
        activeId: next.id, ...next.snap, closePrompt: null,
      };
    });
    if (rt) await teardown(rt);
  };

  const openTab = async (root: string, d: DetectResult, opts: ProjectOptions, prebuilt?: ProjectSession) => {
    const { fs } = get();
    const session = prebuilt ?? (await openSession(fs, root, d, opts));
    if (!prebuilt && d.baseLocale === null) {
      const { state: st } = parseState(await readState(fs, root));
      if (st.project.baseLocale !== opts.baseLocale) {
        // Ask once (spec §7.1): remember the user's pick.
        await session.pinBaseLocale(opts.baseLocale).catch((e) => console.warn("could not record base language", e));
      }
    }
    const name = root.split("/").filter(Boolean).pop() ?? root;
    try {
      await addRecent({ root, name, format: d.format });
    } catch {
      /* best effort */
    }
    const rt = newRuntime();
    let recovery: PendingRecovery | null = null;
    try {
      const path = journalPath(await appDataDir(), root);
      rt.journalFile = path;
      const journal = await readJournal(fs, path);
      if (journal) recovery = { journal, path };
    } catch {
      /* best effort */
    }

    const id = crypto.randomUUID();
    runtimes.set(id, rt);
    const alive = () => runtimes.get(id) === rt;
    rt.unsubscribe = session.subscribe(() => {
      get().patchTab(id, (cur) => ({ version: cur.version + 1 }));
      if (session.isDirty()) scheduleJournal(rt, session, fs, () => get().tabIdOf(session) !== null);
    });
    set((s) => ({
      tabs: [...parked(s), { id, root, name, busy: 0, snap: null }],
      activeId: id,
      ...emptyFlat(),
      session, detected: d, recovery, closePrompt: null,
    }));

    const sourceDir = session.workspace?.source?.localesDir;
    const sync = () => {
      get().syncSource(session).catch((e) => patchSession(session, { error: `Sync from source failed: ${msg(e)}` }));
    };
    if (sourceDir !== undefined) {
      if (recovery) rt.deferredSync = sync; // runs after Restore / Discard
      else sync();
    }

    try {
      const scope = {
        root, format: d.format, localesPath: session.opts.localesPath,
        extraPaths: d.workspace ? [WORKSPACE_META_PATH, BASELINE_PATH] : undefined,
      };
      const stop = await watchDir(root, (paths) => {
        if (!alive()) return;
        // While a recovery is pending the deferred sync covers source changes too.
        if (sourceDir !== undefined && isSourceChange(paths, root, sourceDir) && !rt.deferredSync) sync();
        if (!isRelevantChange(paths, scope)) return;
        session.reloadFromDisk().then(
          (c) => {
            if (alive()) get().patchTab(id, (cur) => ({ conflicts: withFileConflicts(session, cur.conflicts, c) }));
          },
          (e) => {
            if (alive()) get().patchTab(id, { error: `Reload failed: ${msg(e)}` });
          },
        );
      });
      if (!alive()) {
        await stop().catch(() => {});
        return;
      }
      rt.stopWatch = stop;
    } catch (e) {
      if (alive()) get().patchTab(id, { error: `File watching unavailable: ${msg(e)}` });
    }
  };

  return {
  fs: tauriFs,
  tabs: [],
  activeId: null,
  notice: null,
  ...emptyFlat(),
  closePrompt: null,

  switchTab(id) {
    const s = get();
    if (id === s.activeId) return;
    const target = s.tabs.find((t) => t.id === id);
    if (!target?.snap) return;
    const tabs = parked(s).map((t) => (t.id === id ? { ...t, snap: null } : t));
    set({ tabs, activeId: id, ...target.snap });
  },

  showStart() {
    const s = get();
    if (s.activeId === null) return;
    set({ tabs: parked(s), activeId: null, ...emptyFlat() });
  },

  async closeTab(id) {
    get().switchTab(id);
    if (get().activeId === id) await get().requestClose("project");
  },

  async closeAllTabs() {
    const ids = get().tabs.map((t) => t.id);
    const rts = ids.map((id) => runtimes.get(id)).filter((r): r is TabRuntime => !!r);
    for (const id of ids) runtimes.delete(id);
    set({ tabs: [], activeId: null, ...emptyFlat(), closePrompt: null, notice: null });
    for (const rt of rts) await teardown(rt);
  },

  setUi(p) {
    set((s) => ({ ui: { ...s.ui, ...p } }));
  },

  tabIdOf(session) {
    const s = get();
    if (s.session === session) return s.activeId;
    return s.tabs.find((t) => t.snap?.session === session)?.id ?? null;
  },

  patchTab(id, p) {
    set((s) => {
      if (id === s.activeId) return typeof p === "function" ? p(snapOf(s)) : p;
      return {
        tabs: s.tabs.map((t) =>
          t.id === id && t.snap ? { ...t, snap: { ...t.snap, ...(typeof p === "function" ? p(t.snap) : p) } } : t,
        ),
      };
    });
  },

  markBusy(id, delta) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, busy: Math.max(0, t.busy + delta) } : t)) }));
  },

  async openProject(root, d, opts, prebuilt) {
    const key = normRoot(root);
    const switchTo = () => {
      const t = get().tabs.find((x) => x.root === key);
      if (t) get().switchTab(t.id);
      return !!t;
    };
    if (switchTo()) return;
    const inflight = opening.get(key);
    if (inflight) {
      await inflight;
      switchTo();
      return;
    }
    const p = openTab(key, d, opts, prebuilt).finally(() => opening.delete(key));
    opening.set(key, p);
    await p;
  },

  async closeProject() {
    const id = get().activeId;
    if (id) await removeTab(id);
    else set({ ...emptyFlat(), closePrompt: null }); // a session set without a tab
  },

  async restoreRecovery() {
    const { session, recovery, fs } = get();
    if (!session || !recovery) return;
    const rt = activeRuntime();
    try {
      const c = session.applyJournal(recovery.journal);
      set((s) => ({ recovery: null, conflicts: withFileConflicts(session, s.conflicts, c) }));
    } catch (e) {
      set({ recovery: null, error: `Could not restore unsaved changes: ${msg(e)}` });
      await dropJournal(rt, fs, recovery.path).catch(() => {});
    }
    // After the journal: an edit it restored that the source also changed is a source conflict.
    if (get().session === session) runDeferredSync(rt);
  },

  async discardRecovery() {
    const { fs, recovery } = get();
    const rt = activeRuntime();
    try {
      if (recovery) await dropJournal(rt, fs, recovery.path);
    } finally {
      set({ recovery: null });
      runDeferredSync(rt);
    }
  },

  async save() {
    const { session, fs } = get();
    if (!session) return false;
    if (!session.isDirty()) return true;
    if (get().conflicts.length > 0) {
      set({ error: "Resolve conflicts before saving." });
      return false;
    }
    // The user may switch tabs while saving: results go to this session's tab.
    const rt = activeRuntime();
    const current = () => get().session === session || get().tabIdOf(session) !== null;
    try {
      let r = await session.save();
      if (r.stale.length) {
        const c = await session.reloadFromDisk();
        patchSession(session, (cur) => ({ conflicts: withFileConflicts(session, cur.conflicts, c) }));
        if (c.length) return false;
        r = await session.save();
        if (r.stale.length) {
          patchSession(session, { error: "Files changed on disk again while saving. Try saving again." });
          return false;
        }
      }
      if (!current()) return false;
      if (session.isDirty()) {
        if (session.stateMalformed) {
          patchSession(session, {
            error: `Review statuses weren't saved: ${STATE_PATH} can't be parsed. Fix it (e.g. resolve merge markers) and save again.`,
          });
        }
        return false;
      }
      if (rt?.journalFile) await dropJournal(rt, fs, rt.journalFile).catch((e) => console.warn("journal clear failed", e));
      else cancelJournal(rt);
      return true;
    } catch (e) {
      patchSession(session, { error: `Save failed: ${msg(e)}` });
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
      const rt = activeRuntime();
      if (rt?.journalFile) await dropJournal(rt, fs, rt.journalFile).catch((e) => console.warn("journal clear failed", e));
      else cancelJournal(rt);
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

  async syncSource(session) {
    const busyId = get().tabIdOf(session);
    if (busyId) get().markBusy(busyId, 1);
    let r: SyncResult;
    try {
      r = await syncFromSource(session);
    } finally {
      if (busyId) get().markBusy(busyId, -1);
    }
    if (!r.sourceAvailable) {
      patchSession(session, { sourceMissing: true });
      return r;
    }
    // Each sync reports every open source conflict: they replace the previous ones.
    const fresh: UiConflict[] = r.conflicts.map((c) => ({ ...c, origin: "source" }));
    patchSession(session, (cur) => ({
      sourceMissing: false,
      conflicts: [...cur.conflicts.filter((c) => c.origin !== "source"), ...fresh],
    }));
    return r;
  },

  resolveAllConflicts(pick) {
    const { session, conflicts } = get();
    if (session) session.batch(() => { for (const c of conflicts) resolveOne(session, c, pick); });
    set({ conflicts: [] });
  },
  };
});

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
