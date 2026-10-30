import { load, type Store } from "@tauri-apps/plugin-store";
import type { Format } from "../core/model";

export interface RecentProject { root: string; name: string; format: Format }

const MAX_RECENT = 10;
let storePromise: Promise<Store> | null = null;
const getStore = () => (storePromise ??= load("prefs.json", { defaults: {}, autoSave: false }));

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

export async function getViewMode(root: string): Promise<"list" | "table"> {
  const s = await getStore();
  const all = (await s.get<Record<string, "list" | "table">>("viewMode")) ?? {};
  return all[root] === "table" ? "table" : "list";
}

export async function setViewMode(root: string, m: "list" | "table"): Promise<void> {
  const s = await getStore();
  const all = (await s.get<Record<string, "list" | "table">>("viewMode")) ?? {};
  await s.set("viewMode", { ...all, [root]: m });
  await s.save();
}
