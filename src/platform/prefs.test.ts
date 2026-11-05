import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/prefs-v0.1.0.json";
import { PREFS_VERSION } from "./prefs-migrate";

const state = vi.hoisted(() => ({
  prefs: new Map<string, unknown>(),
  saveCalls: 0,
  saveThrows: false,
  versionGetThrows: false,
  loadThrowsOnce: false,
}));

const load = vi.hoisted(() =>
  vi.fn(async () => {
    if (state.loadThrowsOnce) {
      state.loadThrowsOnce = false;
      throw new Error("load failed");
    }
    return {
      get: async (k: string) => {
        if (k === "prefsVersion" && state.versionGetThrows) throw new Error("read failed");
        return state.prefs.get(k);
      },
      set: async (k: string, v: unknown) => void state.prefs.set(k, v),
      save: async () => {
        state.saveCalls += 1;
        if (state.saveThrows) throw new Error("save failed");
      },
    };
  }),
);

vi.mock("@tauri-apps/plugin-store", () => ({ load }));

describe("prefs store migration wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    state.prefs.clear();
    state.saveCalls = 0;
    state.saveThrows = false;
    state.versionGetThrows = false;
    state.loadThrowsOnce = false;
    load.mockClear();
  });

  it("migrates on first load and saves once", async () => {
    for (const [k, v] of Object.entries(structuredClone(fixture))) state.prefs.set(k, v);

    const { getRecent } = await import("./prefs");
    await getRecent();
    const recent = await getRecent();

    expect(state.prefs.get("prefsVersion")).toBe(PREFS_VERSION);
    expect(state.saveCalls).toBe(1);
    expect(recent).toEqual(fixture.recent);
  });

  it("migration save failure does not block loading", async () => {
    for (const [k, v] of Object.entries(structuredClone(fixture))) state.prefs.set(k, v);
    state.saveThrows = true;

    const { getRecent, getMtSettings } = await import("./prefs");
    await expect(getRecent()).resolves.toEqual(fixture.recent);
    await expect(getMtSettings()).resolves.toEqual({
      enabled: true,
      modelId: "translategemma-4b",
      custom: null,
      accepted: ["translategemma-4b"],
      provider: "local",
      cloud: {},
      acp: null,
      consent: [],
      instructions: "",
    });
  });

  it("loads prefs.json by a version-free relative name", async () => {
    const { getRecent } = await import("./prefs");
    await getRecent();
    expect(load).toHaveBeenCalledWith("prefs.json", expect.anything());
  });

  it("a failed migration read does not break every later prefs call", async () => {
    for (const [k, v] of Object.entries(structuredClone(fixture))) state.prefs.set(k, v);
    state.versionGetThrows = true;

    const { getRecent } = await import("./prefs");
    await expect(getRecent()).resolves.toEqual(fixture.recent);
  });

  it("retries loading the store after a failed load", async () => {
    for (const [k, v] of Object.entries(structuredClone(fixture))) state.prefs.set(k, v);
    state.loadThrowsOnce = true;

    const { getRecent } = await import("./prefs");
    await expect(getRecent()).rejects.toThrow("load failed");
    await expect(getRecent()).resolves.toEqual(fixture.recent);
  });
});
