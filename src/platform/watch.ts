import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

let generation = 0; // only the newest watch delivers events or may unwatch

/**
 * Watches `root` recursively (Rust side debounces 300 ms and skips node_modules/.git/temp files).
 * Only one watch is active app-wide; starting another replaces it. Resolves to a stop function;
 * a superseded watch's stop only unlistens and never stops the newer watch.
 */
export async function watchDir(root: string, onChange: (paths: string[]) => void): Promise<() => Promise<void>> {
  const gen = ++generation;
  const unlisten = await listen<string[]>("fs-changed", (e) => {
    if (gen === generation) onChange(e.payload);
  });
  try {
    await invoke("watch_dir", { root });
  } catch (err) {
    unlisten();
    throw err;
  }
  return async () => {
    unlisten();
    if (gen === generation) await invoke("unwatch_dir");
  };
}
