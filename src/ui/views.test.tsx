/**
* jsdom has no layout, so @tanstack/react-virtual would see a 0px viewport and render nothing.
 * We stub `getBoundingClientRect`/`offset*`/`client*` sizes: row
 * elements (those with data-index) measure 40px tall, every other element is a 1000x1000
 * viewport. We also stub ResizeObserver (absent in jsdom). The tests then run against a real
 * ProjectSession over MemoryFs fixtures; only the layout primitives are faked.
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

describe("views", () => {
  it("toggle switches between list and table and persists per project", async () => {
    await open(nested());
    expect(screen.getByTestId("list-scroll")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "table" }));
    expect(screen.getByTestId("table-scroll")).toBeInTheDocument();
    expect(screen.queryByTestId("list-scroll")).toBeNull();
    await waitFor(() => expect((prefs.get("viewMode") as Record<string, string>)["/project"]).toBe("table"));
    // reopening restores the saved mode
    cleanup();
    await open(nested());
    expect(await screen.findByTestId("table-scroll")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "list" }));
    await waitFor(() => expect((prefs.get("viewMode") as Record<string, string>)["/project"]).toBe("list"));
  });

  it("missing chip count equals rows with missing cells and filters on click", async () => {
    await open(nested());
    // th missing: nav.about, items_other, lit.a.b, only_en, checkout pay + total (items_one is not used in th)
    const chip = screen.getByRole("button", { name: /^Missing \(\d+\)$/ });
    expect(chip).toHaveTextContent(/Missing\s*6/);
    expect(document.querySelectorAll("[data-row]").length).toBe(10);
    await userEvent.click(chip);
    expect(document.querySelectorAll("[data-row]").length).toBe(6);
    expect(screen.queryByText("Hello")).toBeNull();
    expect(screen.getByRole("button", { name: /^Missing \(6\)$/ })).toHaveAttribute("aria-pressed", "true");
  });

  it('missing cells render "Missing" and plural non-applicable cells render "not used"', async () => {
    await open(nested());
    const only = document.querySelector('[data-row="common::only_en"]') as HTMLElement;
    expect(within(only).getByText(/Missing — click to translate/)).toBeInTheDocument();
    const one = document.querySelector('[data-row="common::items_one"]') as HTMLElement;
    expect(within(one).getByText("not used in th")).toBeInTheDocument();
    expect(within(one).getByText("plural · one")).toBeInTheDocument();
  });

  it("clicking a yellow dot marks reviewed (green)", async () => {
    const s = await open(nested());
    const row = document.querySelector('[data-row="common::title"]') as HTMLElement;
    expect(row.querySelector("[data-status]")!.getAttribute("data-status")).toBe("translated");
    expect(s.meta("common::title", "th").status).toBe("translated");
    await userEvent.click(within(row).getByRole("button", { name: /Mark reviewed/ }));
    expect(s.meta("common::title", "th").status).toBe("reviewed");
    await waitFor(() => expect(row.querySelector("[data-status]")!.getAttribute("data-status")).toBe("reviewed"));
    expect(within(row).queryByRole("button", { name: /Mark reviewed/ })).toBeNull();
  });

  it("a translated cell has a labelled Review button and an explained status", async () => {
    await open(nested());
    const row = document.querySelector('[data-row="common::title"]') as HTMLElement;
    const btn = within(row).getByRole("button", { name: /Mark reviewed/ });
    expect(btn).toHaveTextContent("Review");
    expect(within(row).getByLabelText(/Status: Translated, not reviewed yet/)).toBeInTheDocument();
  });

  it("a cell whose base text changed says Source changed and is cleared by Review", async () => {
    const s = await open(nested());
    act(() => {
      s.markReviewed("common::title", "th");
      s.setText("common::title", "en", "A brand new title");
    });
    const row = document.querySelector('[data-row="common::title"]') as HTMLElement;
    await waitFor(() => expect(within(row).getByText("Source changed")).toBeInTheDocument());
    expect(s.meta("common::title", "th").needsReview).toBe(true);
    await userEvent.click(within(row).getByRole("button", { name: /Mark reviewed/ }));
    expect(s.meta("common::title", "th")).toMatchObject({ status: "reviewed", needsReview: false });
    await waitFor(() => expect(within(row).queryByText("Source changed")).toBeNull());
  });

  it("the sidebar explains the status dots and how to review", async () => {
    await open(nested());
    const legend = screen.getByRole("region", { name: "Status key" });
    for (const t of ["Missing", "Not reviewed", "Reviewed", "Source changed"]) expect(within(legend).getByText(t)).toBeInTheDocument();
    expect(legend).toHaveTextContent(/⌘⇧R/);
  });

  it("the cell editor shows its keys, including mark reviewed", async () => {
    await open(nested());
    const row = document.querySelector('[data-row="common::title"]') as HTMLElement;
    await userEvent.click(row.querySelector('[data-cell="value"][data-locale="th"]') as HTMLElement);
    expect(within(row).getByTestId("editor-keys")).toHaveTextContent(/Save & mark reviewed/);
  });

  it("placeholder warning shows names", async () => {
    await open(
      new MemoryFs({
        "/project/public/locales/en/common.json": '{"a":"Hi {{name}}"}',
        "/project/public/locales/th/common.json": '{"a":"สวัสดี {{who}}"}',
      }),
    );
    const w = await screen.findAllByRole("img", { name: /placeholders/ });
    expect(w[0].getAttribute("title")).toMatch(/Missing placeholders: name/);
    expect(w[0].getAttribute("title")).toMatch(/Extra placeholders: who/);
  });

  it("sidebar bars reflect stats", async () => {
    const s = await open(nested());
    const st = s.stats();
    for (const [l, { done, total }] of st) {
      const bar = screen.getByRole("progressbar", { name: `${l} completion` });
      expect(bar).toHaveAttribute("aria-valuenow", String(Math.round((done / total) * 100)));
    }
    expect(screen.getByRole("progressbar", { name: "th completion" })).toHaveAttribute("data-tone", "amber");
    expect(screen.getByRole("progressbar", { name: "en completion" })).toHaveAttribute("data-tone", "green");
  });
});

describe("tabs", () => {
  it("filters and page survive switching tabs", async () => {
    await useApp.getState().closeAllTabs();
    const fs = new MemoryFs({ ...loadFixtureDir(FIX + "next-nested", "/p1").snapshot(), ...loadFixtureDir(FIX + "next-nested", "/p2").snapshot() });
    useApp.setState({ fs });
    for (const root of ["/p1", "/p2"]) {
      const d = (await detectProject(fs, root))!;
      await useApp.getState().openProject(root, d, { baseLocale: d.baseLocale ?? "en", localesPath: d.localesPath });
    }
    function Active() {
      const id = useApp((s) => s.activeId);
      return <AppShell key={id ?? "start"} />;
    }
    render(<Active />);
    const [id1, id2] = useApp.getState().tabs.map((t) => t.id);
    await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "nav");
    act(() => useApp.getState().switchTab(id1));
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("");
    act(() => useApp.getState().switchTab(id2));
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("nav");
    await useApp.getState().closeAllTabs();
  });
});
