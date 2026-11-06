import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../platform/mt", () => ({
  mtNative: {
    modelsDir: vi.fn(async () => "/models"), status: vi.fn(async () => []), startDownload: vi.fn(), pause: vi.fn(),
    cancel: vi.fn(), deleteModel: vi.fn(), unload: vi.fn(), onDownload: vi.fn(async () => () => {}),
  },
  tauriEngine: { generate: vi.fn(), cancel: vi.fn() },
  pickGgufFile: vi.fn(),
}));
vi.mock("../platform/tauri-fs", () => ({ tauriFs: { exists: vi.fn(async () => true) } }));

import { getMtSettings } from "../platform/prefs";
import { MtSettings } from "./MtSettings";
import { activeTranslator, useMt } from "./mt-store";

const initial = useMt.getState();
const secrets = new Map<string, string>();

beforeEach(() => {
  prefs.clear();
  secrets.clear();
  useMt.setState({ ...initial, initialized: true, settings: { ...initial.settings, enabled: true } }, true);
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, a: Record<string, string>) => {
    if (cmd === "secret_set") return void secrets.set(a.account, a.value);
    if (cmd === "secret_has") return secrets.has(a.account);
    if (cmd === "secret_delete") return void secrets.delete(a.account);
    if (cmd === "mt_cloud_models") return ["claude-haiku", "claude-sonnet"];
  });
});
afterEach(cleanup);

const form = () => render(<MtSettings session={null} />);
const pickProvider = (label: string) => userEvent.selectOptions(screen.getByLabelText("Provider"), label);
const save = () => userEvent.click(screen.getByRole("button", { name: "Save" }));
const settings = () => useMt.getState().settings;

