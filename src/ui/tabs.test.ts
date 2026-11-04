import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async (k: string) => prefs.get(k),
    set: async (k: string, v: unknown) => void prefs.set(k, v),
    save: async () => {},
  })),
}));
vi.mock("../platform/watch", () => ({ watchDir: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ exit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));

import { journalPath } from "../core/recovery";
import { detectProject } from "../formats/detect";
import { loadFixtureDir, MemoryFs } from "../platform/memory-fs";
import { watchDir } from "../platform/watch";
import { invoke } from "@tauri-apps/api/core";
import { exit } from "@tauri-apps/plugin-process";
import { startUnsavedSync, useApp } from "./store";

const FIX = resolve(__dirname, "../test/fixtures/next-nested");
const TH1 = "/p1/public/locales/th/common.json";
const watch = vi.mocked(watchDir);
let fire: Record<string, (paths: string[]) => void> = {};
let stops: Record<string, ReturnType<typeof vi.fn>> = {};

async function twoProjects() {
  const fs = new MemoryFs({ ...loadFixtureDir(FIX, "/p1").snapshot(), ...loadFixtureDir(FIX, "/p2").snapshot() });
  useApp.setState({ fs });
  const open = async (root: string) => {
    const d = (await detectProject(fs, root))!;
    await useApp.getState().openProject(root, d, { baseLocale: d.baseLocale!, localesPath: d.localesPath });
    return d;
  };
  await open("/p1");
  const s1 = useApp.getState().session!;
  const id1 = useApp.getState().activeId!;
  await open("/p2");
  const s2 = useApp.getState().session!;
  const id2 = useApp.getState().activeId!;
  return { fs, open, s1, s2, id1, id2 };
}

const tab = (id: string) => useApp.getState().tabs.find((t) => t.id === id)!;

beforeEach(async () => {
  await useApp.getState().closeAllTabs();
  vi.mocked(exit).mockClear();
  vi.mocked(invoke).mockClear();
  prefs.clear();
  fire = {};
  stops = {};
  watch.mockReset();
  watch.mockImplementation(async (root, cb) => {
    fire[root] = cb;
    const stop = vi.fn(async () => {});
    stops[root] = stop;
    return stop;
  });
});

describe("tabs", () => {
  it("opening a second project adds a tab and keeps the first", async () => {
    const { s1, s2, id1, id2 } = await twoProjects();
    const st = useApp.getState();
    expect(st.tabs.map((t) => t.id)).toEqual([id1, id2]);
    expect(st.activeId).toBe(id2);
    expect(st.session).toBe(s2);
    expect(tab(id1).snap?.session).toBe(s1);
    expect(tab(id2).snap).toBeNull();
  });

  it("opening an open root switches to its tab", async () => {
    const { open, s1, id1 } = await twoProjects();
    await open("/p1/");
    const st = useApp.getState();
    expect(st.tabs).toHaveLength(2);
    expect(st.activeId).toBe(id1);
    expect(st.session).toBe(s1);
  });

  it("edits stay in their own tab", async () => {
    const { s2, id1, id2 } = await twoProjects();
    s2.setText(s2.data.keyOrder[0], "th", "changed");
    useApp.getState().switchTab(id1);
    expect(useApp.getState().session!.isDirty()).toBe(false);
    useApp.getState().switchTab(id2);
    expect(useApp.getState().session).toBe(s2);
    expect(useApp.getState().session!.isDirty()).toBe(true);
  });

  it("background tab reload lands in its own snapshot", async () => {
    const { fs, s1, id1, id2 } = await twoProjects();
    useApp.getState().switchTab(id1);
    const k = s1.data.keyOrder.find((x) => x === "common::title")!;
    s1.setText(k, "th", "mine");
    useApp.getState().switchTab(id2);
    const disk = JSON.parse(await fs.readText(TH1));
    disk.title = "theirs";
    await fs.writeTextAtomic(TH1, JSON.stringify(disk, null, 2) + "\n");
    fire["/p1"]([TH1]);
    await vi.waitFor(() => expect(tab(id1).snap?.conflicts).toHaveLength(1));
    expect(useApp.getState().conflicts).toEqual([]);
    useApp.getState().switchTab(id1);
    expect(useApp.getState().conflicts).toHaveLength(1);
  });

  it("each tab has its own watcher", async () => {
    await twoProjects();
    expect(watch.mock.calls.map((c) => c[0])).toEqual(["/p1", "/p2"]);
    await useApp.getState().closeProject();
    expect(stops["/p2"]).toHaveBeenCalled();
    expect(stops["/p1"]).not.toHaveBeenCalled();
  });

  it("closing the active tab activates its neighbour, then the start screen", async () => {
    const { fs, s1, id1, id2 } = await twoProjects();
    const d3 = loadFixtureDir(FIX, "/p3").snapshot();
    for (const [p, t] of Object.entries(d3)) await fs.writeTextAtomic(p, t);
    const d = (await detectProject(fs, "/p3"))!;
    await useApp.getState().openProject("/p3", d, { baseLocale: d.baseLocale!, localesPath: d.localesPath });
    useApp.getState().switchTab(id2);
    await useApp.getState().closeProject(); // middle tab: the right neighbour (/p3) takes over
    expect(useApp.getState().tabs.map((t) => t.root)).toEqual(["/p1", "/p3"]);
    expect(useApp.getState().session?.data.root).toBe("/p3");
    await useApp.getState().closeProject(); // last tab: the left neighbour takes over
    expect(useApp.getState().activeId).toBe(id1);
    expect(useApp.getState().session).toBe(s1);
    await useApp.getState().closeProject();
    expect(useApp.getState().activeId).toBeNull();
    expect(useApp.getState().session).toBeNull();
    expect(useApp.getState().tabs).toEqual([]);
  });

  it("ui state is per tab", async () => {
    const { id1, id2 } = await twoProjects();
    useApp.getState().setUi({ page: "languages" });
    useApp.getState().switchTab(id1);
    expect(useApp.getState().ui.page).toBe("translations");
    useApp.getState().switchTab(id2);
    expect(useApp.getState().ui.page).toBe("languages");
  });

  it("+ shows the start screen and keeps the tabs; reopening switches back", async () => {
    const { open, s2, id2 } = await twoProjects();
    useApp.getState().showStart();
    expect(useApp.getState().activeId).toBeNull();
    expect(useApp.getState().session).toBeNull();
    expect(useApp.getState().tabs).toHaveLength(2);
    expect(tab(id2).snap?.session).toBe(s2);
    await open("/p2");
    expect(useApp.getState().session).toBe(s2);
  });
});

describe("close and quit", () => {
  const edit = (id: string, text = "changed") => {
    useApp.getState().switchTab(id);
    const s = useApp.getState().session!;
    s.setText(s.data.keyOrder.find((k) => k === "common::title")!, "th", text);
  };

  it("quit with two dirty tabs asks once and lists both", async () => {
    const { id1, id2 } = await twoProjects();
    edit(id1);
    edit(id2);
    await useApp.getState().requestClose("window");
    expect(useApp.getState().closePrompt).toEqual({ then: "quit", tabs: [id1, id2] });
    expect(exit).not.toHaveBeenCalled();
  });

  it("quit with nothing unsaved quits at once", async () => {
    await twoProjects();
    await useApp.getState().requestClose("window");
    expect(useApp.getState().closePrompt).toBeNull();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("quit Save all saves every dirty tab then exits", async () => {
    const { fs, id1, id2 } = await twoProjects();
    edit(id1, "one");
    edit(id2, "two");
    await useApp.getState().requestClose("window");
    await useApp.getState().answerClosePrompt("save");
    expect(JSON.parse(await fs.readText("/p1/public/locales/th/common.json")).title).toBe("one");
    expect(JSON.parse(await fs.readText("/p2/public/locales/th/common.json")).title).toBe("two");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("quit stops at the first tab that fails to save", async () => {
    const { s2, id1, id2 } = await twoProjects();
    edit(id1);
    useApp.setState({ conflicts: [{ id: "common::title", locale: "th", mine: { kind: "text", text: "W" } }] });
    edit(id2);
    const save2 = vi.spyOn(s2, "save");
    await useApp.getState().requestClose("window");
    await useApp.getState().answerClosePrompt("save");
    expect(exit).not.toHaveBeenCalled();
    expect(useApp.getState().activeId).toBe(id1);
    expect(useApp.getState().error).toBe("Resolve conflicts before saving.");
    expect(save2).not.toHaveBeenCalled();
  });

  it("quit Don't save drops every journal and exits", async () => {
    const { fs, id1, id2 } = await twoProjects();
    vi.useFakeTimers();
    try {
      edit(id1);
      edit(id2);
      await vi.advanceTimersByTimeAsync(1500); // both journals written
    } finally {
      vi.useRealTimers();
    }
    const journals = [journalPath("/appdata", "/p1"), journalPath("/appdata", "/p2")];
    for (const j of journals) expect(await fs.exists(j)).toBe(true);
    await useApp.getState().requestClose("window");
    await useApp.getState().answerClosePrompt("discard");
    for (const j of journals) expect(await fs.exists(j)).toBe(false);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("closing one dirty tab prompts only for that tab", async () => {
    const { id1, id2 } = await twoProjects();
    edit(id1);
    edit(id2);
    await useApp.getState().closeTab(id1);
    expect(useApp.getState().closePrompt).toEqual({ then: "project" });
    expect(useApp.getState().activeId).toBe(id1);
    await useApp.getState().answerClosePrompt("discard");
    expect(useApp.getState().tabs.map((t) => t.id)).toEqual([id2]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("update install asks about every dirty tab", async () => {
    const { id1, id2 } = await twoProjects();
    edit(id1);
    edit(id2);
    const go = useApp.getState().confirmUnsaved();
    expect(useApp.getState().closePrompt).toMatchObject({ then: "proceed", tabs: [id1, id2] });
    await useApp.getState().answerClosePrompt("discard");
    expect(await go).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });

  it("tells Rust when unsaved state flips", async () => {
    const stop = startUnsavedSync();
    try {
      const { id1 } = await twoProjects();
      vi.mocked(invoke).mockClear();
      edit(id1);
      expect(vi.mocked(invoke).mock.calls).toEqual([["set_unsaved", { on: true }]]);
      edit(id1, "again");
      expect(vi.mocked(invoke).mock.calls).toHaveLength(1);
      await useApp.getState().save();
      expect(vi.mocked(invoke).mock.calls).toEqual([["set_unsaved", { on: true }], ["set_unsaved", { on: false }]]);
    } finally {
      stop();
    }
  });
});
