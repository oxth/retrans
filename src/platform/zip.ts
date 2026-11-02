import { invoke } from "@tauri-apps/api/core";

export interface ZipEntry { path: string; text: string }

/** Rust commands reject with plain strings; surface them as Errors. */
async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw e instanceof Error ? e : new Error(typeof e === "string" ? e : String(e));
  }
}

export const zipWrite = (dest: string, entries: ZipEntry[]): Promise<void> =>
  call<void>("zip_write", { dest, entries });

export const zipRead = (src: string): Promise<ZipEntry[]> =>
  call<ZipEntry[]>("zip_read", { src });
