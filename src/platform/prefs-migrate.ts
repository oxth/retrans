export const PREFS_VERSION = 2;

export interface PrefsKV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export const MIGRATIONS: Record<number, (kv: PrefsKV) => Promise<void>> = {
  1: async () => {},
};

function normalizeVersion(v: unknown): number {
  return Number.isInteger(v) && typeof v === "number" && v >= 1 ? v : 1;
}

export async function migratePrefs(kv: PrefsKV): Promise<"current" | "migrated" | "newer"> {
  const stored = normalizeVersion(await kv.get("prefsVersion"));
  if (stored > PREFS_VERSION) return "newer";
  if (stored === PREFS_VERSION) return "current";

  for (let v = stored; v < PREFS_VERSION; v += 1) {
    const migrate = MIGRATIONS[v];
    if (migrate) await migrate(kv);
  }

  await kv.set("prefsVersion", PREFS_VERSION);
  return "migrated";
}
