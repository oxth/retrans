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
import { loadFixtureDir, MemoryFs } from "../platform/memory-fs";
import { watchDir } from "../platform/watch";
import { savedBaseLocale, useApp } from "./store";

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
      fire = () => cb(["/project/public/locales/th/common.json"]);
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

describe("review fixes", () => {
  const TH = "/project/public/locales/th/common.json";

  it("#2 duplicate conflicts are upserted per cell (newest wins) and dropped once mine equals disk", async () => {
    const { fs, d, opts } = await prep();
    useApp.setState({ fs });
    let fire!: (paths: string[]) => void;
    watch.mockImplementation(async (_r, cb) => {
      fire = cb;
      return async () => {};
    });
    await useApp.getState().openProject("/project", d, opts);
    const s = useApp.getState().session!;
    s.setText("common::title", "th", "MINE");
    const orig = JSON.parse(await fs.readText(TH));
    await fs.writeTextAtomic(TH, JSON.stringify({ ...orig, title: "T1" }));
    fire([TH]);
    await vi.waitFor(() => expect(useApp.getState().conflicts).toHaveLength(1));
    await fs.writeTextAtomic(TH, JSON.stringify({ ...orig, title: "T2" }));
    fire([TH]);
    await vi.waitFor(() => expect(useApp.getState().conflicts[0]?.theirs).toEqual({ kind: "text", text: "T2" }));
    expect(useApp.getState().conflicts).toHaveLength(1);
    await fs.writeTextAtomic(TH, JSON.stringify({ ...orig, title: "MINE" }));
    fire([TH]);
    await vi.waitFor(() => expect(useApp.getState().conflicts).toEqual([]));
  });

  it("#3 save refuses while conflicts are unresolved", async () => {
    const { fs, d, opts } = await prep();
    useApp.setState({ fs });
    await useApp.getState().openProject("/project", d, opts);
    const s = useApp.getState().session!;
    s.setText("common::title", "th", "MINE");
    useApp.setState({ conflicts: [{ id: "common::title", locale: "th", mine: { kind: "text", text: "MINE" } }] });
    const before = await fs.readText(TH);
    fs.writes.length = 0;
    expect(await useApp.getState().save()).toBe(false);
    expect(useApp.getState().error).toMatch(/Resolve conflicts before saving/);
    expect(fs.writes).toEqual([]);
    expect(await fs.readText(TH)).toBe(before);
  });

  it("#5 watcher events outside the locales dir don't reload", async () => {
    const { fs, d, opts } = await prep();
    useApp.setState({ fs });
    let fire!: (paths: string[]) => void;
    watch.mockImplementation(async (_r, cb) => {
      fire = cb;
      return async () => {};
    });
    await useApp.getState().openProject("/project", d, opts);
    const reload = vi.spyOn(useApp.getState().session!, "reloadFromDisk");
    fire(["/project/src/app.tsx", "/project/.next/x.json"]);
    expect(reload).not.toHaveBeenCalled();
    fire(["/project/public/locales/th/common.json"]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  describe("#6 project overrides", () => {
    const noBase = () =>
      new MemoryFs({
        "/project/public/locales/en/common.json": '{"a":"A"}\n',
        "/project/public/locales/th/common.json": '{"a":"ก"}\n',
      });

    it("a picked base language (detection null) is persisted on open; detected values never are", async () => {
      const fs = noBase();
      useApp.setState({ fs });
      const d = (await detectProject(fs, "/project"))!;
      expect(d.baseLocale).toBeNull();
      await useApp.getState().openProject("/project", d, { baseLocale: "th", localesPath: d.localesPath });
      const st = JSON.parse(await fs.readText("/project/.retrans/state.json"));
      expect(st.project).toEqual({ baseLocale: "th" });
      expect(useApp.getState().session!.isDirty()).toBe(false);
      expect(await savedBaseLocale(fs, "/project", d)).toBe("th");
    });

    it("detected base language wins over a stale state.json value", async () => {
      const { fs, d, opts } = await prep();
      expect(d.baseLocale).toBe("en");
      await fs.writeTextAtomic("/project/.retrans/state.json", JSON.stringify({ version: 1, project: { baseLocale: "th" }, entries: {} }));
      useApp.setState({ fs });
      await useApp.getState().openProject("/project", d, opts);
      expect(useApp.getState().session!.data.baseLocale).toBe("en");
    });

    it("paraglide settings.json baseLocale is never overridden by state.json", async () => {
      const fs = loadFixtureDir(FIX + "paraglide");
      const d = (await detectProject(fs, "/project"))!;
      const other = d.locales.find((l) => l !== d.baseLocale)!;
      await fs.writeTextAtomic("/project/.retrans/state.json", JSON.stringify({ version: 1, project: { baseLocale: other }, entries: {} }));
      useApp.setState({ fs });
      await useApp.getState().openProject("/project", d, { baseLocale: d.baseLocale!, localesPath: d.localesPath });
      expect(useApp.getState().session!.data.baseLocale).toBe(d.baseLocale);
    });

    it("a localesPath override in state.json is honoured", async () => {
      const { fs, d, opts } = await prep();
      await fs.writeTextAtomic("/project/.retrans/state.json", JSON.stringify({ version: 1, project: { localesPath: "public/i18n" }, entries: {} }));
      useApp.setState({ fs });
      await useApp.getState().openProject("/project", d, opts);
      expect(useApp.getState().session!.opts.localesPath).toBe("public/i18n");
      expect(useApp.getState().detected?.localesPath).toBe("public/locales");
    });
  });

  it("#8 save waits for an in-flight journal write before clearing the journal", async () => {
    const { fs, d, opts } = await prep();
    useApp.setState({ fs });
    await useApp.getState().openProject("/project", d, opts);
    const s = useApp.getState().session!;
    const path = journalPath("/appdata", "/project");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = fs.writeTextAtomic.bind(fs);
    let journalStarted = false;
    vi.spyOn(fs, "writeTextAtomic").mockImplementation(async (p, c) => {
      if (p === path) {
        journalStarted = true;
        await gate;
      }
      return real(p, c);
    });
    s.setText("common::title", "th", "X");
    await vi.waitFor(() => expect(journalStarted).toBe(true), { timeout: 3000 });
    setTimeout(release, 50); // the journal write finishes while (or after) save clears the journal
    expect(await useApp.getState().save()).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(await fs.exists(path)).toBe(false);
  });
});

describe("review fixes: malformed state.json", () => {
  it("#4 save writes translations, leaves state.json alone and explains why statuses weren't saved", async () => {
    const { fs, d, opts } = await prep();
    await fs.writeTextAtomic("/project/.retrans/state.json", "<<<<<<< HEAD\n{}\n");
    useApp.setState({ fs });
    await useApp.getState().openProject("/project", d, opts);
    const s = useApp.getState().session!;
    s.markReviewed("common::title", "th");
    expect(await useApp.getState().save()).toBe(false);
    expect(useApp.getState().error).toMatch(/can't be parsed/);
    expect(await fs.readText("/project/.retrans/state.json")).toBe("<<<<<<< HEAD\n{}\n");
  });
});
