import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {}, save: async () => {} })),
}));
vi.mock("../platform/watch", () => ({ watchDir: vi.fn(async () => async () => {}) }));

import { journalPath, writeJournal } from "../core/recovery";
import { ProjectSession } from "../core/session";
import { detectProject } from "../formats/detect";
import { loadFixtureDir, MemoryFs } from "../platform/memory-fs";
import { AUTOSAVE_DELAY_MS, startAutosave, useApp } from "./store";

const FIX = resolve(__dirname, "../test/fixtures/next-nested");
const TH = (root: string) => `${root}/public/locales/th/common.json`;
const title = async (fs: MemoryFs, root: string) => JSON.parse(await fs.readText(TH(root))).title;

let stop: () => void;

async function open(fs: MemoryFs, root: string) {
  const d = (await detectProject(fs, root))!;
  await useApp.getState().openProject(root, d, { baseLocale: d.baseLocale!, localesPath: d.localesPath });
  return useApp.getState().session!;
}
const editTitle = (s: ProjectSession, text: string) => s.setText("common::title", "th", text);

beforeEach(async () => {
  await useApp.getState().closeAllTabs();
  vi.useFakeTimers();
  stop = startAutosave();
});
afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe("auto-save", () => {
  it("edits are saved to the files after a pause", async () => {
    const fs = loadFixtureDir(FIX, "/p1");
    useApp.setState({ fs });
    const s = await open(fs, "/p1");
    editTitle(s, "auto");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 100);
    expect(await title(fs, "/p1")).toBe("สวัสดี"); // not yet: still within the pause
    await vi.advanceTimersByTimeAsync(200);
    expect(await title(fs, "/p1")).toBe("auto");
    expect(s.isDirty()).toBe(false);
  });

  it("keeps waiting while edits keep coming", async () => {
    const fs = loadFixtureDir(FIX, "/p1");
    useApp.setState({ fs });
    const s = await open(fs, "/p1");
    const save = vi.spyOn(s, "save");
    for (let i = 0; i < 5; i++) {
      editTitle(s, `v${i}`);
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS / 2);
    }
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(await title(fs, "/p1")).toBe("v4");
  });

  it("a background tab saves too", async () => {
    const fs = new MemoryFs({ ...loadFixtureDir(FIX, "/p1").snapshot(), ...loadFixtureDir(FIX, "/p2").snapshot() });
    useApp.setState({ fs });
    const s1 = await open(fs, "/p1");
    await open(fs, "/p2"); // /p1 is now in the background
    editTitle(s1, "background");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 100);
    expect(await title(fs, "/p1")).toBe("background");
    expect(s1.isDirty()).toBe(false);
  });

  it("waits while the tab has conflicts, without nagging", async () => {
    const fs = loadFixtureDir(FIX, "/p1");
    useApp.setState({ fs });
    const s = await open(fs, "/p1");
    useApp.setState({ conflicts: [{ id: "common::title", locale: "th", mine: { kind: "text", text: "W" } }] });
    editTitle(s, "blocked");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 100);
    expect(await title(fs, "/p1")).toBe("สวัสดี");
    expect(s.isDirty()).toBe(true);
    expect(useApp.getState().error).toBeNull();
    useApp.getState().resolveAllConflicts("mine"); // resolving is an edit: it saves after the pause
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 100);
    expect(s.isDirty()).toBe(false);
  });

  it("edits made during a save are saved after it", async () => {
    const fs = loadFixtureDir(FIX, "/p1");
    useApp.setState({ fs });
    const s = await open(fs, "/p1");
    const real = s.save.bind(s);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const save = vi.spyOn(s, "save").mockImplementationOnce(async () => {
      const r = await real(); // writes "first"…
      await gate; // …and is still in flight when "second" is typed
      return r;
    });
    editTitle(s, "first");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 10); // first save starts and waits
    editTitle(s, "second");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 10); // due while the first is in flight
    release();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 10);
    expect(save).toHaveBeenCalledTimes(2);
    expect(await title(fs, "/p1")).toBe("second");
    expect(s.isDirty()).toBe(false);
  });
});

describe("leftover edits are restored without asking", () => {
  it("a journal left by a crash is applied on open, then saved", async () => {
    const fs = loadFixtureDir(FIX, "/p1");
    useApp.setState({ fs });
    const d = (await detectProject(fs, "/p1"))!;
    const crashed = await ProjectSession.open(fs, "/p1", d, { baseLocale: d.baseLocale!, localesPath: d.localesPath });
    editTitle(crashed, "from journal");
    await writeJournal(fs, journalPath("/appdata", "/p1"), crashed.toJournal());

    const s = await open(fs, "/p1");
    expect(useApp.getState().recovery).toBeNull();
    expect(s.value("common::title", "th")).toEqual({ kind: "text", text: "from journal" });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 100);
    expect(await title(fs, "/p1")).toBe("from journal");
    expect(await fs.exists(journalPath("/appdata", "/p1"))).toBe(false);
  });
});

describe("a save that can't finish", () => {
  it("is not retried until something changes", async () => {
    const fs = loadFixtureDir(FIX, "/p1");
    await fs.writeTextAtomic("/p1/.retrans/state.json", "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> theirs\n");
    useApp.setState({ fs });
    const s = await open(fs, "/p1");
    expect(s.stateMalformed).toBe(true);
    const save = vi.spyOn(s, "save");
    s.markReviewed("common::title", "th");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 6);
    expect(save).toHaveBeenCalledTimes(1);
    expect(s.isDirty()).toBe(true);
    editTitle(s, "new"); // a real edit: try again
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 100);
    expect(save).toHaveBeenCalledTimes(2);
    expect(await title(fs, "/p1")).toBe("new");
  });
});
