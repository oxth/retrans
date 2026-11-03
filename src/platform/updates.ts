import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface AvailableUpdate {
  version: string;
  notes?: string;
  install(onProgress?: (done: number, total: number) => void): Promise<void>;
}

/** Resolves null when up to date. Rejects when the check can't run (offline, dev build, bad key). */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    notes: update.body,
    async install(onProgress) {
      let done = 0;
      let total = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") done += e.data.chunkLength;
        else return;
        onProgress?.(done, total);
      });
      await relaunch();
    },
  };
}
