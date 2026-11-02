/** Layout stubs and project setup mirror CellEditor.test.tsx; only the MT engine is faked. */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

import type { ProjectSession } from "../core/session";
import { detectProject } from "../formats/detect";
import type { MtEngine } from "../mt/translate";
import { MemoryFs, loadFixtureDir } from "../platform/memory-fs";
import { AppShell } from "./AppShell";
import { useMt } from "./mt-store";
import { clearSuggestionCache } from "./Suggestion";
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
const cell = (id: string, locale: string) => document.querySelector(`[data-row="${id}"] [data-locale="${locale}"]`) as HTMLElement;
const editor = () => screen.getByRole("textbox", { name: /^Edit / }) as HTMLTextAreaElement;
const noEditor = () => expect(screen.queryByRole("textbox", { name: /^Edit / })).toBeNull();

const initialMt = useMt.getState();
let generate: ReturnType<typeof vi.fn>;
let cancel: ReturnType<typeof vi.fn>;
function mtOn(gen?: (r: { reqId: number; prompt: string }) => Promise<string>) {
  generate = vi.fn(gen ?? (async () => "สวัสดี"));
  cancel = vi.fn(async () => {});
  useMt.setState({
    engine: { generate, cancel } as unknown as MtEngine,
    settings: { enabled: true, modelId: "custom", custom: { path: "/m.gguf", template: "qwen3" }, accepted: [] },
    customMissing: false,
  });
}

beforeEach(() => {
  prefs.clear();
  clearSuggestionCache();
  useMt.setState({ ...initialMt }, true);
});
afterEach(cleanup);

describe("suggestions", () => {
  it("shows a suggestion for a missing cell and accepts it with Ctrl+Enter", async () => {
    mtOn();
    const s = await open(nested());
    await userEvent.click(cell("common::only_en", "th"));
    expect(await screen.findByText("Suggestion: สวัสดี")).toBeInTheDocument();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(s.value("common::only_en", "th")).toEqual({ kind: "text", text: "สวัสดี" });
    expect(s.meta("common::only_en", "th").machine).toBe(true);
    expect(s.meta("common::only_en", "th").status).toBe("translated");
    noEditor();
  });

  it("Accept button commits as machine without a blur commit of the draft", async () => {
    mtOn();
    const s = await open(nested());
    const spy = vi.spyOn(s, "setText");
    await userEvent.click(cell("common::only_en", "th"));
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    expect(s.value("common::only_en", "th")).toEqual({ kind: "text", text: "สวัสดี" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("common::only_en", "th", "สวัสดี", { machine: true });
    noEditor();
  });

  it("typing hides the suggestion and Cmd+Enter saves the typed text", async () => {
    mtOn();
    const s = await open(nested());
    await userEvent.click(cell("common::only_en", "th"));
    expect(await screen.findByText("Suggestion: สวัสดี")).toBeInTheDocument();
    await userEvent.type(editor(), "abc");
    expect(screen.queryByTestId("suggestion")).toBeNull();
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    expect(s.value("common::only_en", "th")).toEqual({ kind: "text", text: "abc" });
    expect(s.meta("common::only_en", "th").machine).toBe(false);
    noEditor();
  });

  it("typing then undoing back to the initial text shows the suggestion again", async () => {
    mtOn();
    await open(nested());
    await userEvent.click(cell("common::only_en", "th"));
    expect(await screen.findByText("Suggestion: สวัสดี")).toBeInTheDocument();
    await userEvent.type(editor(), "a");
    expect(screen.queryByTestId("suggestion")).toBeNull();
    await userEvent.type(editor(), "{Backspace}");
    expect(screen.getByText("Suggestion: สวัสดี")).toBeInTheDocument();
  });

  it("Cmd+Enter while loading commits the typed draft like Enter", async () => {
    mtOn(() => new Promise<string>(() => {}));
    const s = await open(nested());
    await userEvent.click(cell("common::only_en", "th"));
    expect(await screen.findByText("Translating…")).toBeInTheDocument();
    await userEvent.type(editor(), "mine");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(s.value("common::only_en", "th")).toEqual({ kind: "text", text: "mine" });
    expect(s.meta("common::only_en", "th").machine).toBe(false);
    noEditor();
  });

  it("Cmd+Shift+Enter does not accept the suggestion", async () => {
    mtOn();
    const s = await open(nested());
    await userEvent.click(cell("common::only_en", "th"));
    expect(await screen.findByText("Suggestion: สวัสดี")).toBeInTheDocument();
    await userEvent.keyboard("{Meta>}{Shift>}{Enter}{/Shift}{/Meta}");
    expect(s.value("common::only_en", "th")).toBeUndefined();
  });

  it("no suggestion for translated cells, the base locale, complex values, or when MT is off", async () => {
    mtOn();
    await open(nested());
    await userEvent.click(cell("common::title", "th"));
    expect(editor()).toBeInTheDocument();
    expect(screen.queryByTestId("suggestion")).toBeNull();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(cell("common::title", "en"));
    expect(screen.queryByTestId("suggestion")).toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(generate).not.toHaveBeenCalled();
    cleanup();

    await open(loadFixtureDir(FIX + "paraglide"));
    await userEvent.click(cell("::download", "th"));
    expect(editor()).toBeInTheDocument();
    expect(screen.queryByTestId("suggestion")).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    cleanup();

    useMt.setState({ ...initialMt }, true);
    await open(nested());
    await userEvent.click(cell("common::only_en", "th"));
    expect(editor()).toBeInTheDocument();
    expect(screen.queryByTestId("suggestion")).toBeNull();
  });

  it("unsafe output shows the message and Ctrl+Enter only commits the unchanged draft", async () => {
    mtOn(async () => "รายการ");
    const s = await open(nested());
    const spy = vi.spyOn(s, "setText");
    await userEvent.click(cell("common::items_other", "th"));
    expect(await screen.findByText("Couldn't translate safely")).toBeInTheDocument();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(s.value("common::items_other", "th")).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    noEditor();
  });

  it("leaving the cell cancels the request and the late result never appears", async () => {
    let resolveA!: (t: string) => void;
    let n = 0;
    mtOn(() => (++n === 1 ? new Promise<string>((r) => (resolveA = r)) : new Promise<string>(() => {})));
    await open(nested());
    await userEvent.click(cell("common::only_en", "th"));
    expect(await screen.findByText("Translating…")).toBeInTheDocument();
    const reqA = generate.mock.calls[0][0].reqId;
    await userEvent.keyboard("{Escape}");
    expect(cancel).toHaveBeenCalledWith(reqA);
    resolveA("ผิดเซลล์");
    await userEvent.click(cell("common::nav.about", "th"));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(generate.mock.calls[1][0].reqId).not.toBe(reqA);
    expect(screen.getByText("Translating…")).toBeInTheDocument();
    expect(screen.queryByText(/ผิดเซลล์/)).toBeNull();
  });

  it("cached suggestion shows instantly on reopen", async () => {
    mtOn();
    await open(nested());
    await userEvent.click(cell("common::only_en", "th"));
    expect(await screen.findByText("Suggestion: สวัสดี")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(cell("common::only_en", "th"));
    expect(screen.getByText("Suggestion: สวัสดี")).toBeInTheDocument();
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
