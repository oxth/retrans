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
    // A failed migration must not take every pref with it: keep the store and retry next launch.
    try {
      if ((await migratePrefs(store)) === "migrated") await store.save();
    } catch (e) {
      console.warn("Couldn't migrate prefs; will retry next launch:", e);
    }
    return store;
  })().catch((e) => {
    storePromise = null; // don't cache a failed load for the whole session
    throw e;
  }));

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

/** Takes a project off the recent list. Its folder and files are not touched. */
export async function removeRecent(root: string): Promise<void> {
  const s = await getStore();
  await s.set("recent", (await getRecent()).filter((r) => r.root !== root));
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

export type Theme = "system" | "light" | "dark";
export type UiSize = "small" | "default" | "large" | "larger";
export interface Appearance {
  theme: Theme;
  size: UiSize;
}
export const DEFAULT_APPEARANCE: Appearance = { theme: "system", size: "default" };
const THEMES: Theme[] = ["system", "light", "dark"];
const SIZES: UiSize[] = ["small", "default", "large", "larger"];

/** Settings → Appearance; anything unknown reads as the default. */
export function appearanceOf(v: unknown): Appearance {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  return {
    theme: THEMES.includes(o.theme as Theme) ? (o.theme as Theme) : DEFAULT_APPEARANCE.theme,
    size: SIZES.includes(o.size as UiSize) ? (o.size as UiSize) : DEFAULT_APPEARANCE.size,
  };
}

export async function getAppearance(): Promise<Appearance> {
  const s = await getStore();
  return appearanceOf(await s.get("appearance"));
}

export async function setAppearance(a: Appearance): Promise<void> {
  const s = await getStore();
  await s.set("appearance", a);
  await s.save();
}

/** The project's saved mode, else the global default. */
export async function getViewMode(root: string): Promise<"list" | "table"> {
  const s = await getStore();
  const all = (await s.get<Record<string, "list" | "table">>("viewMode")) ?? {};
  if (all[root] === "table" || all[root] === "list") return all[root];
  return getDefaultViewMode();
}

/** The project's own saved mode, or null when it follows the global default. */
export async function getOwnViewMode(root: string): Promise<"list" | "table" | null> {
  const s = await getStore();
  const all = (await s.get<Record<string, "list" | "table">>("viewMode")) ?? {};
  return all[root] === "table" || all[root] === "list" ? all[root] : null;
}

/** Makes the project follow the global default again. */
export async function clearViewMode(root: string): Promise<void> {
  const s = await getStore();
  const { [root]: _dropped, ...rest } = (await s.get<Record<string, "list" | "table">>("viewMode")) ?? {};
  await s.set("viewMode", rest);
  await s.save();
}

export async function setViewMode(root: string, m: "list" | "table"): Promise<void> {
  const s = await getStore();
  const all = (await s.get<Record<string, "list" | "table">>("viewMode")) ?? {};
  await s.set("viewMode", { ...all, [root]: m });
  await s.save();
}

export type ProviderId = "local" | "openai" | "anthropic" | "compatible" | "acp";

export interface MtSettings {
  enabled: boolean;
  modelId: string | null;
  custom: { path: string; template: PromptTemplate } | null;
  accepted: string[];
  /** Who translates: the built-in model (default) or a cloud / agent provider. */
  provider: ProviderId;
  /** Per cloud provider: the model, and for "compatible" the API base URL. Keys are never here. */
  cloud: { openai?: { model: string }; anthropic?: { model: string }; compatible?: { baseUrl: string; model: string } };
  acp: { preset: "claude-code" | "codex" | "gemini" | "custom"; command: string; args: string[] } | null;
  /** Providers the user agreed to send text to. */
  consent: string[];
  /** Custom instructions for all projects. */
  instructions: string;
}

const mtDefaults = (): MtSettings => ({
  enabled: false, modelId: null, custom: null, accepted: [], provider: "local", cloud: {}, acp: null, consent: [], instructions: "",
});

const PROVIDERS: ProviderId[] = ["local", "openai", "anthropic", "compatible", "acp"];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function cloudOf(v: unknown): MtSettings["cloud"] {
  const out: MtSettings["cloud"] = {};
  if (!isObj(v)) return out;
  for (const k of ["openai", "anthropic"] as const) {
    const m = isObj(v[k]) ? str(v[k].model) : undefined;
    if (m !== undefined) out[k] = { model: m };
  }
  if (isObj(v.compatible)) {
    const baseUrl = str(v.compatible.baseUrl);
    const model = str(v.compatible.model);
    if (baseUrl !== undefined && model !== undefined) out.compatible = { baseUrl, model };
  }
  return out;
}

function acpOf(v: unknown): MtSettings["acp"] {
  if (!isObj(v) || typeof v.command !== "string" || !Array.isArray(v.args)) return null;
  const preset = v.preset === "claude-code" || v.preset === "codex" || v.preset === "gemini" ? v.preset : "custom";
  return { preset, command: v.command, args: v.args.filter((a): a is string => typeof a === "string") };
}

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
    provider: PROVIDERS.includes(v.provider as ProviderId) ? (v.provider as ProviderId) : "local",
    cloud: cloudOf(v.cloud),
    acp: acpOf(v.acp),
    consent: Array.isArray(v.consent) ? v.consent.filter((a): a is string => typeof a === "string") : [],
    instructions: typeof v.instructions === "string" ? v.instructions : "",
  };
}

export async function setMtSettings(v: MtSettings): Promise<void> {
  const s = await getStore();
  await s.set("mt", v);
  await s.save();
}

/**
 * Records the version this launch runs and returns the one before it: null on a first launch,
 * "" for an existing user from before versions were recorded (they have recent projects).
 */
export async function recordLaunchedVersion(version: string): Promise<string | null> {
  const s = await getStore();
  const last = (await s.get<string>("lastVersion")) ?? ((await getRecent()).length ? "" : null);
  if (last !== version) {
    await s.set("lastVersion", version);
    await s.save();
  }
  return last;
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

/** The tabs open at quit (roots, in tab order) and the active one; reopened on launch. */
export async function getOpenTabs(): Promise<{ roots: string[]; active: string | null }> {
  const s = await getStore();
  const roots = await s.get<unknown>("openTabs");
  const active = await s.get<unknown>("activeTab");
  return {
    roots: Array.isArray(roots) ? roots.filter((r): r is string => typeof r === "string") : [],
    active: typeof active === "string" ? active : null,
  };
}

export async function setOpenTabs(roots: string[], active: string | null): Promise<void> {
  const s = await getStore();
  await s.set("openTabs", roots);
  await s.set("activeTab", active);
  await s.save();
}

/** What a launch shows: the projects open last time ("restore", the default) or the start screen. */
export type LaunchMode = "restore" | "start";

export async function getLaunchMode(): Promise<LaunchMode> {
  const s = await getStore();
  return (await s.get<string>("launchMode")) === "start" ? "start" : "restore";
}

export async function setLaunchMode(m: LaunchMode): Promise<void> {
  const s = await getStore();
  await s.set("launchMode", m);
  await s.save();
}
