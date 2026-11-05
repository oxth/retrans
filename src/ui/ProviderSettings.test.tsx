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
import { ProviderSettings } from "./ProviderSettings";
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

const pickProvider = (label: string) => userEvent.selectOptions(screen.getByLabelText("Provider"), label);

describe("provider settings", () => {
  it("choosing Claude asks for consent once, naming api.anthropic.com", async () => {
    render(<ProviderSettings />);
    await pickProvider("Claude (Anthropic)");
    const dlg = screen.getByRole("dialog", { name: "Send text to Claude (Anthropic)?" });
    expect(within(dlg).getByText(/api\.anthropic\.com/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "Continue" }));
    expect(useMt.getState().settings.provider).toBe("anthropic");
    expect(useMt.getState().settings.consent).toContain("anthropic");
    await pickProvider("Built-in (on this computer)");
    await pickProvider("Claude (Anthropic)");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("declining consent keeps the previous provider", async () => {
    render(<ProviderSettings />);
    await pickProvider("OpenAI (ChatGPT)");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(useMt.getState().settings.provider).toBe("local");
  });

  it("the key is stored with setSecret and never put in prefs", async () => {
    useMt.setState({ settings: { ...useMt.getState().settings, provider: "anthropic", consent: ["anthropic"] } });
    render(<ProviderSettings />);
    await userEvent.type(await screen.findByLabelText("API key"), "sk-ant-secret");
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(secrets.get("anthropic")).toBe("sk-ant-secret"));
    expect(await screen.findByText(/Saved in (Keychain|Credential Manager|your system keyring)/)).toBeInTheDocument();
    expect(JSON.stringify([...prefs.values()])).not.toContain("sk-ant-secret");
    expect(screen.queryByDisplayValue("sk-ant-secret")).toBeNull();
  });

  it("the model list comes from mt_cloud_models", async () => {
    secrets.set("anthropic", "k");
    useMt.setState({ settings: { ...useMt.getState().settings, provider: "anthropic", consent: ["anthropic"] } });
    render(<ProviderSettings />);
    // A text box until the list arrives, then a list of the provider's models.
    await waitFor(() =>
      expect(within(screen.getByLabelText("Model")).getAllByRole("option").map((o) => o.textContent)).toEqual(["claude-haiku", "claude-sonnet"]),
    );
    await userEvent.selectOptions(screen.getByLabelText("Model"), "claude-sonnet");
    expect((await getMtSettings()).cloud.anthropic?.model).toBe("claude-sonnet");
  });

  it("the ACP preset fills the command", async () => {
    useMt.setState({ settings: { ...useMt.getState().settings, provider: "acp", consent: ["acp"] } });
    render(<ProviderSettings />);
    await userEvent.selectOptions(screen.getByLabelText("Agent"), "Claude Code");
    expect(useMt.getState().settings.acp).toEqual({ preset: "claude-code", command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"] });
    await userEvent.selectOptions(screen.getByLabelText("Agent"), "Gemini CLI");
    expect(useMt.getState().settings.acp).toEqual({ preset: "gemini", command: "gemini", args: ["--acp"] });
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

  it("OpenAI-compatible asks when the address is saved, naming its host, and again for a new address", async () => {
    render(<ProviderSettings />);
    await pickProvider("OpenAI-compatible");
    expect(screen.queryByRole("dialog")).toBeNull(); // nothing is sent until an address is set
    const base = screen.getByLabelText("API base URL");
    await userEvent.type(base, "http://localhost:11434/v1");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const dlg = screen.getByRole("dialog", { name: "Send text to OpenAI-compatible?" });
    expect(within(dlg).getByText(/localhost:11434/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "Continue" }));
    expect(useMt.getState().settings.consent).toContain("compatible:http://localhost:11434/v1");
    await userEvent.clear(base);
    await userEvent.type(base, "https://api.example.com/v1");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
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
    useMt.setState({ settings: { ...useMt.getState().settings, provider: "acp", consent: ["acp"] } });
    render(<ProviderSettings />);
    expect(screen.getByText(/its own built-in tools can still read files on this computer/)).toBeInTheDocument();
  });
});
