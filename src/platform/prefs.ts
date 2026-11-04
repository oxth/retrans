import { load, type Store } from "@tauri-apps/plugin-store";
import type { Format } from "../core/model";
import type { PromptTemplate } from "../mt/catalog";
import { migratePrefs } from "./prefs-migrate";

export interface RecentProject { root: string; name: string; format: Format }

const MAX_RECENT = 10;
let storePromise: Promise<Store> | null = null;
const getStore = () =>
  (storePromise ??= (async () => {
    const store = await load("prefs.json", { defaults: {}, autoSave: false });
    const state = await migratePrefs(store);
    if (state === "migrated") {
      try {
        await store.save();
      } catch (e) {
        console.warn("Failed to save migrated prefs:", e);
      }
    }
    return store;
  })());

export async function getRecent(): Promise<RecentProject[]> {
  const s = await getStore();
  return (await s.get<RecentProject[]>("recent")) ?? [];
}

export async function addRecent(e: RecentProject): Promise<void> {
  const s = await getStore();
  const rest = (await getRecent()).filter((r) => r.root !== e.root);
  await s.set("recent", [e, ...rest].slice(0, MAX_RECENT));
  await s.save();
}

export async function getDefaultViewMode(): Promise<"list" | "table"> {
  const s = await getStore();
  return (await s.get<string>("defaultViewMode")) === "table" ? "table" : "list";
}

export async function setDefaultViewMode(m: "list" | "table"): Promise<void> {
  const s = await getStore();
  await s.set("defaultViewMode", m);
  await s.save();
}

/** The project's saved mode, else the global default. */
export async function getViewMode(root: string): Promise<"list" | "table"> {
  const s = await getStore();
  const all = (await s.get<Record<string, "list" | "table">>("viewMode")) ?? {};
  if (all[root] === "table" || all[root] === "list") return all[root];
  return getDefaultViewMode();
}

export async function setViewMode(root: string, m: "list" | "table"): Promise<void> {
  const s = await getStore();
  const all = (await s.get<Record<string, "list" | "table">>("viewMode")) ?? {};
  await s.set("viewMode", { ...all, [root]: m });
  await s.save();
}

export interface MtSettings {
  enabled: boolean;
  modelId: string | null;
  custom: { path: string; template: PromptTemplate } | null;
  accepted: string[];
}

const mtDefaults = (): MtSettings => ({ enabled: false, modelId: null, custom: null, accepted: [] });

export async function getMtSettings(): Promise<MtSettings> {
  const s = await getStore();
  const v = await s.get<Partial<MtSettings>>("mt");
  if (!v || typeof v !== "object") return mtDefaults();
  const c = v.custom;
  const template = c?.template;
  return {
    enabled: v.enabled === true,
    modelId: typeof v.modelId === "string" ? v.modelId : null,
    custom:
      c && typeof c.path === "string" && (template === "translategemma" || template === "qwen3")
        ? { path: c.path, template }
        : null,
    accepted: Array.isArray(v.accepted) ? v.accepted.filter((a): a is string => typeof a === "string") : [],
  };
}

export async function setMtSettings(v: MtSettings): Promise<void> {
  const s = await getStore();
  await s.set("mt", v);
  await s.save();
}

export async function getAutoCheckUpdates(): Promise<boolean> {
  const s = await getStore();
  return (await s.get<boolean>("autoCheckUpdates")) !== false;
}

export async function setAutoCheckUpdates(on: boolean): Promise<void> {
  const s = await getStore();
  await s.set("autoCheckUpdates", on);
  await s.save();
}
