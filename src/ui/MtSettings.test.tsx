import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async (k: string) => prefs.get(k),
    set: async (k: string, v: unknown) => void prefs.set(k, v),
    save: async () => {},
  })),
}));
const native = vi.hoisted(() => ({
  modelsDir: vi.fn(),
  status: vi.fn(),
  startDownload: vi.fn(),
  pause: vi.fn(),
  cancel: vi.fn(),
  deleteModel: vi.fn(),
  unload: vi.fn(),
  onDownload: vi.fn(),
}));
const pick = vi.hoisted(() => vi.fn());
const openUrl = vi.hoisted(() => vi.fn());
vi.mock("../platform/mt", () => ({ mtNative: native, tauriEngine: { generate: vi.fn(), cancel: vi.fn() }, pickGgufFile: pick }));
vi.mock("../platform/tauri-fs", () => ({ tauriFs: { exists: vi.fn(async () => true) } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { findModel } from "../mt/catalog";
import type { ProjectSession } from "../core/session";
import { MtSettings } from "./MtSettings";
import { useMt } from "./mt-store";

const GEMMA = "translategemma-4b-it-Q4_K_M.gguf";
const initial = useMt.getState();
const session = (format: "next-i18next" | "paraglide" = "next-i18next") =>
  ({ data: { format, baseLocale: "en", locales: ["en", "th", "de"] } }) as unknown as ProjectSession;
const generate = vi.fn();

function seed(patch: Partial<ReturnType<typeof useMt.getState>> = {}) {
  useMt.setState({
    ...initial,
    initialized: true,
    modelsDir: "/data/models",
    engine: { generate, cancel: vi.fn() },
    ...patch,
    settings: { enabled: true, modelId: null, custom: null, accepted: [], provider: "local", cloud: {}, acp: null, consent: [], instructions: "", ...(patch.settings ?? {}) },
  } as never, true);
}
const card = (name: string) => screen.getByRole("group", { name });

beforeEach(() => {
  prefs.clear();
  Object.values(native).forEach((f) => f.mockReset());
  pick.mockReset();
  openUrl.mockReset();
  openUrl.mockResolvedValue(undefined);
  generate.mockReset();
  native.modelsDir.mockResolvedValue("/data/models");
  native.status.mockResolvedValue([]);
  native.startDownload.mockResolvedValue(undefined);
  native.unload.mockResolvedValue(undefined);
  native.deleteModel.mockResolvedValue(undefined);
  native.pause.mockResolvedValue(undefined);
  native.cancel.mockResolvedValue(undefined);
  native.onDownload.mockResolvedValue(() => {});
});
afterEach(cleanup);

describe("MtSettings", () => {
  it("shows only the toggle while disabled", async () => {
    seed({ settings: { enabled: false } as never });
    render(<MtSettings session={session()} />);
    expect(screen.getByRole("checkbox", { name: "Enable machine translation" })).not.toBeChecked();
    expect(screen.getByText("Runs on your computer. Nothing is downloaded until you turn this on and pick a model.")).toBeInTheDocument();
    expect(screen.queryByText("TranslateGemma 4B")).toBeNull();
    await userEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(screen.getByText("TranslateGemma 4B")).toBeInTheDocument());
    expect(useMt.getState().settings.enabled).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(useMt.getState().settings.enabled).toBe(true));
  });

  it("shows size, RAM, languages and license before download", async () => {
    seed();
    render(<MtSettings session={session()} />);
    const c = within(card("TranslateGemma 4B"));
    expect(c.getByText("Download: 2.49 GB")).toBeInTheDocument();
    expect(c.getByText("RAM: 8–16 GB")).toBeInTheDocument();
    expect(c.getByText(/Languages: 55 languages/)).toBeInTheDocument();
    expect(c.getByText("Recommended")).toBeInTheDocument();
    await userEvent.click(c.getByRole("link", { name: "Gemma Terms of Use" }));
    expect(openUrl).toHaveBeenCalledWith(expect.stringContaining("ai.google.dev"));
    expect(screen.getByText("Use my own GGUF file")).toBeInTheDocument();
  });

  it("Gemma download goes through Accept & download", async () => {
    seed();
    render(<MtSettings session={session()} />);
    await userEvent.click(within(card("TranslateGemma 4B")).getByRole("button", { name: "Download" }));
    const d = screen.getByRole("dialog");
    expect(within(d).getByText(/made by Google and released under the Gemma Terms of Use/)).toBeInTheDocument();
    expect(within(d).getByRole("link", { name: /Prohibited Use Policy/ })).toBeInTheDocument();
    expect(native.startDownload).not.toHaveBeenCalled();
    await userEvent.click(within(d).getByRole("button", { name: "Accept & download" }));
    await waitFor(() => expect(native.startDownload).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Cancel in the license dialog downloads nothing", async () => {
    seed();
    render(<MtSettings session={session()} />);
    await userEvent.click(within(card("TranslateGemma 4B")).getByRole("button", { name: "Download" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(native.startDownload).not.toHaveBeenCalled();
  });

  it("Qwen downloads without a license dialog", async () => {
    seed();
    render(<MtSettings session={session()} />);
    await userEvent.click(within(card("Qwen3 1.7B")).getByRole("button", { name: "Download" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(native.startDownload).toHaveBeenCalledTimes(1));
  });

  it("shows progress with pause and cancel", async () => {
    const id = "translategemma-4b";
    seed({ settings: { accepted: [id] } as never, downloads: { [id]: { received: 50, total: 100, state: "progress" } } });
    render(<MtSettings session={session()} />);
    const c = within(card("TranslateGemma 4B"));
    expect(c.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    await userEvent.click(c.getByRole("button", { name: "Pause" }));
    expect(native.pause).toHaveBeenCalledWith(id);
    await userEvent.click(c.getByRole("button", { name: "Cancel" }));
    expect(native.cancel).toHaveBeenCalledWith(id, GEMMA);
  });

  it("offers Resume and Cancel for a partial file that is not running", () => {
    seed({ files: { [GEMMA]: { size: 10, complete: false } } });
    render(<MtSettings session={session()} />);
    const c = within(card("TranslateGemma 4B"));
    expect(c.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(c.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(c.queryByRole("button", { name: "Download" })).toBeNull();
  });

  it("shows the error message with Retry", () => {
    seed({ downloads: { "qwen3-1.7b": { received: 0, total: 0, state: "error", message: "Disk full" } } });
    render(<MtSettings session={session()} />);
    const c = within(card("Qwen3 1.7B"));
    expect(c.getByText("Disk full")).toBeInTheDocument();
    expect(c.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("complete model can be selected and deleted", async () => {
    seed({ files: { [GEMMA]: { size: 2489909312, complete: true } } });
    render(<MtSettings session={session()} />);
    const c = within(card("TranslateGemma 4B"));
    await userEvent.click(c.getByRole("radio", { name: "Use this model" }));
    expect(c.getByRole("radio", { name: "Use this model" })).toBeChecked();
    expect(useMt.getState().settings.modelId).toBeNull(); // not until Save
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(useMt.getState().settings.modelId).toBe("translategemma-4b"));
    expect(screen.getByText("Space used: 2.49 GB")).toBeInTheDocument();
  });

  it("Delete model asks for confirmation first", async () => {
    seed({ files: { [GEMMA]: { size: 2489909312, complete: true } } });
    render(<MtSettings session={session()} />);
    const c = within(card("TranslateGemma 4B"));
    await userEvent.click(c.getByRole("button", { name: "Delete model" }));
    let d = screen.getByRole("dialog");
    expect(within(d).getByText("Delete TranslateGemma 4B? You'll need to download it again (2.49 GB) to use it.")).toBeInTheDocument();
    await userEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(native.deleteModel).not.toHaveBeenCalled();
    await userEvent.click(c.getByRole("button", { name: "Delete model" }));
    d = screen.getByRole("dialog");
    await userEvent.click(within(d).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(native.deleteModel).toHaveBeenCalledWith(GEMMA));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a paused download offers Resume and Cancel after its file is re-read", async () => {
    let emit: (e: unknown) => void = () => {};
    native.onDownload.mockImplementation(async (cb) => {
      emit = cb;
      return () => {};
    });
    seed({ initialized: false, settings: { accepted: ["translategemma-4b"] } as never });
    prefs.set("mt", { enabled: true, modelId: null, custom: null, accepted: ["translategemma-4b"] });
    render(<MtSettings session={session()} />);
    await waitFor(() => expect(native.onDownload).toHaveBeenCalled());
    const c = within(card("TranslateGemma 4B"));
    act(() => emit({ id: "translategemma-4b", state: "progress", received: 5, total: 10 }));
    expect(c.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    native.status.mockResolvedValue([{ file: GEMMA, size: 5, complete: false }]);
    act(() => emit({ id: "translategemma-4b", state: "paused", received: 5, total: 10 }));
    expect(await c.findByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(c.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("custom GGUF: choose file, prompt style, missing file", async () => {
    seed();
    pick.mockResolvedValue("/x/my.gguf");
    render(<MtSettings session={session()} />);
    await userEvent.selectOptions(screen.getByLabelText("Prompt style"), "translategemma");
    await userEvent.click(screen.getByRole("button", { name: "Choose file…" }));
    expect(await screen.findByText("/x/my.gguf")).toBeInTheDocument();
    expect(useMt.getState().settings.custom).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(useMt.getState().settings.custom).toEqual({ path: "/x/my.gguf", template: "translategemma" }));
    expect(useMt.getState().settings.modelId).toBe("custom");
    useMt.setState({ customMissing: true });
    expect(await screen.findByText("File not found")).toBeInTheDocument();
  });

  it("test panel shows the translation or the unsafe message", async () => {
    const file = findModel("qwen3-1.7b")!.file;
    seed({ settings: { modelId: "qwen3-1.7b" } as never, files: { [file]: { size: 1, complete: true } } });
    render(<MtSettings session={session()} />);
    const box = screen.getByRole("textbox", { name: "Text to translate" });
    expect(box).toHaveValue("Welcome back, {{name}}! You have new messages.");
    expect(screen.getByRole("combobox", { name: "Target language" })).toHaveValue("th");
    generate.mockResolvedValueOnce("สวัสดี [[0]]! คุณมีข้อความใหม่");
    await userEvent.click(screen.getByRole("button", { name: "Translate" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("สวัสดี {{name}}! คุณมีข้อความใหม่"));
    generate.mockResolvedValueOnce("สวัสดี! คุณมีข้อความใหม่");
    await userEvent.click(screen.getByRole("button", { name: "Translate" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Couldn't translate safely"));
    generate.mockRejectedValueOnce(new Error("boom"));
    await userEvent.click(screen.getByRole("button", { name: "Translate" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("boom"));
  });

  it("test panel is hidden without a model; Paraglide prefill uses single braces", () => {
    seed();
    const { unmount } = render(<MtSettings session={session("paraglide")} />);
    expect(screen.queryByRole("button", { name: "Translate" })).toBeNull();
    unmount();
    const file = findModel("qwen3-1.7b")!.file;
    seed({ settings: { modelId: "qwen3-1.7b" } as never, files: { [file]: { size: 1, complete: true } } });
    render(<MtSettings session={session("paraglide")} />);
    expect(screen.getByRole("textbox", { name: "Text to translate" })).toHaveValue("Welcome back, {name}! You have new messages.");
  });

  it("test panel: From/To default to the project's languages and are sent to the model", async () => {
    const file = findModel("qwen3-1.7b")!.file;
    seed({ settings: { modelId: "qwen3-1.7b" } as never, files: { [file]: { size: 1, complete: true } } });
    render(<MtSettings session={session()} />);
    expect(screen.getByRole("combobox", { name: "Source language" })).toHaveValue("en");
    expect(screen.getByRole("combobox", { name: "Target language" })).toHaveValue("th");
    expect(screen.getByText("English")).toBeInTheDocument();
    expect(screen.getByText("Thai")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Swap languages" }));
    expect(screen.getByRole("combobox", { name: "Source language" })).toHaveValue("th");
    expect(screen.getByRole("combobox", { name: "Target language" })).toHaveValue("en");
    generate.mockResolvedValueOnce("Hi [[0]]");
    await userEvent.click(screen.getByRole("button", { name: "Translate" }));
    await waitFor(() => expect(generate).toHaveBeenCalled());
    const prompt = JSON.stringify(generate.mock.calls[generate.mock.calls.length - 1]);
    expect(prompt).toContain("from Thai (th) to English (en)");
  });

  it("test panel: the same language twice is blocked, and an unchanged reply is called out", async () => {
    const file = findModel("qwen3-1.7b")!.file;
    seed({ settings: { modelId: "qwen3-1.7b" } as never, files: { [file]: { size: 1, complete: true } } });
    render(<MtSettings session={session()} />);
    const to = screen.getByRole("combobox", { name: "Target language" });
    await userEvent.clear(to);
    await userEvent.type(to, "en");
    expect(screen.getByText("Pick two different languages: the text would come back unchanged.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Translate" })).toBeDisabled();
    await userEvent.clear(to);
    await userEvent.type(to, "th");
    generate.mockResolvedValueOnce("Welcome back, [[0]]! You have new messages.");
    await userEvent.click(screen.getByRole("button", { name: "Translate" }));
    expect(await screen.findByText(/The model returned the text unchanged/)).toBeInTheDocument();
  });
});
