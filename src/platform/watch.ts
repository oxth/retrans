import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type FsChangedPayload = { root: string; paths: string[] };

/** Newest watch per root. Numbers come from one counter, so they're never reused. */
const generations = new Map<string, number>();
let lastGen = 0;

/**
 * Watches `root` recursively (Rust side debounces 300 ms and skips node_modules/.git/.next/dist/
 * build/target folders and temp files; the store further ignores paths outside the locales). Each
 * root is tracked separately. Resolves to a stop function; a superseded watch's stop only unlistens
 * and never stops the newer watch for that root.
 */
export async function watchDir(root: string, onChange: (paths: string[]) => void): Promise<() => Promise<void>> {
  const prevGen = generations.get(root);
  const gen = ++lastGen;
  generations.set(root, gen);
  const unlisten = await listen<FsChangedPayload>("fs-changed", (e) => {
    if (e.payload.root === root && gen === generations.get(root)) onChange(e.payload.paths);
  });
  try {
    await invoke("watch_dir", { root });
  } catch (err) {
    unlisten();
    if (generations.get(root) === gen) {
      if (prevGen === undefined) generations.delete(root);
      else generations.set(root, prevGen);
    }
    throw err;
  }
  return async () => {
    unlisten();
    if (gen === generations.get(root)) {
      generations.delete(root);
      await invoke("unwatch_dir", { root });
    }
  };
}
