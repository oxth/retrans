import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { resolve } from "node:path";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pick = vi.hoisted(() => ({ value: "/project" as string | null, queue: [] as Array<string | null> }));
const zip = vi.hoisted(() => ({ entries: [] as Array<{ path: string; text: string }>, src: "" }));
const prefs = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => (pick.queue.length ? pick.queue.shift()! : pick.value)),
}));
vi.mock("../platform/zip", () => ({
  zipRead: vi.fn(async (src: string) => {
    zip.src = src;
    return zip.entries;
  }),
}));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async (k: string) => prefs.get(k),
    set: async (k: string, v: unknown) => void prefs.set(k, v),
    save: async () => {},
  })),
}));
vi.mock("../platform/watch", () => ({ watchDir: vi.fn(async () => async () => {}) }));
// No Tauri runtime in tests: stub the update check and the native MT calls App makes on mount.
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
import { journalPath } from "../core/recovery";
import { ProjectSession } from "../core/session";
import { detectProject } from "../formats/detect";
import { MemoryFs, loadFixtureDir } from "../platform/memory-fs";
import { addRecent, getRecent } from "../platform/prefs";
import { useApp } from "./store";

const FIX = resolve(__dirname, "../test/fixtures") + "/";

async function setup(fs: MemoryFs) {
  await useApp.getState().closeProject();
  useApp.setState({ fs });
  return render(<App />);
}

afterEach(cleanup);

beforeEach(() => {
  prefs.clear();
  pick.value = "/project";
  pick.queue = [];
});

