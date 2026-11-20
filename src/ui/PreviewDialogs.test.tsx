import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dlg = vi.hoisted(() => ({ openValue: null as string | null, saveValue: null as string | null, saveArgs: [] as unknown[] }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => dlg.openValue),
  save: vi.fn(async (args: unknown) => {
    dlg.saveArgs.push(args);
    return dlg.saveValue;
  }),
}));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {}, save: async () => {} })),
}));
vi.mock("../platform/watch", () => ({ watchDir: vi.fn(async () => async () => {}) }));

import { hashValue } from "../core/hash";
import { keyId } from "../core/model";
import { syncFromFigma } from "../figma/sync";
import { parseBundle, type PreviewResults, serializePreview } from "../preview/format";
import { openFixtureWorkspace } from "../test/workspace-fixture";
import { FigmaSettings } from "./FigmaSettings";
import { PreviewExportDialog } from "./PreviewDialogs";
import { useApp } from "./store";

const FIX = resolve(__dirname, "../test/fixtures/figma/ALL");
const WARRANTY = keyId("figma-ALL", "ข้อมูลการรับประกัน");
const SENSOR = keyId("figma-ALL", "เลือกไฮไลต์เซนเซอร์");
const SAVE = keyId("button", "button_save");

async function setup() {
  const w = await openFixtureWorkspace();
  const dir = `${w.root}/design/figma/ALL`;
  await w.fs.writeTextAtomic(`${dir}/ENG.tokens.json`, readFileSync(`${FIX}/ENG.tokens.json`, "utf8"));
  await w.fs.writeTextAtomic(`${dir}/TH.tokens.json`, readFileSync(`${FIX}/TH.tokens.json`, "utf8"));
  w.session.setWorkspaceMeta({ figma: { dir: "design/figma", modes: { ENG: "en", TH: "th" }, vars: {}, baseline: {} } });
  await syncFromFigma(w.session);
  w.session.setProjectSetting({ id: "proj-1" });
  useApp.setState({ fs: w.fs });
  return w;
}

beforeEach(() => {
  dlg.openValue = null;
  dlg.saveValue = null;
  dlg.saveArgs = [];
});
afterEach(cleanup);

describe("PreviewExportDialog", () => {
  it("offers target languages only, with reviewed left out by default", async () => {
    const { session } = await setup();
    render(<PreviewExportDialog session={session} onClose={() => {}} />);
    const lang = screen.getByLabelText("Language");
    expect([...(lang as HTMLSelectElement).options].map((o) => o.value)).toEqual(session.data.locales.filter((l) => l !== "th"));
    expect(screen.getByLabelText("Include reviewed translations")).not.toBeChecked();
  });

  it("summarises what goes in and what's left out", async () => {
    const { session } = await setup();
    session.setText(SAVE, "en", "Save");
    session.setComplex(SENSOR, "en", { one: "a", other: "b" });
    render(<PreviewExportDialog session={session} onClose={() => {}} />);
    expect(screen.getByText(/strings · \d+ left out \(no Figma variable: \d+, plural: 1\)/)).toBeInTheDocument();
  });

  it("saves the bundle under a default name", async () => {
    const { session, fs, root } = await setup();
    dlg.saveValue = "/out/fixture-en.retrans-preview.json";
    render(<PreviewExportDialog session={session} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Export…" }));
    await screen.findByText("Saved fixture-en.retrans-preview.json.");
    expect(dlg.saveArgs[0]).toMatchObject({ defaultPath: `${root.split("/").pop()}-en.retrans-preview.json` });
    const parsed = parseBundle(await fs.readText("/out/fixture-en.retrans-preview.json"));
    expect(parsed.ok && parsed.bundle.strings.map((s) => s.key)).toContain(WARRANTY);
  });

  it("disables export when there is nothing to preview", async () => {
    const { session } = await setup();
    for (const id of session.data.keyOrder) if (session.meta(id, "en").status === "translated") session.markReviewed(id, "en");
    render(<PreviewExportDialog session={session} onClose={() => {}} />);
    expect(screen.getByText("Nothing to preview in en: no unreviewed drafts are linked to Figma.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export…" })).toBeDisabled();
  });

  it("with reviewed included, doesn't say 'unreviewed' when there is nothing at all", async () => {
    const { session } = await setup();
    for (const id of session.data.keyOrder) if (id.startsWith("figma-")) session.setText(id, "en", null);
    render(<PreviewExportDialog session={session} onClose={() => {}} />);
    await userEvent.click(screen.getByLabelText("Include reviewed translations"));
    expect(screen.getByText("Nothing to preview in en: no drafts are linked to Figma.")).toBeInTheDocument();
  });
});

describe("Import designer results", () => {
  const results = (session: Awaited<ReturnType<typeof setup>>["session"], patch: Partial<PreviewResults> = {}): PreviewResults => ({
    retransPreviewResults: 1, sourceProjectId: "proj-1", locale: "en", checkedAt: "x",
    results: [
      { key: WARRANTY, hash: hashValue(session.value(WARRANTY, "en")), verdict: "too-long", note: "cut off", flag: "overflow" },
      { key: SENSOR, hash: "stale", verdict: "fits", flag: null },
    ],
    ...patch,
  });

  it("shows counts, then applies the verdicts", async () => {
    const { session, fs } = await setup();
    await fs.writeTextAtomic("/in/r.retrans-results.json", serializePreview(results(session)));
    dlg.openValue = "/in/r.retrans-results.json";
    render(<FigmaSettings session={session} />);
    await userEvent.click(screen.getByRole("button", { name: "Import designer results…" }));
    expect(await screen.findByText("0 fit · 1 too long")).toBeInTheDocument();
    expect(screen.getByText("1 changed since checked (skipped)")).toBeInTheDocument();
    expect(screen.queryByText(/couldn't be read/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("Added 1 designer verdict. Review and save.");
    expect(session.fitOf(WARRANTY, "en")?.v).toBe("too-long");
  });

  it("says how many results in the file couldn't be read", async () => {
    const { session, fs } = await setup();
    const file = results(session);
    await fs.writeTextAtomic("/in/r.json", JSON.stringify({ ...file, results: [...file.results, { key: "x", verdict: "maybe" }] }));
    dlg.openValue = "/in/r.json";
    render(<FigmaSettings session={session} />);
    await userEvent.click(screen.getByRole("button", { name: "Import designer results…" }));
    expect(await screen.findByText("1 couldn't be read (skipped)")).toBeInTheDocument();
  });

  it("warns about results from another project", async () => {
    const { session, fs } = await setup();
    await fs.writeTextAtomic("/in/r.json", serializePreview(results(session, { sourceProjectId: "other" })));
    dlg.openValue = "/in/r.json";
    render(<FigmaSettings session={session} />);
    await userEvent.click(screen.getByRole("button", { name: "Import designer results…" }));
    expect(await screen.findByText(/made for another project/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  });

  it("shows the error for a file that isn't a results file", async () => {
    const { session, fs } = await setup();
    await fs.writeTextAtomic("/in/bad.json", "{nope");
    dlg.openValue = "/in/bad.json";
    render(<FigmaSettings session={session} />);
    await userEvent.click(screen.getByRole("button", { name: "Import designer results…" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/not valid JSON/));
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });
});