describe("provider settings (saved with the form's Save)", () => {
  it("nothing changes until Save; then Claude asks for consent once, naming api.anthropic.com", async () => {
    form();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await pickProvider("Claude (Anthropic)");
    expect(settings().provider).toBe("local");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await save();
    const dlg = screen.getByRole("dialog", { name: "Send text to Claude (Anthropic)?" });
    expect(within(dlg).getByText(/api\.anthropic\.com/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(settings().provider).toBe("anthropic"));
    expect(settings().consent).toContain("anthropic");
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    await pickProvider("Built-in (on this computer)");
    await save();
    await waitFor(() => expect(settings().provider).toBe("local"));
    await pickProvider("Claude (Anthropic)");
    await save();
    await waitFor(() => expect(settings().provider).toBe("anthropic"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("declining consent saves nothing and keeps the edits", async () => {
    form();
    await pickProvider("OpenAI (ChatGPT)");
    await save();
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(settings().provider).toBe("local");
    expect(screen.getByLabelText("Provider")).toHaveValue("openai");
  });

  it("Discard puts the form back to the saved settings", async () => {
    form();
    await pickProvider("OpenAI (ChatGPT)");
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByLabelText("Provider")).toHaveValue("local");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("the key is stored with setSecret on Save and never put in prefs", async () => {
    useMt.setState({ settings: { ...settings(), provider: "anthropic", consent: ["anthropic"] } });
    form();
    await userEvent.type(await screen.findByLabelText("API key"), "sk-ant-secret");
    expect(secrets.has("anthropic")).toBe(false);
    await save();
    await waitFor(() => expect(secrets.get("anthropic")).toBe("sk-ant-secret"));
    expect(await screen.findByText(/Saved in (Keychain|Credential Manager|your system keyring)/)).toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toHaveAttribute("placeholder", "•••••••• (saved)");
    expect(JSON.stringify([...prefs.values()])).not.toContain("sk-ant-secret");
    expect(screen.queryByDisplayValue("sk-ant-secret")).toBeNull();
  });

  it("Remove deletes the saved key on Save", async () => {
    secrets.set("anthropic", "k");
    useMt.setState({ settings: { ...settings(), provider: "anthropic", consent: ["anthropic"] } });
    form();
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(secrets.has("anthropic")).toBe(true);
    await save();
    await waitFor(() => expect(secrets.has("anthropic")).toBe(false));
  });

  it("the model list comes from mt_cloud_models; the chosen model is saved on Save", async () => {
    secrets.set("anthropic", "k");
    useMt.setState({ settings: { ...settings(), provider: "anthropic", consent: ["anthropic"] } });
    form();
    await waitFor(() => expect([...screen.getByTestId("model-list").querySelectorAll("option")].map((o) => o.value)).toEqual(["claude-haiku", "claude-sonnet"]));
    // Nothing chosen yet: the first one is filled in, as an edit to save.
    expect(screen.getByLabelText("Model")).toHaveValue("claude-haiku");
    await userEvent.clear(screen.getByLabelText("Model"));
    await userEvent.type(screen.getByLabelText("Model"), "claude-sonnet");
    expect((await getMtSettings()).cloud.anthropic?.model).toBeUndefined();
    await save();
    await waitFor(async () => expect((await getMtSettings()).cloud.anthropic?.model).toBe("claude-sonnet"));
  });

  it("Test connection lists the models with the saved key, and waits for a new key to be saved", async () => {
    secrets.set("anthropic", "k");
    useMt.setState({ settings: { ...settings(), provider: "anthropic", consent: ["anthropic"], cloud: { anthropic: { model: "claude-haiku" } } } });
    form();
    await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connected. 2 models available.")).toBeInTheDocument();
    invoke.mockImplementationOnce(async () => {
      throw "401 Unauthorized";
    });
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Couldn't connect: 401 Unauthorized")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("API key"), "new");
    expect(screen.getByRole("button", { name: "Test connection" })).toBeDisabled();
  });

  it("the ACP preset fills the command, saved on Save", async () => {
    useMt.setState({ settings: { ...settings(), provider: "acp", consent: ["acp"] } });
    form();
    await userEvent.selectOptions(screen.getByLabelText("Agent"), "Claude Code");
    expect(settings().acp).toBeNull();
    await save();
    await waitFor(() => expect(settings().acp).toEqual({ preset: "claude-code", command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"] }));
    await userEvent.selectOptions(screen.getByLabelText("Agent"), "Gemini CLI");
    await save();
    await waitFor(() => expect(settings().acp).toEqual({ preset: "gemini", command: "gemini", args: ["--acp"] }));
  });

  it("old prefs without a provider read as local", async () => {
    prefs.set("mt", { enabled: true, modelId: "x", custom: null, accepted: [] });
    const s = await getMtSettings();
    expect(s).toMatchObject({ provider: "local", cloud: {}, acp: null, consent: [], instructions: "" });
  });

  it("the project override wins, and a remote provider needs consent", () => {
    const st = useMt.getState();
    const settings = { ...st.settings, provider: "local" as const, cloud: { openai: { model: "gpt-x" } }, consent: [] as string[] };
    expect(activeTranslator({ ...st, settings }, "next-i18next", "openai")).toBeNull(); // no consent yet
    expect(activeTranslator({ ...st, settings: { ...settings, consent: ["openai"] } }, "next-i18next", "openai")?.label).toBe("OpenAI (ChatGPT)");
  });

  it("OpenAI-compatible needs an address, asks on Save naming its host, and again for a new address", async () => {
    form();
    await pickProvider("OpenAI-compatible");
    await save();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Enter the API base URL.")).toBeInTheDocument();
    const base = screen.getByLabelText("API base URL");
    await userEvent.type(base, "http://localhost:11434/v1");
    await save();
    const dlg = screen.getByRole("dialog", { name: "Send text to OpenAI-compatible?" });
    expect(within(dlg).getByText(/localhost:11434/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(settings().cloud.compatible?.baseUrl).toBe("http://localhost:11434/v1"));
    expect(settings().consent).toContain("compatible:http://localhost:11434/v1");
    await userEvent.clear(base);
    await userEvent.type(base, "https://api.example.com/v1");
    await save();
    expect(screen.getByRole("dialog", { name: "Send text to OpenAI-compatible?" })).toBeInTheDocument();
  });

  it("a compatible provider is used only for the address the user agreed to", () => {
    const st = useMt.getState();
    const settings = {
      ...st.settings, provider: "compatible" as const, cloud: { compatible: { baseUrl: "https://api.example.com/v1", model: "m" } },
      consent: ["compatible", "compatible:http://localhost:11434/v1"],
    };
    expect(activeTranslator({ ...st, settings }, "next-i18next")).toBeNull();
    expect(activeTranslator({ ...st, settings: { ...settings, consent: ["compatible:https://api.example.com/v1"] } }, "next-i18next")).not.toBeNull();
  });

  it("the agent note says what Retrans can and can't control", async () => {
    useMt.setState({ settings: { ...settings(), provider: "acp", consent: ["acp"] } });
    form();
    expect(screen.getByText(/its own built-in tools can still read files on this computer/)).toBeInTheDocument();
  });
});
