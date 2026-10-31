import { invoke } from "@tauri-apps/api/core";
import { type Fs, FsError } from "./fs";

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    if (e && typeof e === "object" && "code" in e) {
      const { code, message } = e as { code: string; message?: string };
      throw new FsError(code === "NotFound" ? "NotFound" : "Io", message ?? String(code));
    }
    throw new FsError("Io", String(e));
  }
}

export const tauriFs: Fs = {
  readText: (path) => call("read_text", { path }),
  writeTextAtomic: (path, content) => call("write_text_atomic", { path, content }),
  exists: (path) => call("path_exists", { path }),
  listFiles: (root, maxDepth) => call("list_files", { root, maxDepth }),
  remove: (path) => call("remove_path", { path }),
  mkdirp: (path) => call("mkdirp", { path }),
};
