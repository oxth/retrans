/**
 * The tour over a real AppShell on the sample project. Layout is stubbed the way views.test.tsx
 * does it (jsdom has none), so the virtualized grid renders its rows and every stop can find
 * its control: a renamed or removed control fails here instead of silently dropping a stop.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

import { detectProject } from "../formats/detect";
import { MemoryFs } from "../platform/memory-fs";
import { createSampleProject } from "../workspace/sample";
import { AppShell } from "./AppShell";
import { ProjectTour, STOPS } from "./ProjectTour";
import { useApp } from "./store";
import { TabBar } from "./TabBar";

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

const ROOT = "/docs/Retrans/Sample project";

async function openSample(page?: "share" | "languages") {
  await useApp.getState().closeProject();
  const fs = new MemoryFs();
  await createSampleProject(fs, ROOT);
  useApp.setState({ fs, projectTourOpen: true });
  const d = (await detectProject(fs, ROOT))!;
  await useApp.getState().openProject(ROOT, d, { baseLocale: "en", localesPath: d.localesPath });
  if (page) useApp.getState().setUi({ page });
  render(<><TabBar /><AppShell /><ProjectTour /></>);
  return screen.findByRole("dialog", { name: "Tour" });
}

beforeEach(() => prefs.clear());
afterEach(cleanup);

describe("ProjectTour", () => {
  it("finds every stop's control and walks them with Next and Back", async () => {
    const tour = await openSample();
    expect(tour).toHaveTextContent(`1 of ${STOPS.length}`);
    expect(tour).toHaveTextContent(STOPS[0].title);
    await userEvent.click(within(tour).getByRole("button", { name: "Next" }));
    expect(tour).toHaveTextContent(STOPS[1].title);
    await userEvent.click(within(tour).getByRole("button", { name: "Back" }));
    expect(tour).toHaveTextContent(STOPS[0].title);
    for (let i = 1; i < STOPS.length; i++) await userEvent.click(within(tour).getByRole("button", { name: "Next" }));
    expect(tour).toHaveTextContent(`${STOPS.length} of ${STOPS.length}`);
    await userEvent.click(within(tour).getByRole("button", { name: "Done" }));
    expect(useApp.getState().projectTourOpen).toBe(false);
    await waitFor(() => expect(prefs.get("projectTourSeen")).toBe(true));
  });

  it("with no AI set up, the AI stop points at Settings and says how to turn it on", async () => {
    const tour = await openSample();
    const ai = STOPS.findIndex((s) => s.fallback);
    for (let i = 0; i < ai; i++) await userEvent.click(within(tour).getByRole("button", { name: "Next" }));
    expect(tour).toHaveTextContent(STOPS[ai].fallback!.title);
  });

  it("arrow keys move, Escape closes", async () => {
    const tour = await openSample();
    await userEvent.keyboard("{ArrowRight}");
    expect(tour).toHaveTextContent(STOPS[1].title);
    await userEvent.keyboard("{ArrowLeft}");
    expect(tour).toHaveTextContent(STOPS[0].title);
    await userEvent.keyboard("{Escape}");
    expect(useApp.getState().projectTourOpen).toBe(false);
  });

  it("goes back to the Translations page first", async () => {
    const tour = await openSample("share");
    expect(useApp.getState().ui.page).toBe("translations");
    expect(tour).toHaveTextContent(`1 of ${STOPS.length}`);
  });
});
