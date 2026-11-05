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
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn(), confirm: vi.fn() }));
vi.mock("../platform/watch", () => ({ watchDir: vi.fn(async () => async () => {}) }));

import { keyId } from "../core/model";
import { ProjectSession } from "../core/session";
import { detectProject } from "../formats/detect";
import type { MtEngine } from "../mt/translate";
import { MemoryFs, loadFixtureDir } from "../platform/memory-fs";
import { AppShell } from "./AppShell";
import { useMt } from "./mt-store";
import { useApp } from "./store";
import { TranslateMissingDialog } from "./TranslateMissingDialog";
import { resetRuns } from "./runs";

const R = "/project";
const FIX = resolve(__dirname, "../test/fixtures") + "/";
const j = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
const c = (k: string) => keyId("common", k);

async function openSession(en: Record<string, unknown> = { a: "A", b: "B", c: "C" }, other: Record<string, unknown> = { x: "X" }) {
  const fs = new MemoryFs({
    [`${R}/public/locales/en/common.json`]: j(en),
    [`${R}/public/locales/en/other.json`]: j(other),
    [`${R}/public/locales/th/common.json`]: j({ b: "บี" }),
    [`${R}/public/locales/th/other.json`]: j({}),
  });
  const d = (await detectProject(fs, R))!;
  return ProjectSession.open(fs, R, d, { baseLocale: "en", localesPath: d.localesPath });
}

const initialMt = useMt.getState();
let generate: ReturnType<typeof vi.fn>;
let cancel: ReturnType<typeof vi.fn>;
/** Echo engine: replies `th:<masked user text>` unless `gen` overrides. */
const userText = (prompt: string) => prompt.split("<|im_start|>user\n")[1].split("<|im_end|>")[0];
function mtOn(gen?: (r: { reqId: number; prompt: string }) => Promise<string>) {
  generate = vi.fn(gen ?? (async (r: { prompt: string }) => `th:${userText(r.prompt)}`));
  cancel = vi.fn(async () => {});
  useMt.setState({
    engine: { generate, cancel } as unknown as MtEngine,
    settings: { enabled: true, modelId: "custom", custom: { path: "/m.gguf", template: "qwen3" }, accepted: [], provider: "local", cloud: {}, acp: null, consent: [], instructions: "" },
    customMissing: false,
  });
}

beforeEach(() => {
  prefs.clear();
  useMt.setState({ ...initialMt }, true);
  resetRuns(); // these sessions have no tab, so their runs share one slot
});
afterEach(cleanup);

