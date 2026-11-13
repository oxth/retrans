import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { CatalogModel } from "../mt/catalog";
import type { GenerateRequest, ManyRequest, ManyResult, MtEngine } from "../mt/translate";

export interface ModelFile { file: string; size: number; complete: boolean }
export interface DownloadEvent {
  id: string;
  state: "progress" | "done" | "paused" | "cancelled" | "error";
  received: number;
  total: number;
  message?: string;
}

/** Rust commands reject with plain strings; surface them as Errors. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw e instanceof Error ? e : new Error(typeof e === "string" ? e : String(e));
  }
}

export const tauriEngine: MtEngine = {
  generate: (r: GenerateRequest) =>
    call<string>("mt_generate", {
      reqId: r.reqId,
      modelPath: r.modelPath,
      prompt: r.prompt,
      addBos: r.addBos,
      maxTokens: r.maxTokens,
      stop: r.stop,
    }),
  // Rust's Result<String, String> per prompt arrives as { Ok } or { Err }.
  generateMany: async (r: ManyRequest): Promise<ManyResult[]> => {
    const out = await call<Array<{ Ok: string } | { Err: string }>>("mt_generate_many", {
      reqId: r.reqId,
      modelPath: r.modelPath,
      prompts: r.prompts,
      addBos: r.addBos,
      stop: r.stop,
    });
    return out.map((x) => ("Ok" in x ? { ok: true, text: x.Ok } : { ok: false, message: x.Err }));
  },
  cancel: (reqId) => call<void>("mt_cancel", { reqId }),
};

export const mtNative = {
  modelsDir: () => call<string>("mt_models_dir"),
  status: () => call<ModelFile[]>("mt_models_status"),
  startDownload: (m: CatalogModel) =>
    call<void>("mt_download_start", { id: m.id, url: m.url, file: m.file, sha256: m.sha256, size: m.sizeBytes }),
  pause: (id: string) => call<void>("mt_download_pause", { id }),
  cancel: (id: string, file: string) => call<void>("mt_download_cancel", { id, file }),
  deleteModel: (file: string) => call<void>("mt_model_delete", { file }),
  unload: () => call<void>("mt_unload"),
  onDownload: (cb: (e: DownloadEvent) => void): Promise<() => void> =>
    listen<DownloadEvent>("mt-download", (e) => cb(e.payload)),
};

export async function pickGgufFile(): Promise<string | null> {
  const r = await open({ filters: [{ name: "GGUF model", extensions: ["gguf"] }] });
  return typeof r === "string" ? r : null;
}
