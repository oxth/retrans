import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => new Map<string, unknown>());
const store = vi.hoisted(() => ({ failSave: false }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async (k: string) => prefs.get(k),
    set: async (k: string, v: unknown) => void prefs.set(k, v),
    save: async () => {
      if (store.failSave) throw new Error("disk full");
    },
  })),
}));
vi.mock("../platform/watch", () => ({ watchDir: vi.fn() }));

import { journalPath } from "../core/recovery";
import { ProjectSession } from "../core/session";
import { detectProject } from "../formats/detect";
import { loadFixtureDir } from "../platform/memory-fs";
import { watchDir } from "../platform/watch";
import { useApp } from "./store";

const FIX = resolve(__dirname, "../test/fixtures") + "/";
const watch = vi.mocked(watchDir);

async function prep() {
  const fs = loadFixtureDir(FIX + "next-nested");
  const d = (await detectProject(fs, "/project"))!;
  return { fs, d, opts: { baseLocale: d.baseLocale!, localesPath: d.localesPath } };
}

beforeEach(async () => {
  await useApp.getState().closeProject();
  prefs.clear();
  store.failSave = false;
  watch.mockReset();
  watch.mockImplementation(async () => async () => {});
});

describe("store open/close", () => {
  it("overlapping opens: only the second session is subscribed and watched", async () => {
    const { fs, d, opts } = await prep();
    useApp.setState({ fs });
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    watch.mockImplementation(async () => {
      const stop = vi.fn(async () => {});
      stops.push(stop);
      if (stops.length === 1) await gate; // first watch resolves late
      return stop;
    });
    const subscribe = vi.spyOn(ProjectSession.prototype, "subscribe");
    const p1 = useApp.getState().openProject("/project", d, opts);
    await vi.waitFor(() => expect(stops.length).toBe(1));
    const p2 = useApp.getState().openProject("/project", d, opts);
    await p2;
    release();
    await p1;
    expect(stops[0]).toHaveBeenCalled(); // stale watcher stopped
    expect(stops[1]).not.toHaveBeenCalled();
    const live = useApp.getState().session!;
    const unsub = subscribe.mock.results.map((r) => r.value as () => void);
    expect(unsub.length).toBe(2);
    const v = useApp.getState().version;
    live.addNamespace("zzz");
    expect(useApp.getState().version).toBeGreaterThan(v);
    subscribe.mockRestore();
  });

  it("closeProject during open leaves no live watcher", async () => {
    const { fs, d, opts } = await prep();
    useApp.setState({ fs });
    const stop = vi.fn(async () => {});
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    watch.mockImplementation(async () => {
      await gate;
      return stop;
    });
    const p = useApp.getState().openProject("/project", d, opts);
    await vi.waitFor(() => expect(watch).toHaveBeenCalled());
    await useApp.getState().closeProject();
    release();
    await p;
    expect(stop).toHaveBeenCalled();
    expect(useApp.getState().session).toBeNull();
  });

  it("watcher reload errors land in store.error", async () => {
    const { fs, d, opts } = await prep();
    useApp.setState({ fs });
    let fire!: () => void;
    watch.mockImplementation(async (_r, cb) => {
      fire = () => cb([]);
      return async () => {};
    });
    await useApp.getState().openProject("/project", d, opts);
    vi.spyOn(useApp.getState().session!, "reloadFromDisk").mockRejectedValue(new Error("boom"));
    fire();
    await vi.waitFor(() => expect(useApp.getState().error).toMatch(/boom/));
  });

  it("restore with a mismatched journal root surfaces an error and clears the journal", async () => {
    const { fs, d, opts } = await prep();
    useApp.setState({ fs });
    const s = await ProjectSession.open(fs, "/project", d, opts);
    s.setText(s.data.keyOrder[0], "th", "x");
    const path = journalPath("/appdata", "/project");
    await fs.writeTextAtomic(path, JSON.stringify({ ...s.toJournal(), root: "/other" }));
    await useApp.getState().openProject("/project", d, opts);
    expect(useApp.getState().recovery).not.toBeNull();
    await useApp.getState().restoreRecovery();
    expect(useApp.getState().error).toMatch(/does not match/);
    expect(useApp.getState().recovery).toBeNull();
    expect(await fs.exists(path)).toBe(false);
  });

  it("addRecent and watcher failures do not fail the open", async () => {
    const { fs, d, opts } = await prep();
    useApp.setState({ fs });
    store.failSave = true;
    watch.mockRejectedValue(new Error("no watch"));
    await useApp.getState().openProject("/project", d, opts);
    expect(useApp.getState().session).not.toBeNull();
    expect(useApp.getState().error).toMatch(/no watch/);
  });
});