describe("TranslateMissingDialog", () => {
  it("counts missing per language and namespace", async () => {
    mtOn();
    const s = await openSession();
    render(<TranslateMissingDialog session={s} onClose={() => {}} defaultLocale="th" />);
    expect(screen.getByText("3 missing")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Namespace"), "other");
    expect(screen.getByText("1 missing")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Namespace"), "common");
    expect(screen.getByText("2 missing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("disables Start when nothing is missing", async () => {
    mtOn();
    const s = await openSession({ b: "B" }, {});
    render(<TranslateMissingDialog session={s} onClose={() => {}} defaultLocale="th" />);
    expect(screen.getByText("0 missing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  });

  it("runs, shows progress, writes machine translations, and summarises", async () => {
    mtOn();
    const s = await openSession();
    const onClose = vi.fn();
    render(<TranslateMissingDialog session={s} onClose={onClose} defaultLocale="th" />);
    await userEvent.selectOptions(screen.getByLabelText("Namespace"), "common");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Translated 2.")).toBeInTheDocument();
    expect(screen.getByText("Machine translations are marked for review.")).toBeInTheDocument();
    expect(s.value(c("a"), "th")).toEqual({ kind: "text", text: "th:A" });
    expect(s.meta(c("a"), "th")).toMatchObject({ status: "translated", machine: true });
    expect(s.value(c("c"), "th")).toEqual({ kind: "text", text: "th:C" });
    expect(s.value(c("b"), "th")).toEqual({ kind: "text", text: "บี" });
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a progress bar, current key and no Close while running", async () => {
    let release!: (t: string) => void;
    let n = 0;
    mtOn(async (r) => (++n === 1 ? `th:${userText(r.prompt)}` : new Promise<string>((res) => (release = res))));
    const s = await openSession();
    render(<TranslateMissingDialog session={s} onClose={() => {}} defaultLocale="th" />);
    await userEvent.selectOptions(screen.getByLabelText("Namespace"), "common");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50"));
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(screen.getByText("c")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    release("th:C");
    expect(await screen.findByText("Translated 2.")).toBeInTheDocument();
  });

  it("cancel stops the batch and keeps finished items", async () => {
    let n = 0;
    mtOn(async (r) => (++n === 1 ? `th:${userText(r.prompt)}` : new Promise<string>((_res, rej) => cancel.mockImplementation(async () => rej(new Error("cancelled"))))));
    const s = await openSession();
    render(<TranslateMissingDialog session={s} onClose={() => {}} defaultLocale="th" />);
    await userEvent.selectOptions(screen.getByLabelText("Namespace"), "common");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledWith(generate.mock.calls[1][0].reqId);
    expect(await screen.findByText(/Stopped\./)).toBeInTheDocument();
    expect(screen.getByText(/Translated 1\./)).toBeInTheDocument();
    expect(s.value(c("a"), "th")).toEqual({ kind: "text", text: "th:A" });
    expect(s.value(c("c"), "th")).toBeUndefined();
  });

  it("shows the first key as soon as the run starts", async () => {
    mtOn(() => new Promise<string>(() => {}));
    const s = await openSession();
    render(<TranslateMissingDialog session={s} onClose={() => {}} defaultLocale="th" />);
    await userEvent.selectOptions(screen.getByLabelText("Namespace"), "common");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("0 of 2")).toBeInTheDocument();
    expect(screen.getByText("a")).toBeInTheDocument();
  });

  it("stops on a model error and shows its message", async () => {
    mtOn(async () => {
      throw new Error("Couldn't load the model file. Is it a llama.cpp GGUF model?");
    });
    const s = await openSession();
    render(<TranslateMissingDialog session={s} onClose={() => {}} defaultLocale="th" />);
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("1 failed.")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load the model file. Is it a llama.cpp GGUF model?")).toBeInTheDocument();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("an unexpected throw still ends in the summary", async () => {
    mtOn(async () => undefined as unknown as string);
    const s = await openSession();
    render(<TranslateMissingDialog session={s} onClose={() => {}} defaultLocale="th" />);
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText(/Translated 0\./)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("unsafe results are listed", async () => {
    mtOn(async () => "รายการ");
    const s = await openSession({ n: "{{count}} items" }, {});
    render(<TranslateMissingDialog session={s} onClose={() => {}} defaultLocale="th" />);
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Translated 0.")).toBeInTheDocument();
    expect(screen.getByText("1 couldn't be translated safely.")).toBeInTheDocument();
    expect(screen.getByText("n")).toBeInTheDocument();
    expect(s.value(c("n"), "th")).toBeUndefined();
  });
});

describe("toolbar button", () => {
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

  async function openApp() {
    const fs = loadFixtureDir(FIX + "next-nested");
    await useApp.getState().closeProject();
    useApp.setState({ fs });
    const d = (await detectProject(fs, R))!;
    await useApp.getState().openProject(R, d, { baseLocale: "en", localesPath: d.localesPath });
    render(<AppShell />);
  }

  it("shows the button only when a model is active, and opens the dialog", async () => {
    await openApp();
    expect(screen.queryByRole("button", { name: "Translate missing…" })).toBeNull();
    cleanup();
    mtOn();
    await openApp();
    await userEvent.click(screen.getByRole("button", { name: "Translate missing…" }));
    expect(screen.getByRole("dialog", { name: "Translate missing" })).toBeInTheDocument();
  });
});
