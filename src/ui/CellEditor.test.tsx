/**
* jsdom has no layout, so @tanstack/react-virtual would see a 0px viewport and render nothing.
 * We stub `getBoundingClientRect`/`offset*`/`client*` sizes: row
 * elements (those with data-index) measure 40px tall, every other element is a 1000x1000
 * viewport. We also stub ResizeObserver (absent in jsdom). The tests then run against a real
 * ProjectSession over MemoryFs fixtures; only the layout primitives are faked.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { ProjectSession } from "../core/session";
import { detectProject } from "../formats/detect";
import { MemoryFs, loadFixtureDir } from "../platform/memory-fs";
import { AppShell } from "./AppShell";
import { useApp } from "./store";

const FIX = resolve(__dirname, "../test/fixtures") + "/";

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

async function open(fs: MemoryFs, root = "/project"): Promise<ProjectSession> {
  await useApp.getState().closeProject();
  useApp.setState({ fs });
  const d = (await detectProject(fs, root))!;
  await useApp.getState().openProject(root, d, { baseLocale: d.baseLocale ?? "en", localesPath: d.localesPath });
  render(<AppShell />);
  return useApp.getState().session!;
}
const nested = () => loadFixtureDir(FIX + "next-nested");

beforeEach(() => prefs.clear());
afterEach(cleanup);


const cell = (id: string, locale: string) => document.querySelector(`[data-row="${id}"] [data-locale="${locale}"]`) as HTMLElement;
const editor = () => screen.getByRole("textbox", { name: /^Edit / }) as HTMLTextAreaElement;

describe("editing", () => {
  it("Enter commits via setText", async () => {
    const s = await open(nested());
    await userEvent.click(cell("common::only_en", "th"));
    await userEvent.type(editor(), "แค่อังกฤษ{Enter}");
    expect(s.value("common::only_en", "th")).toEqual({ kind: "text", text: "แค่อังกฤษ" });
    expect(s.meta("common::only_en", "th").status).toBe("translated");
    expect(screen.queryByRole("textbox", { name: /^Edit / })).toBeNull();
  });

  it("Shift+Enter inserts newline", async () => {
    const s = await open(nested());
    await userEvent.click(cell("common::only_en", "th"));
    await userEvent.type(editor(), "a{Shift>}{Enter}{/Shift}b");
    expect(editor().value).toBe("a\nb");
    await userEvent.keyboard("{Enter}");
    expect(s.value("common::only_en", "th")).toEqual({ kind: "text", text: "a\nb" });
  });

  it("Esc cancels without change", async () => {
    const s = await open(nested());
    await userEvent.click(cell("common::title", "th"));
    await userEvent.clear(editor());
    await userEvent.type(editor(), "zzz{Escape}");
    expect(screen.queryByRole("textbox", { name: /^Edit / })).toBeNull();
    expect(s.value("common::title", "th")).toEqual({ kind: "text", text: "สวัสดี" });
  });

  it("committing the same text is a no-op", async () => {
    const s = await open(nested());
    const spy = vi.spyOn(s, "setText");
    await userEvent.click(cell("common::title", "th"));
    await userEvent.keyboard("{Enter}");
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: /^Edit / })).toBeNull();
  });

  it("Tab commits and focuses next missing cell (wraps)", async () => {
    const s = await open(nested());
    const missing = [...document.querySelectorAll('[data-locale="th"] ')]
      .filter((e) => e.getAttribute("data-cell") === "missing")
      .map((e) => e.closest("[data-row]")!.getAttribute("data-row")!);
    expect(missing.length).toBe(6);
    const last = missing[missing.length - 1];
    await userEvent.click(cell(last, "th"));
    await userEvent.type(editor(), "x{Tab}");
    expect(s.value(last, "th")).toEqual({ kind: "text", text: "x" });
    // wrapped to the first missing cell
    await waitFor(() => expect(editor()).toBeInTheDocument());
    expect(editor().closest("[data-row]")!.getAttribute("data-row")).toBe(missing[0]);
    expect(document.activeElement).toBe(editor());
    await userEvent.type(editor(), "y{Tab}");
    expect(s.value(missing[0], "th")).toEqual({ kind: "text", text: "y" });
    expect(editor().closest("[data-row]")!.getAttribute("data-row")).toBe(missing[1]);
  });

  it('committing "" clears to untranslated', async () => {
    const s = await open(nested());
    await userEvent.click(cell("common::title", "th"));
    await userEvent.clear(editor());
    await userEvent.keyboard("{Enter}");
    expect(s.value("common::title", "th")).toBeUndefined();
    expect(s.meta("common::title", "th").status).toBe("untranslated");
    expect(cell("common::title", "th").getAttribute("data-cell")).toBe("missing");
  });

  it("editing a reviewed cell turns it yellow", async () => {
    const s = await open(nested());
    s.markReviewed("common::title", "th");
    await waitFor(() => expect(cell("common::title", "th").querySelector("[data-status]")!.getAttribute("data-status")).toBe("reviewed"));
    await userEvent.click(cell("common::title", "th"));
    await userEvent.type(editor(), "!{Enter}");
    expect(s.meta("common::title", "th").status).toBe("translated");
    await waitFor(() => expect(cell("common::title", "th").querySelector("[data-status]")!.getAttribute("data-status")).toBe("translated"));
  });

  it("Cmd+Shift+R marks the edited cell reviewed", async () => {
    const s = await open(nested());
    await userEvent.click(cell("common::title", "th"));
    await userEvent.keyboard("{Meta>}{Shift>}r{/Shift}{/Meta}");
    expect(s.meta("common::title", "th").status).toBe("reviewed");
  });

  it("not-applicable plural cells are not editable", async () => {
    await open(nested());
    await userEvent.click(cell("common::items_one", "th"));
    expect(screen.queryByRole("textbox", { name: /^Edit / })).toBeNull();
  });

  it("complex editor rejects invalid JSON with an inline error", async () => {
    const s = await open(loadFixtureDir(FIX + "paraglide"));
    const before = s.value("::download", "en");
    expect(before?.kind).toBe("complex");
    await userEvent.click(cell("::download", "en"));
    expect(JSON.parse(editor().value)).toEqual((before as { raw: unknown }).raw);
    await userEvent.clear(editor());
    await userEvent.paste("not json");
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText("Must be valid JSON array")).toBeInTheDocument();
    expect(s.value("::download", "en")).toEqual(before);
    await userEvent.clear(editor());
    await userEvent.paste('{"a":1}');
    await userEvent.keyboard("{Enter}");
    expect(screen.getByText("Must be valid JSON array")).toBeInTheDocument();
    await userEvent.clear(editor());
    await userEvent.paste('[{"match":{"*":"ok"}}]');
    await userEvent.keyboard("{Enter}");
    expect(s.value("::download", "en")).toEqual({ kind: "complex", raw: [{ match: { "*": "ok" } }] });
  });

  it("shows an inline error and stays open when the session throws", async () => {
    const s = await open(nested());
    vi.spyOn(s, "setText").mockImplementation(() => {
      throw new Error("file is read-only");
    });
    await userEvent.click(cell("common::title", "th"));
    await userEvent.type(editor(), "q{Enter}");
    expect(await screen.findByText(/file is read-only/)).toBeInTheDocument();
    expect(editor()).toBeInTheDocument();
  });

  it("typing then clicking another cell saves the first", async () => {
    const s = await open(nested());
    await userEvent.click(cell("common::only_en", "th"));
    await userEvent.type(editor(), "kept");
    await userEvent.click(cell("common::title", "th"));
    expect(s.value("common::only_en", "th")).toEqual({ kind: "text", text: "kept" });
    expect(editor().closest("[data-row]")!.getAttribute("data-row")).toBe("common::title");
  });

  it("typing then blur saves", async () => {
    const s = await open(nested());
    await userEvent.click(cell("common::only_en", "th"));
    await userEvent.type(editor(), "blurred");
    fireEvent.blur(editor());
    expect(s.value("common::only_en", "th")).toEqual({ kind: "text", text: "blurred" });
  });

  it("typing then Esc does not save (and returns focus to the cell)", async () => {
    const s = await open(nested());
    await userEvent.click(cell("common::only_en", "th"));
    await userEvent.type(editor(), "nope{Escape}");
    expect(s.value("common::only_en", "th")).toBeUndefined();
    await waitFor(() => expect(document.activeElement).toBe(cell("common::only_en", "th")));
  });

  it("editing row filtered out by search still saves", async () => {
    const s = await open(nested());
    await userEvent.click(cell("common::only_en", "th"));
    await userEvent.type(editor(), "survives");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nav.home" } });
    await waitFor(() => expect(document.querySelector('[data-row="common::only_en"]')).toBeNull());
    expect(s.value("common::only_en", "th")).toEqual({ kind: "text", text: "survives" });
  });

  it("Enter during IME composition does not commit", async () => {
    const s = await open(nested());
    await userEvent.click(cell("common::only_en", "th"));
    await userEvent.type(editor(), "ก");
    fireEvent.keyDown(editor(), { key: "Enter", keyCode: 229 });
    expect(s.value("common::only_en", "th")).toBeUndefined();
    fireEvent.compositionStart(editor());
    fireEvent.keyDown(editor(), { key: "Enter", keyCode: 13 });
    expect(s.value("common::only_en", "th")).toBeUndefined();
    fireEvent.compositionEnd(editor());
    fireEvent.keyDown(editor(), { key: "Enter", keyCode: 13 });
    expect(s.value("common::only_en", "th")).toEqual({ kind: "text", text: "ก" });
  });

  it("Shift+Tab commits and closes", async () => {
    const s = await open(nested());
    await userEvent.click(cell("common::only_en", "th"));
    await userEvent.type(editor(), "z{Shift>}{Tab}{/Shift}");
    expect(s.value("common::only_en", "th")).toEqual({ kind: "text", text: "z" });
    expect(screen.queryByRole("textbox", { name: /^Edit / })).toBeNull();
  });
});
