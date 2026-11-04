import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {}, save: async () => {} })),
}));
vi.mock("../platform/watch", () => ({ watchDir: vi.fn(async () => async () => {}) }));

import { keyId } from "../core/model";
import { detectProject } from "../formats/detect";
import { openFixtureWorkspace } from "../test/workspace-fixture";
import { AppShell } from "./AppShell";
import { slugKey } from "./FigmaKeyDialogs";
import { useApp } from "./store";

const FIX = resolve(__dirname, "../test/fixtures/figma/ALL");
const ENG = readFileSync(`${FIX}/ENG.tokens.json`, "utf8");
const TH = readFileSync(`${FIX}/TH.tokens.json`, "utf8");
const WARRANTY = keyId("figma-ALL", "ข้อมูลการรับประกัน");

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


async function openWithFigma() {
  const w = await openFixtureWorkspace();
  await w.fs.writeTextAtomic(`${w.root}/design/figma/ALL/ENG.tokens.json`, ENG);
  await w.fs.writeTextAtomic(`${w.root}/design/figma/ALL/TH.tokens.json`, TH);
  w.session.setWorkspaceMeta({ figma: { dir: "design/figma", modes: { ENG: "en", TH: "th" }, vars: {}, baseline: {} } });
  await w.session.save();
  useApp.setState({ fs: w.fs });
  const d = (await detectProject(w.fs, w.root))!;
  await useApp.getState().openProject(w.root, d, { baseLocale: d.baseLocale ?? "th", localesPath: d.localesPath });
  await waitFor(() => expect(useApp.getState().session!.data.keyOrder).toContain(WARRANTY));
  render(<AppShell />);
  return useApp.getState().session!;
}

const rowOf = (key: string) => document.querySelector(`[data-row="${CSS.escape(key)}"]`) as HTMLElement;

beforeEach(async () => {
  await useApp.getState().closeAllTabs();
});
afterEach(cleanup);

describe("Figma rows", () => {
  it('Figma rows show "No code key yet" and the two menu items', async () => {
    await openWithFigma();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "Warranty");
    await waitFor(() => expect(rowOf(WARRANTY)).not.toBeNull());
    const row = rowOf(WARRANTY);
    expect(within(row).getByText("No code key yet")).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "Actions for ข้อมูลการรับประกัน" }));
    expect(within(row).getByRole("menuitem", { name: "Set code key…" })).toBeInTheDocument();
    expect(within(row).getByRole("menuitem", { name: "Link to code key…" })).toBeInTheDocument();
  });

  it("code rows have neither the badge nor the Figma menu items", async () => {
    await openWithFigma();
    const save = keyId("button", "button_save");
    await waitFor(() => expect(rowOf(save)).not.toBeNull());
    const row = rowOf(save);
    expect(within(row).queryByText("No code key yet")).toBeNull();
    await userEvent.click(within(row).getByRole("button", { name: "Actions for button_save" }));
    expect(within(row).queryByRole("menuitem", { name: "Set code key…" })).toBeNull();
  });

  it("Set code key… moves the row", async () => {
    const s = await openWithFigma();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "Warranty");
    await waitFor(() => expect(rowOf(WARRANTY)).not.toBeNull());
    await userEvent.click(within(rowOf(WARRANTY)).getByRole("button", { name: "Actions for ข้อมูลการรับประกัน" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Set code key…" }));
    const dlg = screen.getByRole("dialog", { name: "Set code key" });
    expect(within(dlg).getByLabelText("Code key")).toHaveValue("warranty_info");
    await userEvent.selectOptions(within(dlg).getByLabelText("Group"), "button");
    await userEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    const to = keyId("button", "warranty_info");
    expect(s.data.keyOrder).toContain(to);
    expect(s.data.keyOrder).not.toContain(WARRANTY);
    expect(s.value(to, "en")).toEqual({ kind: "text", text: "Warranty info" });
  });

  it("Link to code key… links and shows differing languages as conflicts", async () => {
    const s = await openWithFigma();
    const save = keyId("button", "button_save");
    s.setText(save, "th", "ข้อมูลการรับประกัน");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "Warranty");
    await waitFor(() => expect(rowOf(WARRANTY)).not.toBeNull());
    await userEvent.click(within(rowOf(WARRANTY)).getByRole("button", { name: "Actions for ข้อมูลการรับประกัน" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Link to code key…" }));
    expect(screen.getByRole("radio", { name: /button::button_save/ })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(s.data.keyOrder).not.toContain(WARRANTY);
    expect(useApp.getState().conflicts).toEqual([
      expect.objectContaining({ id: save, locale: "en", origin: "figma", theirs: { kind: "text", text: "Warranty info" } }),
    ]);
  });

  it("slugKey makes a code-key guess", () => {
    expect(slugKey("Warranty info")).toBe("warranty_info");
    expect(slugKey("  Select Highlight Sensors!! ")).toBe("select_highlight_sensors");
    expect(slugKey("ภาษาไทย")).toBe("");
  });
});
