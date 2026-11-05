import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pick = vi.hoisted(() => ({ value: null as string[] | null }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => pick.value) }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {}, save: async () => {} })),
}));
vi.mock("../platform/watch", () => ({ watchDir: vi.fn(async () => async () => {}) }));

import { keyId } from "../core/model";
import { ProjectSession } from "../core/session";
import { detectProject } from "../formats/detect";
import { loadFixtureDir } from "../platform/memory-fs";
import { openFixtureWorkspace } from "../test/workspace-fixture";
import { FigmaImportDialog } from "./FigmaImportDialog";
import { FigmaSettings } from "./FigmaSettings";
import { useApp } from "./store";

const FIX = resolve(__dirname, "../test/fixtures/figma/ALL");
const ENG = readFileSync(`${FIX}/ENG.tokens.json`, "utf8");
const TH = readFileSync(`${FIX}/TH.tokens.json`, "utf8");
const DL = "/Users/someone/Downloads/ALL (1)";

async function workspace() {
  const w = await openFixtureWorkspace();
  await w.fs.writeTextAtomic(`${DL}/ENG.tokens.json`, ENG);
  await w.fs.writeTextAtomic(`${DL}/TH.tokens.json`, TH);
  useApp.setState({ fs: w.fs });
  const d = (await detectProject(w.fs, w.root))!;
  await useApp.getState().openProject(w.root, d, { baseLocale: d.baseLocale ?? "th", localesPath: d.localesPath });
  return { ...w, session: useApp.getState().session! };
}

beforeEach(async () => {
  await useApp.getState().closeAllTabs();
  pick.value = null;
});
afterEach(cleanup);

describe("Import Figma files", () => {
  it("import copies the files into design/figma/<collection> and maps suggested modes", async () => {
    const w = await workspace();
    pick.value = [`${DL}/ENG.tokens.json`, `${DL}/TH.tokens.json`];
    const onClose = vi.fn();
    render(<FigmaImportDialog session={w.session} onClose={onClose} />);
    expect(await screen.findByLabelText("Collection")).toHaveValue("ALL");
    expect(screen.getByLabelText("Language for ENG")).toHaveValue("en");
    expect(screen.getByLabelText("Language for TH")).toHaveValue("th");
    await userEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(await w.fs.readText(`${w.root}/design/figma/ALL/ENG.tokens.json`)).toBe(ENG);
    expect(await w.fs.readText(`${w.root}/design/figma/ALL/TH.tokens.json`)).toBe(TH);
    expect(w.session.workspace!.figma).toMatchObject({ dir: "design/figma", modes: { ENG: "en", TH: "th" } });
    await waitFor(() => expect(w.session.data.keyOrder).toContain(keyId("figma-ALL", "ข้อมูลการรับประกัน")));
  });

  it('the collection name drops " (1)"', async () => {
    const w = await workspace();
    pick.value = [`${DL}/ENG.tokens.json`];
    render(<FigmaImportDialog session={w.session} onClose={() => {}} />);
    expect(await screen.findByLabelText("Collection")).toHaveValue("ALL");
  });

  it("two files with the same mode are refused", async () => {
    const w = await workspace();
    await w.fs.writeTextAtomic(`${DL}/ENG copy.tokens.json`, ENG);
    pick.value = [`${DL}/ENG.tokens.json`, `${DL}/ENG copy.tokens.json`];
    render(<FigmaImportDialog session={w.session} onClose={() => {}} />);
    expect(await screen.findByText("Two files are for mode ENG.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  });

  it("a file that isn't a Figma Variables export is refused", async () => {
    const w = await workspace();
    await w.fs.writeTextAtomic(`${DL}/notes.json`, "{ nope");
    pick.value = [`${DL}/notes.json`];
    render(<FigmaImportDialog session={w.session} onClose={() => {}} />);
    expect(await screen.findByText("notes.json isn't a Figma Variables export.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  });

  it("cancelling the file picker closes the dialog", async () => {
    const w = await workspace();
    const onClose = vi.fn();
    render(<FigmaImportDialog session={w.session} onClose={onClose} />);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe("Settings → Figma", () => {
  it("changing a mode's language re-syncs", async () => {
    const w = await workspace();
    await w.fs.writeTextAtomic(`${w.root}/design/figma/ALL/ENG.tokens.json`, ENG);
    await w.fs.writeTextAtomic(`${w.root}/design/figma/ALL/TH.tokens.json`, TH);
    w.session.setWorkspaceMeta({ figma: { dir: "design/figma", modes: { TH: "th" }, vars: {}, baseline: {} } });
    render(<FigmaSettings session={w.session} />);
    const eng = await screen.findByLabelText("Language for ENG");
    expect(eng).toHaveValue("");
    await userEvent.selectOptions(eng, "en");
    expect(w.session.workspace!.figma!.modes).toEqual({ TH: "th", ENG: "en" });
    await waitFor(() =>
      expect(w.session.value(keyId("figma-ALL", "ข้อมูลการรับประกัน"), "en")).toEqual({ kind: "text", text: "Warranty info" }),
    );
  });

  it("the folder must stay inside the project", async () => {
    const w = await workspace();
    render(<FigmaSettings session={w.session} />);
    const dir = screen.getByLabelText("Figma folder");
    await userEvent.clear(dir);
    await userEvent.type(dir, "../outside");
    await userEvent.click(screen.getByRole("button", { name: "Save folder" }));
    expect(screen.getByText("The folder must be inside the project.")).toBeInTheDocument();
    expect(w.session.workspace!.figma).toBeUndefined();
  });

  it("Figma section is hidden for non-workspace projects", async () => {
    const fs = loadFixtureDir(resolve(__dirname, "../test/fixtures/next-nested"));
    const d = (await detectProject(fs, "/project"))!;
    const s = await ProjectSession.open(fs, "/project", d, { baseLocale: d.baseLocale!, localesPath: d.localesPath });
    const { container } = render(<FigmaSettings session={s} />);
    expect(container).toBeEmptyDOMElement();
  });
});
