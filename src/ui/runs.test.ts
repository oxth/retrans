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
import { loadFixtureDir } from "../platform/memory-fs";
import { cancelRun, clearRun, resetRuns, startRun, useRuns } from "./runs";
import { useApp } from "./store";

const FIX = resolve(__dirname, "../test/fixtures/next-nested");

/** A translate function whose calls wait until the test releases them. */
function gatedTranslate() {
  const pending: Array<(r: TranslateResult) => void> = [];
  const translate = vi.fn(
    (source: string, onRequest: (cancel: () => void) => void) =>
      new Promise<TranslateResult>((res) => {
        onRequest(() => {});
        pending.push(() => res({ ok: true, text: `T:${source}` }));
      }),
  );
  return { translate, pending };
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
    const { translate, pending } = gatedTranslate();
    startRun(id, session, items, target, translate);
    for (let i = 0; i < items.length; i++) {
      await vi.waitFor(() => expect(pending.length).toBe(1));
      pending.shift()!({ ok: true, text: "" }); // the gate answers T:<source>
    }
    await vi.waitFor(() => expect(useRuns.getState().byTab[id]?.kind).toBe("done"));
    expect(session.value(items[0].id, target)).toEqual({ kind: "text", text: `T:${items[0].source}` });
    clearRun(id);
    expect(useRuns.getState().byTab[id]).toBeUndefined();
  });

  it("marks its tab busy while running", async () => {
    const { session, id, target } = await openOne();
    const items = missingItems(session, target, "all").slice(0, 1);
    const { translate, pending } = gatedTranslate();
    startRun(id, session, items, target, translate);
    await vi.waitFor(() => expect(pending.length).toBe(1));
    expect(useApp.getState().tabs[0].busy).toBe(1);
    pending.shift()!({ ok: true, text: "x" });
    await vi.waitFor(() => expect(useRuns.getState().byTab[id]?.kind).toBe("done"));
    expect(useApp.getState().tabs[0].busy).toBe(0);
  });

  it("cancelRun stops the run and cancels the in-flight request", async () => {
    const { session, id, target } = await openOne();
    const items = missingItems(session, target, "all");
    const cancelReq = vi.fn();
    const pending: Array<(r: TranslateResult) => void> = [];
    startRun(id, session, items, target, (_s, onRequest) => {
      onRequest(cancelReq);
      return new Promise((res) => pending.push(res));
    });
    await vi.waitFor(() => expect(pending.length).toBe(1));
    cancelRun(id);
    expect(cancelReq).toHaveBeenCalled();
    pending.shift()!({ ok: true, text: "late" });
    await vi.waitFor(() => expect(useRuns.getState().byTab[id]?.kind).toBe("done"));
    expect(session.value(items[0].id, target)).not.toEqual({ kind: "text", text: "late" });
  });

  it("closing a tab cancels its run", async () => {
    const { session, id, target } = await openOne();
    const items = missingItems(session, target, "all");
    const { translate, pending } = gatedTranslate();
    const setText = vi.spyOn(session, "setText");
    startRun(id, session, items, target, translate);
    await vi.waitFor(() => expect(pending.length).toBe(1));
    await useApp.getState().closeProject();
    pending.shift()!({ ok: true, text: "late" });
    await new Promise((r) => setTimeout(r, 10));
    expect(setText).not.toHaveBeenCalled();
    expect(useRuns.getState().byTab[id]).toBeUndefined();
  });
});
