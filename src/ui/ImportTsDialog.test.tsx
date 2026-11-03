/**
 * Opening a folder of TypeScript locale modules: the Import dialog, the in-memory workspace it
 * creates, and the first Save. Layout primitives are stubbed as in views.test.tsx.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const pick = vi.hoisted(() => ({ value: "/project" as string | null }));
const prefs = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => pick.value) }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async (k: string) => prefs.get(k),
    set: async (k: string, v: unknown) => void prefs.set(k, v),
    save: async () => {},
  })),
}));
vi.mock("../platform/watch", () => ({ watchDir: vi.fn(async () => async () => {}) }));
vi.mock("../platform/updates", () => ({ checkForUpdate: vi.fn(async () => null) }));
vi.mock("../platform/mt", () => ({
  mtNative: {
    modelsDir: vi.fn(async () => "/models"),
    status: vi.fn(async () => []),
    startDownload: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    deleteModel: vi.fn(async () => {}),
    unload: vi.fn(async () => {}),
    onDownload: vi.fn(async () => () => {}),
  },
  tauriEngine: { generate: vi.fn(), cancel: vi.fn() },
  pickGgufFile: vi.fn(async () => null),
}));

import App from "../App";
import { keyId } from "../core/model";
import { detectProject } from "../formats/detect";
import { loadFixtureDir, MemoryFs } from "../platform/memory-fs";
import { addRecent } from "../platform/prefs";
import { BASELINE_PATH, parseBaseline, parseWorkspaceMeta, WORKSPACE_META_PATH } from "../workspace/meta";
import { useApp } from "./store";

const FIXTURE = resolve(__dirname, "../test/fixtures/ts-locales");
const LOCALES = "src/assets/locales";

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

async function setup(fs: MemoryFs) {
  await useApp.getState().closeProject();
  useApp.setState({ fs });
  return render(<App />);
}

/** Every file under `prefix`, with its text. */
function filesUnder(fs: MemoryFs, prefix: string): Record<string, string> {
  return Object.fromEntries(Object.entries(fs.snapshot()).filter(([p]) => p.startsWith(prefix)));
}

afterEach(cleanup);
beforeEach(() => {
  prefs.clear();
  pick.value = "/project";
});

