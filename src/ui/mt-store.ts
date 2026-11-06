import { create } from "zustand";
import { findModel } from "../mt/catalog";
import type { PromptTemplate } from "../mt/catalog";
import type { ActiveModel, MtEngine } from "../mt/translate";
import { type DownloadEvent, mtNative, tauriEngine } from "../platform/mt";
import { getMtSettings, type MtSettings, type ProviderId, setMtSettings } from "../platform/prefs";
import type { Format } from "../core/model";
import { acpTranslator, cloudTranslator, localTranslator, type Translator } from "../mt/translator";
import { tauriFs } from "../platform/tauri-fs";

type Downloads = Record<string, { received: number; total: number; state: DownloadEvent["state"]; message?: string }>;

export interface MtState {
  initialized: boolean;
  settings: MtSettings;
  modelsDir: string | null;
  files: Record<string, { size: number; complete: boolean }>;
  downloads: Downloads;
  customMissing: boolean;
  engine: MtEngine;
  init(): Promise<void>;
  setEnabled(on: boolean): Promise<void>;
  selectModel(id: string): Promise<void>;
  acceptLicense(id: string): Promise<void>;
  download(id: string): Promise<void>;
  pause(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  deleteModel(id: string): Promise<void>;
  setCustom(path: string, template: PromptTemplate): Promise<void>;
  /** Who translates. A remote provider needs the user's consent first (grantConsent). */
  setProvider(p: ProviderId): Promise<void>;
  grantConsent(p: ProviderId): Promise<void>;
  setCloud(p: "openai" | "anthropic" | "compatible", cfg: { model: string; baseUrl?: string }): Promise<void>;
  setAcp(cfg: MtSettings["acp"]): Promise<void>;
  setInstructions(text: string): Promise<void>;
  refresh(): Promise<void>;
}

const warn = (what: string, e: unknown) => console.warn(`[mt] ${what} failed`, e);

export const useMt = create<MtState>((set, get) => {
  const save = async (settings: MtSettings) => {
    set({ settings });
    try {
      await setMtSettings(settings);
    } catch (e) {
      warn("saving settings", e);
    }
  };
  const unload = async () => {
    try {
      await mtNative.unload();
    } catch (e) {
      warn("unload", e);
    }
  };
  const fail = (id: string, message: string) =>
    set((s) => ({ downloads: { ...s.downloads, [id]: { received: 0, total: 0, state: "error", message } } }));
  const checkCustom = async (custom: MtSettings["custom"]) => {
    if (!custom) return set({ customMissing: false });
    try {
      set({ customMissing: !(await tauriFs.exists(custom.path)) });
    } catch (e) {
      warn("custom file check", e);
      set({ customMissing: true });
    }
  };

  // a finished download becomes the selected model unless a usable one is already selected
  const autoSelect = async (id: string) => {
    const s = get();
    const m = findModel(id);
    if (!m || !s.files[m.file]?.complete) return;
    const { modelId, custom } = s.settings;
    if (modelId === "custom" && custom && !s.customMissing) return;
    if (modelId && modelId !== "custom") {
      const cur = findModel(modelId);
      if (cur && s.files[cur.file]?.complete) return;
    }
    await s.selectModel(id);
  };

  return {
    initialized: false,
    settings: {
      enabled: false, modelId: null, custom: null, accepted: [], provider: "local", cloud: {}, acp: null, consent: [], instructions: "",
    },
    modelsDir: null,
    files: {},
    downloads: {},
    customMissing: false,
    engine: tauriEngine,

    async init() {
      if (get().initialized) return;
      set({ initialized: true });
      try {
        const settings = await getMtSettings();
        set({ settings });
        await checkCustom(settings.custom);
      } catch (e) {
        warn("loading settings", e);
      }
      await get().refresh();
      try {
        await mtNative.onDownload((e) => {
          set((s) => ({
            downloads: { ...s.downloads, [e.id]: { received: e.received, total: e.total, state: e.state, message: e.message } },
          }));
          if (e.state === "done") void get().refresh().then(() => autoSelect(e.id));
          else if (e.state !== "progress") void get().refresh();
        });
      } catch (e) {
        warn("download events", e);
      }
    },

    async setEnabled(on) {
      await save({ ...get().settings, enabled: on });
      if (on) return;
      const running = Object.entries(get().downloads).filter(([, d]) => d.state === "progress");
      await Promise.all(running.map(([id]) => get().pause(id)));
      await unload();
    },

    async selectModel(id) {
      await save({ ...get().settings, modelId: id });
      await unload();
    },

    async acceptLicense(id) {
      const { accepted } = get().settings;
      if (accepted.includes(id)) return;
      await save({ ...get().settings, accepted: [...accepted, id] });
    },

    async download(id) {
      const m = findModel(id);
      if (!m) return fail(id, "Unknown model.");
      if (m.license.requiresAcceptance && !get().settings.accepted.includes(id)) {
        return fail(id, "Accept the license first.");
      }
      set((s) => ({ downloads: { ...s.downloads, [id]: { received: 0, total: m.sizeBytes, state: "progress" } } }));
      try {
        await mtNative.startDownload(m);
      } catch (e) {
        fail(id, e instanceof Error ? e.message : String(e));
      }
    },

    async pause(id) {
      try {
        await mtNative.pause(id);
      } catch (e) {
        warn("pause", e);
      }
    },

    async cancel(id) {
      const m = findModel(id);
      if (!m) return;
      try {
        await mtNative.cancel(id, m.file);
      } catch (e) {
        warn("cancel", e);
      }
      await get().refresh();
    },

    async deleteModel(id) {
      const m = findModel(id);
      if (!m) return;
      try {
        await mtNative.deleteModel(m.file);
      } catch (e) {
        warn("delete", e);
      }
      await get().refresh();
    },

    async setProvider(p) {
      await save({ ...get().settings, provider: p });
    },

    async grantConsent(p) {
      const c = get().settings.consent;
      if (!c.includes(p)) await save({ ...get().settings, consent: [...c, p] });
    },

    async setCloud(p, cfg) {
      const cloud = { ...get().settings.cloud };
      if (p === "compatible") cloud.compatible = { baseUrl: cfg.baseUrl ?? "", model: cfg.model };
      else cloud[p] = { model: cfg.model };
      await save({ ...get().settings, cloud });
    },

    async setAcp(cfg) {
      await save({ ...get().settings, acp: cfg });
    },

    async setInstructions(text) {
      await save({ ...get().settings, instructions: text });
    },

    async setCustom(path, template) {
      const custom = { path, template };
      await save({ ...get().settings, custom, modelId: "custom" });
      await checkCustom(custom);
      await unload();
    },

    async refresh() {
      try {
        const [dir, list] = await Promise.all([mtNative.modelsDir(), mtNative.status()]);
        const files: MtState["files"] = {};
        for (const f of list) {
          // a finished file wins over a stale .part of the same name
          if (!files[f.file] || f.complete) files[f.file] = { size: f.size, complete: f.complete };
        }
        set({ modelsDir: dir, files });
      } catch (e) {
        warn("status", e);
      }
    },
  };
});

export function activeModel(s: Pick<MtState, "settings" | "files" | "modelsDir" | "customMissing">): ActiveModel | null {
  const { enabled, modelId, custom } = s.settings;
  if (!enabled || !modelId) return null;
  if (modelId === "custom") {
    return custom && !s.customMissing ? { path: custom.path, template: custom.template } : null;
  }
  const m = findModel(modelId);
  if (!m || !s.modelsDir || !s.files[m.file]?.complete) return null;
  return { path: `${s.modelsDir}/${m.file}`, template: m.template };
}

export function spaceUsed(s: Pick<MtState, "files">): number {
  return Object.values(s.files).reduce((n, f) => n + f.size, 0);
}

/** What the user agrees to: a provider, or for "compatible" the exact API address. */
export function consentKey(provider: ProviderId, settings: MtSettings): string {
  return provider === "compatible" ? `compatible:${(settings.cloud.compatible?.baseUrl ?? "").trim().replace(/\/+$/, "")}` : provider;
}

/**
 * The translator to use, or null when none is ready: machine translation off, no model, a cloud
 * provider without a model, or a remote provider the user hasn't agreed to send text to.
 * `override` is the project's own provider choice (state.json), when it has one.
 */
export function activeTranslator(
  s: Pick<MtState, "settings" | "files" | "modelsDir" | "customMissing" | "engine">,
  format: Format,
  override?: string,
): Translator | null {
  const { settings } = s;
  if (!settings.enabled) return null;
  const provider = (override ?? settings.provider ?? "local") as ProviderId;
  if (provider === "local") {
    const model = activeModel(s);
    return model ? localTranslator(s.engine, model, format) : null;
  }
  if (!settings.consent.includes(consentKey(provider, settings))) return null;
  if (provider === "acp") return settings.acp ? acpTranslator(settings.acp, format) : null;
  if (provider === "compatible") {
    const c = settings.cloud.compatible;
    return c?.baseUrl && c.model ? cloudTranslator({ provider, model: c.model, baseUrl: c.baseUrl }, format) : null;
  }
  if (provider === "openai" || provider === "anthropic") {
    const model = settings.cloud[provider]?.model;
    return model ? cloudTranslator({ provider, model }, format) : null;
  }
  return null;
}
