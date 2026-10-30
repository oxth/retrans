import { create } from "zustand";
import { appDataDir } from "@tauri-apps/api/path";
import type { DetectResult, ProjectOptions } from "../formats/adapter";
import { ProjectSession } from "../core/session";
import type { Conflict } from "../core/merge";
import { clearJournal, type Journal, journalPath, readJournal } from "../core/recovery";
import { parseState, STATE_PATH } from "../core/state-file";
import { type Fs, FsError, joinPath } from "../platform/fs";
import { tauriFs } from "../platform/tauri-fs";
import { addRecent } from "../platform/prefs";
import { watchDir } from "../platform/watch";

export interface PendingRecovery { journal: Journal; path: string }

export interface AppState {
  fs: Fs;
  session: ProjectSession | null;
  version: number;
  conflicts: Conflict[];
  recovery: PendingRecovery | null;
  error: string | null;
  openProject(root: string, d: DetectResult, opts: ProjectOptions): Promise<void>;
  closeProject(): Promise<void>;
  restoreRecovery(): Promise<void>;
  discardRecovery(): Promise<void>;
}

let stopWatch: (() => Promise<void>) | null = null;
let unsubscribe: (() => void) | null = null;

async function teardown(): Promise<void> {
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

let openGen = 0;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useApp = create<AppState>((set, get) => ({
  fs: tauriFs,
  session: null,
  version: 0,
  conflicts: [],
  recovery: null,
  error: null,

  async openProject(root, d, opts) {
    const { fs } = get();
    const my = ++openGen;
    const stale = () => my !== openGen;
    await teardown();
    // Project settings in .paratrans/state.json override the detected/picked values.
    const st = parseState(await readState(fs, root), opts);
    const effective: ProjectOptions = {
      baseLocale: st.project.baseLocale,
      localesPath: st.project.localesPath ?? opts.localesPath,
    };
    const session = await ProjectSession.open(fs, root, d, effective);
    if (stale()) return;
    const name = root.split("/").filter(Boolean).pop() ?? root;
    try {
      await addRecent({ root, name, format: d.format });
    } catch {
      /* best effort */
    }
    let recovery: PendingRecovery | null = null;
    try {
      const path = journalPath(await appDataDir(), root);
      const journal = await readJournal(fs, path);
      if (journal) recovery = { journal, path };
    } catch {
      /* best effort */
    }
    if (stale()) return;

    unsubscribe = session.subscribe(() => set((s) => ({ version: s.version + 1 })));
    set({ session, conflicts: [], recovery, error: null, version: 0 });

    try {
      const stop = await watchDir(root, () => {
        if (get().session !== session) return;
        session.reloadFromDisk().then(
          (c) => {
            if (c.length && get().session === session) set((s) => ({ conflicts: [...s.conflicts, ...c] }));
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
    set({ session: null, conflicts: [], recovery: null, error: null, version: 0 });
  },

  async restoreRecovery() {
    const { session, recovery, fs } = get();
    if (!session || !recovery) return;
    try {
      const c = session.applyJournal(recovery.journal);
      set((s) => ({ recovery: null, conflicts: [...s.conflicts, ...c] }));
    } catch (e) {
      set({ recovery: null, error: `Could not restore unsaved changes: ${msg(e)}` });
      await clearJournal(fs, recovery.path).catch(() => {});
    }
  },

  async discardRecovery() {
    const { fs, recovery } = get();
    if (recovery) await clearJournal(fs, recovery.path);
    set({ recovery: null });
  },
}));

/** Re-renders on every session change; returns the change counter. */
export function useSessionVersion(): number {
  return useApp((s) => s.version);
}
