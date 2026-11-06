import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async (k: string) => prefs.get(k),
    set: async (k: string, v: unknown) => void prefs.set(k, v),
    save: async () => {},
  })),
}));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("../platform/watch", () => ({ watchDir: vi.fn(async () => async () => {}) }));
vi.mock("../platform/mt", () => ({
  mtNative: {
    modelsDir: vi.fn(async () => "/models"), status: vi.fn(async () => []), startDownload: vi.fn(), pause: vi.fn(),
    cancel: vi.fn(), deleteModel: vi.fn(), unload: vi.fn(), onDownload: vi.fn(async () => () => {}),
  },
  tauriEngine: { generate: vi.fn(), cancel: vi.fn() },
  pickGgufFile: vi.fn(),
}));
vi.mock("../platform/tauri-fs", () => ({ tauriFs: { exists: vi.fn(async () => true) } }));

import { ProjectSession } from "../core/session";
import { detectProject } from "../formats/detect";
import { loadFixtureDir } from "../platform/memory-fs";
import { instructionsFor } from "./instructions";
import { useMt } from "./mt-store";
import { SettingsDialog } from "./SettingsDialog";
import { useApp } from "./store";
import { ProjectMtSettings } from "./ProjectMtSettings";
import { MtSettings } from "./MtSettings";

const FIX = resolve(__dirname, "../test/fixtures/next-nested");
const initial = useMt.getState();

async function session() {
  const fs = loadFixtureDir(FIX);
  const d = (await detectProject(fs, "/project"))!;
  const s = await ProjectSession.open(fs, "/project", d, { baseLocale: d.baseLocale!, localesPath: d.localesPath });
  return { fs, s };
}

beforeEach(() => {
  prefs.clear();
  invoke.mockReset();
  useMt.setState({ ...initial, initialized: true, settings: { ...initial.settings, enabled: true } }, true);
});
afterEach(cleanup);

describe("custom instructions", () => {
  it("Instructions for all projects are saved in Settings → AI instructions", async () => {
    useApp.setState({ session: null, prefsOpen: true, prefsSection: "instructions" });
    render(<SettingsDialog />);
    await userEvent.type(screen.getByLabelText("Instructions for all projects"), "Keep it short.");
    await userEvent.tab();
    await waitFor(() => expect(useMt.getState().settings.instructions).toBe("Keep it short."));
  });

  it("TranslateGemma shows the fixed-prompt note", async () => {
    useMt.setState({ settings: { ...useMt.getState().settings, modelId: "custom", custom: { path: "/g.gguf", template: "translategemma" } } });
    useApp.setState({ session: null, prefsOpen: true, prefsSection: "instructions" });
    render(<SettingsDialog />);
    expect(screen.getByText("TranslateGemma uses a fixed prompt and ignores custom instructions.")).toBeInTheDocument();
  });

  it("project and language instructions are saved in .retrans/state.json and combined in order", async () => {
    const { fs, s } = await open();
    useMt.setState({ settings: { ...useMt.getState().settings, instructions: "Keep it short." } });
    render(<ProjectMtSettings session={s} />);
    await userEvent.type(screen.getByLabelText("Instructions for this project"), "Formal Thai.");
    await userEvent.tab();
    await userEvent.type(screen.getByLabelText("Instructions for th"), "Use ครับ.");
    await userEvent.tab();
    await s.save();
    const state = JSON.parse(await fs.readText("/project/.retrans/state.json"));
    expect(state.project.instructions).toEqual({ all: "Formal Thai.", byLocale: { th: "Use ครับ." } });
    expect(instructionsFor(s)("th")).toBe("Keep it short.\n\nFormal Thai.\n\nUse ครับ.");
    expect(instructionsFor(s)("en")).toBe("Keep it short.\n\nFormal Thai.");
  });

  it("the project provider override is saved in .retrans/state.json", async () => {
    const { fs, s } = await open();
    render(<ProjectMtSettings session={s} />);
    await userEvent.selectOptions(screen.getByLabelText("Translation provider for this project"), "Claude (Anthropic)");
    await s.save();
    expect(JSON.parse(await fs.readText("/project/.retrans/state.json")).project.mtProvider).toBe("anthropic");
  });

  it("Test this model shows the instructions sent", async () => {
    useMt.setState({
      settings: {
        ...useMt.getState().settings, provider: "openai", consent: ["openai"], cloud: { openai: { model: "gpt-x" } }, instructions: "Keep it short.",
      },
    });
    invoke.mockImplementation(async (cmd: string, a: { req?: { user: string } }) => {
      if (cmd === "secret_has") return true;
      if (cmd === "mt_cloud_models") return ["gpt-x"];
      if (cmd === "mt_cloud_chat") {
        const req = JSON.parse(a.req!.user);
        return JSON.stringify({ [req.strings[0].id]: { [req.targets[0]]: "สวัสดี" } });
      }
    });
    render(<MtSettings session={null} />);
    await userEvent.type(screen.getByLabelText("Test text"), "Hello");
    await userEvent.click(screen.getByRole("button", { name: "Test this model" }));
    expect(await screen.findByText("สวัสดี")).toBeInTheDocument();
    expect(screen.getByLabelText("Sent to the provider").textContent).toContain("Keep it short.");
  });
});

async function open() {
  return session();
}
