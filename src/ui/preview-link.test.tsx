import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as Array<[string, unknown]>);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    calls.push([cmd, args]);
    return null;
  }),
}));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {}, save: async () => {} })),
}));
vi.mock("../platform/watch", () => ({ watchDir: vi.fn(async () => async () => {}) }));

import { hashValue } from "../core/hash";
import { keyId } from "../core/model";
import { syncFromFigma } from "../figma/sync";
import { liveProjects, onPreviewRequest } from "../platform/preview-link";
import { loadFixtureDir, MemoryFs } from "../platform/memory-fs";
import { detectProject } from "../formats/detect";
import { openFixtureWorkspace } from "../test/workspace-fixture";
import { AppShell } from "./AppShell";
import { useApp } from "./store";

const FIG = resolve(__dirname, "../test/fixtures/figma/ALL");
const NEXT = resolve(__dirname, "../test/fixtures/next-nested");
const WARRANTY = keyId("figma-ALL", "ข้อมูลการรับประกัน");
const SENSOR = keyId("figma-ALL", "เลือกไฮไลต์เซนเซอร์");

/** A Figma-linked workspace (inactive tab) and a plain project (active tab). */
async function twoTabs() {
  const w = await openFixtureWorkspace();
  const dir = `${w.root}/design/figma/ALL`;
  await w.fs.writeTextAtomic(`${dir}/ENG.tokens.json`, readFileSync(`${FIG}/ENG.tokens.json`, "utf8"));
  await w.fs.writeTextAtomic(`${dir}/TH.tokens.json`, readFileSync(`${FIG}/TH.tokens.json`, "utf8"));
  w.session.setWorkspaceMeta({ figma: { dir: "design/figma", modes: { ENG: "en", TH: "th" }, vars: {}, baseline: {} } });
  await syncFromFigma(w.session);
  await w.session.save();
  const fs = new MemoryFs({ ...w.fs.snapshot(), ...loadFixtureDir(NEXT, "/beta").snapshot() });
  useApp.setState({ fs });
  for (const root of [w.root, "/beta"]) {
    const d = (await detectProject(fs, root))!;
    await useApp.getState().openProject(root, d, { baseLocale: d.baseLocale ?? "th", localesPath: d.localesPath });
  }
  const [figma, plain] = useApp.getState().tabs;
  return { figma, plain };
}

const results = (session: { value(k: never, l: string): unknown }, verdicts: Array<[string, "fits" | "too-long"]>) => ({
  retransPreviewResults: 1, sourceProjectId: "x", locale: "en", checkedAt: "x",
  results: verdicts.map(([key, verdict]) => ({
    key, hash: hashValue(session.value(key as never, "en") as never), verdict, flag: null,
  })),
});

beforeEach(async () => {
  calls.length = 0;
  await useApp.getState().closeAllTabs();
});
afterEach(cleanup);

describe("live link wiring", () => {
  it("liveProjects lists tabs by id, inactive ones from their snapshot", async () => {
    const { figma, plain } = await twoTabs();
    const all = liveProjects();
    expect(all.map((p) => p.id)).toEqual([figma.id, plain.id]);
    expect(all[0].name).toBe(figma.name);
  });

  it("answers a projects request with only the Figma one", async () => {
    const { figma } = await twoTabs();
    await onPreviewRequest({ id: 7, kind: "projects", params: {} });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("preview_reply");
    const args = calls[0][1] as { id: number; status: number; body: Array<{ id: string }> };
    expect(args).toMatchObject({ id: 7, status: 200 });
    expect(args.body.map((p) => p.id)).toEqual([figma.id]);
  });

  it("replies 500 instead of leaving the request waiting when answering throws", async () => {
    await onPreviewRequest({ id: 9, kind: "projects" } as never);
    await onPreviewRequest({ id: 10, kind: "bundle" } as never);
    expect(calls).toEqual([
      ["preview_reply", { id: 9, status: 500, body: { error: expect.any(String) } }],
      ["preview_reply", { id: 10, status: 500, body: { error: expect.any(String) } }],
    ]);
  });

  it("brings the app forward, switches tab and shows results; Apply marks and closes", async () => {
    const { figma } = await twoTabs();
    render(<AppShell />);
    const session = useApp.getState().tabs.find((t) => t.id === figma.id)!.snap!.session;
    await act(async () => {
      await onPreviewRequest({
        id: 1, kind: "results", params: { project: figma.id }, body: results(session, [[WARRANTY, "fits"]]),
      });
    });
    expect(calls).toContainEqual(["preview_focus", undefined]);
    expect(calls).toContainEqual(["preview_reply", { id: 1, status: 202, body: {} }]);
    expect(useApp.getState().activeId).toBe(figma.id);
    expect(await screen.findByText("1 fit · 0 too long")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("Added 1 designer verdict. Review and save.");
    expect(useApp.getState().previewResults).toBeNull();
    expect(useApp.getState().session!.fitOf(WARRANTY, "en")?.v).toBe("fits");
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("the applied-verdicts note belongs to its tab", async () => {
    const { figma, plain } = await twoTabs();
    render(<AppShell />);
    const session = useApp.getState().tabs.find((t) => t.id === figma.id)!.snap!.session;
    await act(async () => {
      await onPreviewRequest({
        id: 1, kind: "results", params: { project: figma.id }, body: results(session, [[WARRANTY, "fits"]]),
      });
    });
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("Added 1 designer verdict. Review and save.");

    await act(async () => {
      await useApp.getState().switchTab(plain.id);
    });
    expect(screen.queryByText("Added 1 designer verdict. Review and save.")).toBeNull();

    await act(async () => {
      await useApp.getState().switchTab(figma.id);
    });
    expect(screen.getByText("Added 1 designer verdict. Review and save.")).toBeInTheDocument();
  });

  it("a second results request replaces the open dialog", async () => {
    const { figma } = await twoTabs();
    render(<AppShell />);
    const session = useApp.getState().tabs.find((t) => t.id === figma.id)!.snap!.session;
    const send = (id: number, v: Array<[string, "fits" | "too-long"]>) =>
      act(async () => {
        await onPreviewRequest({ id, kind: "results", params: { project: figma.id }, body: results(session, v) });
      });
    await send(1, [[WARRANTY, "fits"]]);
    expect(await screen.findByText("1 fit · 0 too long")).toBeInTheDocument();
    await send(2, [[WARRANTY, "too-long"], [SENSOR, "too-long"]]);
    await waitFor(() => expect(screen.getByText("0 fit · 2 too long")).toBeInTheDocument());
    expect(screen.queryByText("1 fit · 0 too long")).toBeNull();
  });
});
