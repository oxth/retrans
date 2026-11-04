import { detectProject } from "../formats/detect";
import { getLaunchMode, getOpenTabs, setOpenTabs } from "../platform/prefs";
import { savedBaseLocale, useApp } from "./store";

const SAVE_DELAY_MS = 300;
let restoring = false;

const nameOf = (root: string) => root.split("/").filter(Boolean).pop() ?? root;

/**
 * Reopens the tabs open at the last quit, in order, then activates the one that was active.
 * Never asks anything: a folder that's gone, isn't a project any more, or needs a base-language
 * pick is skipped and named in one notice.
 */
export async function restoreTabs(): Promise<void> {
  const { roots, active } = await getOpenTabs();
  if (!roots.length) return;
  const { fs, openProject } = useApp.getState();
  const skipped: string[] = [];
  restoring = true;
  try {
    for (const root of roots) {
      const name = nameOf(root);
      try {
        if (!(await fs.exists(root))) {
          skipped.push(`Couldn't reopen ${name}: the folder is gone.`);
          continue;
        }
        const d = await detectProject(fs, root);
        if (!d) {
          skipped.push(`Couldn't reopen ${name}: it isn't a translation project any more.`);
          continue;
        }
        const base = d.baseLocale ?? (await savedBaseLocale(fs, root, d));
        if (base === null) {
          skipped.push(`Couldn't reopen ${name}: pick its base language from Open project.`);
          continue;
        }
        await openProject(root, d, { baseLocale: base, localesPath: d.localesPath });
      } catch (e) {
        skipped.push(`Couldn't reopen ${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    restoring = false;
  }
  const st = useApp.getState();
  const want = st.tabs.find((t) => t.root === active) ?? st.tabs[0];
  if (want) st.switchTab(want.id);
  if (skipped.length) useApp.setState({ notice: skipped.join(" · ") });
  saveNow();
}

/** On launch: reopen the last tabs, or stay on the start screen, as the user chose in Settings. */
export async function launch(): Promise<void> {
  if ((await getLaunchMode()) === "restore") await restoreTabs();
}

function saveNow(): void {
  const s = useApp.getState();
  const activeRoot = s.tabs.find((t) => t.id === s.activeId)?.root ?? null;
  setOpenTabs(s.tabs.map((t) => t.root), activeRoot).catch((e) => console.warn("saving open tabs failed", e));
}

/** Saves the tab list and the active tab whenever they change (debounced). Returns a stop function. */
export function startTabPersistence(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsub = useApp.subscribe((s, prev) => {
    if (restoring || (s.tabs === prev.tabs && s.activeId === prev.activeId)) return;
    const sameList = s.tabs.length === prev.tabs.length && s.tabs.every((t, i) => t.id === prev.tabs[i].id);
    if (sameList && s.activeId === prev.activeId) return; // a tab's snapshot or busy count changed
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      saveNow();
    }, SAVE_DELAY_MS);
  });
  return () => {
    if (timer) clearTimeout(timer);
    unsub();
  };
}