describe("StartScreen", () => {
  it("Open shows a detection summary (format, languages, namespaces, key count) before opening", async () => {
    await setup(loadFixtureDir(FIX + "next-nested"));
    await userEvent.click(screen.getByRole("button", { name: "Open project" }));
    const dlg = await screen.findByRole("dialog", { name: "Open project" });
    expect(dlg).toHaveTextContent("next-i18next");
    expect(dlg).toHaveTextContent("en, th");
    expect(dlg).toHaveTextContent("checkout");
    expect(dlg).toHaveTextContent(/\d+ keys/);
    expect(useApp.getState().session).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("button", { name: "Close project" })).toBeInTheDocument();
  });

  it("asks for the base language when detect returns baseLocale null", async () => {
    const fs = new MemoryFs({
      "/project/public/locales/en/common.json": '{"a":"A"}',
      "/project/public/locales/th/common.json": '{"a":"ก"}',
    });
    expect((await detectProject(fs, "/project"))?.baseLocale).toBeNull();
    await setup(fs);
    await userEvent.click(screen.getByRole("button", { name: "Open project" }));
    const open = await screen.findByRole("button", { name: "Open" });
    expect(open).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText(/base language/i), "th");
    expect(open).toBeEnabled();
    await userEvent.click(open);
    await screen.findByRole("button", { name: "Close project" });
    expect(useApp.getState().session!.data.baseLocale).toBe("th");
  });

  it('shows "No next-i18next or Paraglide project found" for an empty folder', async () => {
    await setup(new MemoryFs({ "/project/readme.txt": "x" }));
    await userEvent.click(screen.getByRole("button", { name: "Open project" }));
    expect(await screen.findByText(/No next-i18next or Paraglide project found/)).toBeInTheDocument();
  });

  it("wizard creates a project and opens it", async () => {
    const fs = new MemoryFs();
    await setup(fs);
    pick.value = "/new";
    await userEvent.click(screen.getByRole("button", { name: "New project" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" })); // format: next-i18next
    await userEvent.click(screen.getByRole("radio", { name: /^en\s*English$/ }));
    await userEvent.type(screen.getByLabelText("Search target languages"), "Thai");
    await userEvent.click(screen.getByRole("checkbox", { name: /^th\s*Thai$/ }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByLabelText("Namespace")).toHaveValue("common");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: /Choose folder/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Create project" }));
    await screen.findByRole("button", { name: "Close project" });
    expect(await fs.exists("/new/public/locales/th")).toBe(true);
    expect(useApp.getState().session!.data.locales).toEqual(["en", "th"]);
  });

  it("recent projects list opens on click", async () => {
    const fs = loadFixtureDir(FIX + "next-nested");
    await addRecent({ root: "/project", name: "project", format: "next-i18next" });
    await setup(fs);
    await userEvent.click(await screen.findByRole("button", { name: /^project\// }));
    await screen.findByRole("button", { name: "Close project" });
    expect(useApp.getState().session).not.toBeNull();
  });

  it("offers to restore a recovery journal and applies it", async () => {
    const fs = loadFixtureDir(FIX + "next-nested");
    const d = (await detectProject(fs, "/project"))!;
    const opts = { baseLocale: d.baseLocale!, localesPath: d.localesPath };
    const s = await ProjectSession.open(fs, "/project", d, opts);
    const id = s.data.keyOrder[0];
    s.setText(id, "th", "แก้ไข");
    const j = s.toJournal();
    await fs.writeTextAtomic(journalPath("/appdata", "/project"), JSON.stringify(j));
    await addRecent({ root: "/project", name: "project", format: "next-i18next" });
    await setup(fs);
    await userEvent.click(await screen.findByRole("button", { name: /^project\// }));
    expect(await screen.findByText(/Restore unsaved changes from/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(useApp.getState().session!.isDirty()).toBe(true));
    expect(useApp.getState().recovery).toBeNull();
  });
});

describe("layout", () => {
  it("the app is one window-high column: the update banner can't push it past the window", async () => {
    const { container } = await setup(loadFixtureDir(FIX + "next-nested"));
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(/\bh-screen\b.*\bflex-col\b|\bflex-col\b.*\bh-screen\b/);
    const fills = (el: Element | null) => expect(el?.className).toMatch(/\bflex-1\b.*\bmin-h-0\b|\bmin-h-0\b.*\bflex-1\b/);
    fills(root.lastElementChild);
    await userEvent.click(screen.getByRole("button", { name: "Open project" }));
    await userEvent.click(await screen.findByRole("button", { name: "Open" }));
    await screen.findByRole("button", { name: "Close project" });
    fills(root.firstElementChild);
    expect(container.querySelectorAll(".h-screen, .min-h-screen")).toHaveLength(1);
  });
});

describe("StartScreen review fixes", () => {
  it("#6 a recent project with no detected base language opens with the persisted one", async () => {
    const fs = new MemoryFs({
      "/project/public/locales/en/common.json": '{"a":"A"}',
      "/project/public/locales/th/common.json": '{"a":"ก"}',
      "/project/.retrans/state.json": JSON.stringify({ version: 1, project: { baseLocale: "th" }, entries: {} }),
    });
    await addRecent({ root: "/project", name: "project", format: "next-i18next" });
    await setup(fs);
    await userEvent.click(await screen.findByRole("button", { name: /^project\// }));
    await screen.findByRole("button", { name: "Close project" });
    expect(useApp.getState().session!.data.baseLocale).toBe("th");
  });
});

const pkgEntries = (sourceProjectId = "p") => [
  { path: "public/locales/en/common.json", text: '{"a":"A"}' },
  { path: "public/locales/th/common.json", text: '{"a":"ก"}' },
  {
    path: ".retrans/package.json",
    text: JSON.stringify({
      retransPackage: 1, format: "next-i18next", baseLocale: "en", locales: ["th"], localesPath: "public/locales",
      exportedAt: "2026-11-02T00:00:00.000Z", sourceProjectId, baseline: {},
    }),
  },
];

describe("StartScreen translator package", () => {
  it("re-opening the same zip never overwrites saved work and offers the existing folder", async () => {
    const fs = new MemoryFs({});
    zip.entries = pkgEntries();
    pick.queue = ["/d/shop.zip", "/w"];
    await setup(fs);
    await userEvent.click(screen.getByRole("button", { name: "Open translator package…" }));
    await waitFor(() => expect(useApp.getState().session).not.toBeNull());
    const s = useApp.getState().session!;
    s.setText(s.data.keyOrder[0], "th", "แก้แล้ว");
    expect(await useApp.getState().save()).toBe(true);
    const th = "/w/shop/public/locales/th/common.json";
    expect(await fs.readText(th)).toContain("แก้แล้ว");
    await useApp.getState().closeProject();

    pick.queue = ["/d/shop.zip", "/w"];
    await userEvent.click(await screen.findByRole("button", { name: "Open translator package…" }));
    const dlg = await screen.findByRole("dialog", { name: "Package already open" });
    expect(dlg).toHaveTextContent("This package is already open in /w/shop. Open it?");
    expect(await fs.readText(th)).toContain("แก้แล้ว");
    await userEvent.click(screen.getByRole("button", { name: "Open existing" }));
    await waitFor(() => expect(useApp.getState().session).not.toBeNull());
    const s2 = useApp.getState().session!;
    expect(s2.value(s2.data.keyOrder[0], "th")).toEqual({ kind: "text", text: "แก้แล้ว" });
    expect(await fs.readText(th)).toContain("แก้แล้ว");
  });

  it("refuses a non-empty folder holding another package, writing nothing", async () => {
    const fs = new MemoryFs({ "/w/shop/messages/th.json": '{"a":"x"}' });
    zip.entries = pkgEntries();
    pick.queue = ["/d/shop.zip", "/w"];
    await setup(fs);
    await userEvent.click(screen.getByRole("button", { name: "Open translator package…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose an empty folder.");
    expect(await fs.listFiles("/w/shop", 10)).toEqual(["messages/th.json"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it('a zip named ".zip" extracts into "retrans-package"', async () => {
    const fs = new MemoryFs({});
    zip.entries = pkgEntries();
    pick.queue = ["/d/.zip", "/w"];
    await setup(fs);
    await userEvent.click(screen.getByRole("button", { name: "Open translator package…" }));
    await waitFor(() => expect(useApp.getState().session).not.toBeNull());
    expect(await fs.exists("/w/retrans-package/public/locales/en/common.json")).toBe(true);
  });

  it("extracts the zip next to the chosen folder and opens it", async () => {
    const fs = new MemoryFs({});
    zip.entries = [
      { path: "public/locales/en/common.json", text: '{"a":"A"}' },
      { path: "public/locales/th/common.json", text: '{"a":"ก"}' },
      {
        path: ".retrans/package.json",
        text: JSON.stringify({
          retransPackage: 1, format: "next-i18next", baseLocale: "en", locales: ["th"], localesPath: "public/locales",
          exportedAt: "2026-11-02T00:00:00.000Z", sourceProjectId: "p", baseline: {},
        }),
      },
    ];
    pick.queue = ["/Users/me/Downloads/shop-translation-2026-11-02.zip", "/Users/me/Work"];
    await setup(fs);
    await userEvent.click(screen.getByRole("button", { name: "Open translator package…" }));
    const root = "/Users/me/Work/shop-translation-2026-11-02";
    await waitFor(() => expect(useApp.getState().session).not.toBeNull());
    expect((await getRecent())[0].root).toBe(root);
    expect(zip.src).toBe("/Users/me/Downloads/shop-translation-2026-11-02.zip");
    expect(await fs.exists(root + "/public/locales/en/common.json")).toBe(true);
    expect(useApp.getState().session!.data.baseLocale).toBe("en");
  });

  it("shows the error and writes nothing for a non-package zip", async () => {
    const fs = new MemoryFs({});
    zip.entries = [{ path: "README.txt", text: "x" }];
    pick.queue = ["/d/foo.zip", "/w"];
    await setup(fs);
    await userEvent.click(screen.getByRole("button", { name: "Open translator package…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This file isn't a Retrans package or project.");
    expect(await fs.exists("/w/foo")).toBe(false);
  });
});
