import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {}, save: async () => {} })),
}));
vi.mock("../platform/watch", () => ({ watchDir: vi.fn(async () => async () => {}) }));

import { detectProject } from "../formats/detect";
import { missingItems } from "../mt/batch";
import type { TranslateResult } from "../mt/translate";
import type { Translator } from "../mt/translator";
import { loadFixtureDir } from "../platform/memory-fs";
import { cancelRun, clearRun, resetRuns, startRun, useRuns } from "./runs";
import { useApp } from "./store";

const FIX = resolve(__dirname, "../test/fixtures/next-nested");

/**
 * A one-string-at-a-time translator whose calls wait until the test releases them (answering
 * "T:<source>"). Cancel resolves the call in flight as cancelled, like the real ones.
 */
function gatedTranslator() {
  const pending: Array<() => void> = [];
  const cancelled = vi.fn();
  const translator: Translator = {
    label: "Fake",
    remote: false,
    async translate(jobs, _ctx, onResult, signal) {
      for (const job of jobs) {
        if (signal.aborted) return;
        const r = await new Promise<TranslateResult>((res) => {
          pending.push(() => res({ ok: true, text: `T:${job.source}` }));
          signal.addEventListener("abort", () => {
            cancelled();
            res({ ok: false, reason: "cancelled" });
          }, { once: true });
        });
        onResult(job, r);
      }
    },
  };
  return { translator, pending, cancelled };
}

async function openOne() {
  const fs = loadFixtureDir(FIX, "/p1");
  useApp.setState({ fs });
  const d = (await detectProject(fs, "/p1"))!;
  await useApp.getState().openProject("/p1", d, { baseLocale: d.baseLocale!, localesPath: d.localesPath });
  const session = useApp.getState().session!;
  const target = session.data.locales.find((l) => l !== session.data.baseLocale)!;
  return { session, id: useApp.getState().activeId!, target };
}

beforeEach(async () => {
  await useApp.getState().closeAllTabs();
  resetRuns();
});

describe("background Translate missing runs", () => {
  it("a run keeps going after its dialog unmounts", async () => {
    const { session, id, target } = await openOne();
    const items = missingItems(session, target, "all");
    expect(items.length).toBeGreaterThan(0);
    const { translator, pending } = gatedTranslator();
    startRun(id, session, [target], "all", translator);
    for (let i = 0; i < items.length; i++) {
      await vi.waitFor(() => expect(pending.length).toBe(1));
      pending.shift()!();
    }
    await vi.waitFor(() => expect(useRuns.getState().byTab[id]?.kind).toBe("done"));
    expect(session.value(items[0].id, target)).toEqual({ kind: "text", text: `T:${items[0].source}` });
    clearRun(id);
    expect(useRuns.getState().byTab[id]).toBeUndefined();
  });

  it("marks its tab busy while running", async () => {
    const { session, id, target } = await openOne();
    const { translator, pending } = gatedTranslator();
    startRun(id, session, [target], "all", translator);
    await vi.waitFor(() => expect(pending.length).toBe(1));
    expect(useApp.getState().tabs[0].busy).toBe(1);
    while (useRuns.getState().byTab[id]?.kind !== "done") {
      await vi.waitFor(() => expect(pending.length + (useRuns.getState().byTab[id]?.kind === "done" ? 1 : 0)).toBeGreaterThan(0));
      pending.shift()?.();
    }
    expect(useApp.getState().tabs[0].busy).toBe(0);
  });

  it("cancelRun stops the run and cancels the request in flight", async () => {
    const { session, id, target } = await openOne();
    const items = missingItems(session, target, "all");
    const { translator, pending, cancelled } = gatedTranslator();
    startRun(id, session, [target], "all", translator);
    await vi.waitFor(() => expect(pending.length).toBe(1));
    cancelRun(id);
    expect(cancelled).toHaveBeenCalled();
    pending.shift()!(); // a late answer
    await vi.waitFor(() => expect(useRuns.getState().byTab[id]?.kind).toBe("done"));
    expect(session.value(items[0].id, target)).toBeUndefined();
  });

  it("closing a tab cancels its run", async () => {
    const { session, id, target } = await openOne();
    const { translator, pending } = gatedTranslator();
    const setText = vi.spyOn(session, "setText");
    startRun(id, session, [target], "all", translator);
    await vi.waitFor(() => expect(pending.length).toBe(1));
    await useApp.getState().closeProject();
    pending.shift()!();
    await new Promise((r) => setTimeout(r, 10));
    expect(setText).not.toHaveBeenCalled();
    expect(useRuns.getState().byTab[id]).toBeUndefined();
  });
});

describe("undo", () => {
  it("a Translate-missing run is one undo step", async () => {
    const { session, id, target } = await openOne();
    const items = missingItems(session, target, "all").slice(0, 3);
    expect(items.length).toBe(3);
    const t: Translator = {
      label: "Fake",
      remote: false,
      async translate(jobs, _ctx, onResult) {
        for (const job of jobs) onResult(job, { ok: true, text: `T:${job.source}` });
      },
    };
    startRun(id, session, [target], "all", t);
    await vi.waitFor(() => expect(useRuns.getState().byTab[id]?.kind).toBe("done"));
    const all = missingItems(session, target, "all");
    expect(all).toEqual([]);
    session.undo();
    expect(items.every((it) => session.value(it.id, target) === undefined)).toBe(true);
    expect(session.canUndo).toBe(false);
  });
});
