import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Watches `root` recursively (Rust side debounces 300 ms and skips node_modules/.git/temp files).
 * Only one watch is active app-wide; starting another replaces it. Resolves to a stop function.
 */
export async function watchDir(root: string, onChange: (paths: string[]) => void): Promise<() => Promise<void>> {
  const unlisten = await listen<string[]>("fs-changed", (e) => onChange(e.payload));
  try {
    await invoke("watch_dir", { root });
  } catch (err) {
    unlisten();
    throw err;
  }
  return async () => {
    unlisten();
    await invoke("unwatch_dir");
  };
}
