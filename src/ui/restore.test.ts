import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async (k: string) => prefs.get(k),
    set: async (k: string, v: unknown) => void prefs.set(k, v),
    save: async () => {},
  })),
}));
vi.mock("../platform/watch", () => ({ watchDir: vi.fn(async () => async () => {}) }));

import { detectProject } from "../formats/detect";
import { loadFixtureDir, MemoryFs } from "../platform/memory-fs";
import { getLaunchMode, getOpenTabs, setLaunchMode, setOpenTabs } from "../platform/prefs";
import { launch, restoreTabs, startTabPersistence } from "./restore";
import { useApp } from "./store";

const FIX = resolve(__dirname, "../test/fixtures") + "/";

function fsWith(...roots: string[]) {
  const files: Record<string, string> = {};
  for (const r of roots) Object.assign(files, loadFixtureDir(FIX + "next-nested", r).snapshot());
  const fs = new MemoryFs(files);
  useApp.setState({ fs });
  return fs;
}

const roots = () => useApp.getState().tabs.map((t) => t.root);
const activeRoot = () => useApp.getState().session?.data.root ?? null;

beforeEach(async () => {
  await useApp.getState().closeAllTabs();
  prefs.clear();
});
afterEach(() => vi.useRealTimers());

describe("restore tabs", () => {
  it("reopens saved tabs in order and activates the saved one", async () => {
    fsWith("/a", "/b", "/c");
    await setOpenTabs(["/a", "/b", "/c"], "/b");
    await restoreTabs();
    expect(roots()).toEqual(["/a", "/b", "/c"]);
    expect(activeRoot()).toBe("/b");
    expect(useApp.getState().notice).toBeNull();
  });

  it("skips a missing folder with a notice", async () => {
    fsWith("/a", "/c");
    await setOpenTabs(["/a", "/gone", "/c"], "/gone");
    await restoreTabs();
    expect(roots()).toEqual(["/a", "/c"]);
    expect(activeRoot()).toBe("/a"); // the saved active one is gone: the first tab
    expect(useApp.getState().notice).toBe("Couldn't reopen gone: the folder is gone.");
  });

  it("restore skips a project that needs a base-language pick", async () => {
    const fs = fsWith("/a");
    await fs.writeTextAtomic("/x/public/locales/en/common.json", '{"a":"A"}');
    await fs.writeTextAtomic("/x/public/locales/th/common.json", '{"a":"ก"}');
    expect((await detectProject(fs, "/x"))!.baseLocale).toBeNull();
    await setOpenTabs(["/x", "/a"], "/x");
    await restoreTabs();
    expect(roots()).toEqual(["/a"]);
    expect(useApp.getState().notice).toBe("Couldn't reopen x: pick its base language from Open project.");
  });

  it("joins several notices", async () => {
    fsWith("/a");
    await setOpenTabs(["/gone1", "/a", "/gone2"], null);
    await restoreTabs();
    expect(useApp.getState().notice).toBe(
      "Couldn't reopen gone1: the folder is gone. · Couldn't reopen gone2: the folder is gone.",
    );
  });

  it("restore with nothing saved shows the start screen", async () => {
    fsWith("/a");
    await restoreTabs();
    expect(useApp.getState().tabs).toEqual([]);
    expect(useApp.getState().activeId).toBeNull();
  });

  it("saves the tab list when tabs change", async () => {
    vi.useFakeTimers();
    const fs = fsWith("/a", "/b");
    const stop = startTabPersistence();
    try {
      for (const r of ["/a", "/b"]) {
        const d = (await detectProject(fs, r))!;
        await useApp.getState().openProject(r, d, { baseLocale: d.baseLocale!, localesPath: d.localesPath });
      }
      await vi.advanceTimersByTimeAsync(300);
      expect(await getOpenTabs()).toEqual({ roots: ["/a", "/b"], active: "/b" });
      await useApp.getState().closeProject();
      await vi.advanceTimersByTimeAsync(300);
      expect(await getOpenTabs()).toEqual({ roots: ["/a"], active: "/a" });
      useApp.getState().showStart();
      await vi.advanceTimersByTimeAsync(300);
      expect(await getOpenTabs()).toEqual({ roots: ["/a"], active: null });
    } finally {
      stop();
    }
  });

  it("invalid saved values read as nothing", async () => {
    prefs.set("openTabs", ["/a", 3, null]);
    prefs.set("activeTab", 7);
    expect(await getOpenTabs()).toEqual({ roots: ["/a"], active: null });
    prefs.set("openTabs", "nope");
    expect(await getOpenTabs()).toEqual({ roots: [], active: null });
  });
});

describe("launch preference", () => {
  it("defaults to reopening the last projects", async () => {
    expect(await getLaunchMode()).toBe("restore");
  });

  it("launch reopens tabs when set to restore", async () => {
    fsWith("/a");
    await setOpenTabs(["/a"], "/a");
    await launch();
    expect(roots()).toEqual(["/a"]);
  });

  it("launch shows the start screen when set to start, and keeps the saved list", async () => {
    fsWith("/a");
    await setOpenTabs(["/a"], "/a");
    await setLaunchMode("start");
    await launch();
    expect(useApp.getState().tabs).toEqual([]);
    expect(await getOpenTabs()).toEqual({ roots: ["/a"], active: "/a" });
  });
});
