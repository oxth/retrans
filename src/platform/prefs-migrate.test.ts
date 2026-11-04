import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/prefs-v0.1.0.json";
import { MIGRATIONS, PREFS_VERSION, migratePrefs, type PrefsKV } from "./prefs-migrate";

class MapKV implements PrefsKV {
  readonly map = new Map<string, unknown>();
  writes = 0;

  constructor(seed: Record<string, unknown>) {
    for (const [k, v] of Object.entries(seed)) this.map.set(k, v);
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.writes += 1;
    this.map.set(key, value);
  }
}

const mapKV = (seed: Record<string, unknown>) => new MapKV(seed);

describe("migratePrefs", () => {
  it("migrates a v0.1.0 prefs file without losing anything", async () => {
    const before = structuredClone(fixture);
    const kv = mapKV(structuredClone(fixture));
    expect(await migratePrefs(kv)).toBe("migrated");
    for (const [k, v] of Object.entries(before)) expect(await kv.get(k)).toEqual(v);
    expect(await kv.get("prefsVersion")).toBe(PREFS_VERSION);
  });

  it("is a no-op on a current file", async () => {
    const kv = mapKV({ ...fixture, prefsVersion: PREFS_VERSION });
    expect(await migratePrefs(kv)).toBe("current");
  });

  it("keeps keys it does not know", async () => {
    const kv = mapKV({ ...fixture, someFutureThing: { a: 1 } });
    await migratePrefs(kv);
    expect(await kv.get("someFutureThing")).toEqual({ a: 1 });
  });

  it("leaves a newer file untouched", async () => {
    const kv = mapKV({ ...fixture, prefsVersion: PREFS_VERSION + 5 });
    expect(await migratePrefs(kv)).toBe("newer");
    expect(await kv.get("prefsVersion")).toBe(PREFS_VERSION + 5);
    expect(kv.writes).toBe(0);
  });

  it.each([undefined, "2", -1, 1.5, null])("treats prefsVersion %p as version 1", async (v) => {
    const kv = mapKV({ ...fixture, prefsVersion: v });
    expect(await migratePrefs(kv)).toBe("migrated");
    expect(await kv.get("prefsVersion")).toBe(PREFS_VERSION);
  });

  it("runs each step in order from the stored version", async () => {
    const kv = mapKV({ ...fixture, prefsVersion: 1 });
    const migrate1 = vi.spyOn(MIGRATIONS, 1);
    expect(await migratePrefs(kv)).toBe("migrated");
    expect(migrate1).toHaveBeenCalledTimes(1);
  });
});