describe("ImportTsDialog", () => {
  it("shows the fixture's counts and opens the project", async () => {
    await setup(loadFixtureDir(FIXTURE));
    await userEvent.click(screen.getByRole("button", { name: "Open project" }));
    const dlg = await screen.findByRole("dialog", { name: "Import TypeScript translations" });
    expect(dlg).toHaveTextContent("/project/src/assets/locales");
    // change-password.ts, common.ts, button.tsx, dashboardMaguro.tsx (mapLocale.ts and __tests__ ignored)
    expect(dlg).toHaveTextContent("4 files");
    // 4 + 8 + 4 + 3
    expect(dlg).toHaveTextContent("19 keys");
    expect(dlg).toHaveTextContent("2 languages");
    // button_delete, button_reset_password, only_en
    expect(dlg).toHaveTextContent('3 marked "(EN)" (shown as missing)');
    // change_pw
    expect(dlg).toHaveTextContent("1 duplicate keys");
    expect(within(dlg).getByRole("combobox", { name: "Base language" })).toHaveValue("th");
    expect(useApp.getState().session).toBeNull();

    await userEvent.click(within(dlg).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(document.querySelector(`[data-row="${keyId("button", "button_ok")}"]`)).not.toBeNull());
    const s = useApp.getState().session!;
    expect(s.workspace?.source).toEqual({ type: "ts", localesDir: LOCALES });
    expect(s.data.baseLocale).toBe("th");
    expect(s.workspace?.duplicates).toEqual(["change_pw"]);
    expect(s.workspace?.emptyKeys).toEqual([keyId("common", "only_en")]);
    expect(s.workspace?.drafts[keyId("button", "button_reset_password")]).toEqual({ en: "Reset password" });
    expect(s.isDirty()).toBe(true);
    // Nothing written before the first Save.
    expect(await s.fs.exists("/project/.retrans")).toBe(false);
  });

  it("accepts the locales folder itself and keeps the workspace in the project root", async () => {
    pick.value = "/project/src/assets/locales";
    await setup(loadFixtureDir(FIXTURE));
    await userEvent.click(screen.getByRole("button", { name: "Open project" }));
    const dlg = await screen.findByRole("dialog", { name: "Import TypeScript translations" });
    expect(dlg).toHaveTextContent("4 files");
    await userEvent.click(within(dlg).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(useApp.getState().session).not.toBeNull());
    const s = useApp.getState().session!;
    expect(s.data.root).toBe("/project");
    expect(s.workspace?.source).toEqual({ type: "ts", localesDir: LOCALES });
  });

  it("imports a folder of locale modules with no project around it (localesDir \".\")", async () => {
    const fx = loadFixtureDir(FIXTURE);
    const fs = new MemoryFs();
    for (const [p, text] of Object.entries(filesUnder(fx, `/project/${LOCALES}/`))) {
      await fs.writeTextAtomic(p.replace(`/project/${LOCALES}/`, "/loose/"), text);
    }
    pick.value = "/loose";
    await setup(fs);
    await userEvent.click(screen.getByRole("button", { name: "Open project" }));
    const dlg = await screen.findByRole("dialog", { name: "Import TypeScript translations" });
    expect(dlg).toHaveTextContent("4 files");
    await userEvent.click(within(dlg).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(useApp.getState().session).not.toBeNull());
    const s = useApp.getState().session!;
    expect(s.data.root).toBe("/loose");
    expect(s.workspace?.source).toEqual({ type: "ts", localesDir: "." });
    expect(useApp.getState().sourceMissing).toBe(false);
  });

  it("a recent project that was imported but never saved offers the import again", async () => {
    await addRecent({ root: "/project", name: "project", format: "next-i18next" });
    await setup(loadFixtureDir(FIXTURE));
    await userEvent.click(await screen.findByRole("button", { name: /\/project$/ }));
    expect(await screen.findByRole("dialog", { name: "Import TypeScript translations" })).toHaveTextContent("19 keys");
  });

  it("a different base language re-imports with that base", async () => {
    await setup(loadFixtureDir(FIXTURE));
    await userEvent.click(screen.getByRole("button", { name: "Open project" }));
    const dlg = await screen.findByRole("dialog", { name: "Import TypeScript translations" });
    await userEvent.selectOptions(within(dlg).getByRole("combobox", { name: "Base language" }), "en");
    await userEvent.click(within(dlg).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(useApp.getState().session).not.toBeNull());
    expect(useApp.getState().session!.data.baseLocale).toBe("en");
    expect(useApp.getState().session!.data.locales).toEqual(["en", "th"]);
  });

  it("Save after import writes the workspace, meta and baseline, never the TS source", async () => {
    const fs = loadFixtureDir(FIXTURE);
    const before = filesUnder(fs, `/project/${LOCALES}/`);
    expect(Object.keys(before).length).toBeGreaterThan(0);
    await setup(fs);
    await userEvent.click(screen.getByRole("button", { name: "Open project" }));
    const dlg = await screen.findByRole("dialog", { name: "Import TypeScript translations" });
    await userEvent.click(within(dlg).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(useApp.getState().session).not.toBeNull());
    const writesBefore = fs.writes.length;

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(useApp.getState().session!.isDirty()).toBe(false));

    const written = fs.writes.slice(writesBefore);
    expect(written).toContain(`/project/${WORKSPACE_META_PATH}`);
    expect(written).toContain(`/project/${BASELINE_PATH}`);
    for (const f of ["th/button.json", "en/button.json", "th/common.json", "en/common.json", "en/change-password.json"]) {
      expect(written).toContain(`/project/.retrans/workspace/${f}`);
    }
    expect(written.every((p) => p.startsWith("/project/.retrans/"))).toBe(true);
    expect(filesUnder(fs, `/project/${LOCALES}/`)).toEqual(before); // byte compare

    const meta = parseWorkspaceMeta(await fs.readText(`/project/${WORKSPACE_META_PATH}`))!;
    expect(meta.source).toEqual({ type: "ts", localesDir: LOCALES });
    expect(meta.markers[keyId("button", "button_delete")]).toEqual({ en: "ลบ (EN)" });
    expect(parseBaseline(await fs.readText(`/project/${BASELINE_PATH}`))![keyId("button", "button_ok")]).toEqual({ th: "ตกลง", en: "OK" });
    expect(JSON.parse(await fs.readText("/project/.retrans/workspace/en/button.json"))).toEqual({ button_save: "Save", button_ok: "OK" });

    // Reopening finds the workspace, with the empty key still a row.
    const d = (await detectProject(fs, "/project"))!;
    expect(d.workspace).toBeTruthy();
    expect(d.baseLocale).toBe("th");
    cleanup();
    await setup(fs);
    await useApp.getState().openProject("/project", d, { baseLocale: "th", localesPath: d.localesPath });
    await waitFor(() => expect(useApp.getState().session!.data.keyOrder).toContain(keyId("common", "only_en")));
    expect(useApp.getState().conflicts).toEqual([]);
    expect(useApp.getState().session!.isDirty()).toBe(false);
  });
});
