import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {}, save: async () => {} })),
}));
vi.mock("../platform/watch", () => ({ watchDir: vi.fn(async () => async () => {}) }));

import { detectProject } from "../formats/detect";
import { loadFixtureDir, MemoryFs } from "../platform/memory-fs";
import { AppShell } from "./AppShell";
import { runRedo, runUndo } from "./edit-commands";
import { UNDO_SKIPPED_MESSAGE, useApp } from "./store";

const FIX = resolve(__dirname, "../test/fixtures/next-nested");
const TITLE = "common::title";
const text = (t: string) => ({ kind: "text" as const, text: t });

beforeAll(() => {
  const isRow = (el: Element) => el.hasAttribute("data-index");
  const rect = (el: Element) => (isRow(el) ? { w: 1000, h: 40 } : { w: 1000, h: 1000 });
  HTMLElement.prototype.getBoundingClientRect = function () {
    const { w, h } = rect(this);
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON() {} } as DOMRect;
  };
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return rect(this).h; } });
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get() { return rect(this).h; } });
  Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get() { return rect(this).w; } });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return rect(this).w; } });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});


async function openTwo() {
  const fs = new MemoryFs({ ...loadFixtureDir(FIX, "/p1").snapshot(), ...loadFixtureDir(FIX, "/p2").snapshot() });
  useApp.setState({ fs });
  for (const root of ["/p1", "/p2"]) {
    const d = (await detectProject(fs, root))!;
    await useApp.getState().openProject(root, d, { baseLocale: d.baseLocale!, localesPath: d.localesPath });
  }
  render(<AppShell />);
  return useApp.getState().session!;
}
const key = (k: string, opts: { shift?: boolean; ctrl?: boolean } = {}) =>
  fireEvent.keyDown(window, { key: k, metaKey: !opts.ctrl, ctrlKey: !!opts.ctrl, shiftKey: !!opts.shift });

beforeEach(async () => {
  await useApp.getState().closeAllTabs();
  (document as unknown as { execCommand: (c: string) => boolean }).execCommand = vi.fn(() => true);
});
afterEach(cleanup);

describe("undo / redo in the app", () => {
  it("⌘Z undoes the last cell edit and ⇧⌘Z redoes it", async () => {
    const s = await openTwo();
    act(() => s.setText(TITLE, "th", "แก้"));
    key("z");
    expect(s.value(TITLE, "th")).toEqual(text("สวัสดี"));
    key("z", { shift: true });
    expect(s.value(TITLE, "th")).toEqual(text("แก้"));
  });

  it("Ctrl+Y redoes", async () => {
    const s = await openTwo();
    act(() => s.setText(TITLE, "th", "แก้"));
    key("z", { ctrl: true });
    key("y", { ctrl: true });
    expect(s.value(TITLE, "th")).toEqual(text("แก้"));
  });

  it("Undo in a focused textarea uses the field's own undo", async () => {
    const s = await openTwo();
    act(() => s.setText(TITLE, "th", "แก้"));
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();
    key("z"); // the keyboard path leaves a field to the browser
    expect(s.value(TITLE, "th")).toEqual(text("แก้"));
    runUndo(); // the menu path asks the field to undo
    expect(document.execCommand).toHaveBeenCalledWith("undo");
    runRedo();
    expect(document.execCommand).toHaveBeenCalledWith("redo");
    expect(s.value(TITLE, "th")).toEqual(text("แก้"));
    ta.remove();
  });

  it("undo skipping changed cells shows the message", async () => {
    const s = await openTwo();
    act(() => s.setText(TITLE, "th", "mine"));
    act(() => s.external(() => s.importCell(TITLE, "th", text("from code"), undefined)));
    act(() => useApp.getState().undo());
    expect(useApp.getState().error).toBe(UNDO_SKIPPED_MESSAGE);
    expect(UNDO_SKIPPED_MESSAGE).toBe("Some changes came from your code or Figma since — those weren't undone.");
  });

  it("each tab has its own history", async () => {
    const s2 = await openTwo();
    act(() => s2.setText(TITLE, "th", "two"));
    const [id1] = useApp.getState().tabs.map((t) => t.id);
    act(() => useApp.getState().switchTab(id1));
    const s1 = useApp.getState().session!;
    expect(s1.canUndo).toBe(false);
    act(() => useApp.getState().undo());
    expect(s2.value(TITLE, "th")).toEqual(text("two"));
  });

  it("resolveAllConflicts is one step", async () => {
    const s = await openTwo();
    const ids = ["common::title", "common::nav.home", "common::orphan"];
    act(() => s.batch(() => ids.forEach((id) => s.setText(id, "th", "mine"))));
    useApp.setState({ conflicts: ids.map((id) => ({ id, locale: "th", mine: text("mine"), theirs: text("theirs") })) });
    act(() => useApp.getState().resolveAllConflicts("theirs")); // "theirs" = the value on disk
    expect(ids.every((id) => (s.value(id, "th") as { text: string }).text !== "mine")).toBe(true);
    act(() => useApp.getState().undo());
    expect(ids.every((id) => (s.value(id, "th") as { text: string }).text === "mine")).toBe(true);
  });
});
