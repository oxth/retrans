import { invoke } from "@tauri-apps/api/core";
import { buildBatchPrompt, parseBatchReply } from "../mt/cloud-prompt";
import { protect, restore } from "../mt/protect";
import { nextReqId } from "../mt/translate";
import { PROVIDER_LABELS } from "../mt/translator";
import type { ProviderId } from "../platform/prefs";
import { useState } from "react";
import { inputCls } from "./Dialog";
import { Icon } from "./Icon";
import { type Acp, type Cloud, isCloud, type MtDraft } from "./mt-draft";
import { useMt } from "./mt-store";
import type { ProjectSession } from "../core/session";
import { isValidLocale } from "../core/session-helpers";
import { localeLabel } from "./locales";
import {
  btnRow,
  defaultPair,
  fieldBase,
  fieldCls,
  Group,
  LanguagePair,
  languageOptions,
  languagePairError,
  Row,
  sameAsInput,
  UNCHANGED_NOTE,
} from "./settings-ui";

/** Commands checked against each project's docs (2026-11-05). */
export const ACP_PRESETS: Record<Exclude<Acp["preset"], "custom">, { label: string; command: string; args: string[] }> = {
  "claude-code": { label: "Claude Code", command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"] },
  codex: { label: "Codex", command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] },
  gemini: { label: "Gemini CLI", command: "gemini", args: ["--acp"] },
};

export const storeName = () => {
  const ua = navigator.userAgent;
  if (/Mac/.test(ua)) return "Keychain";
  if (/Windows/.test(ua)) return "Credential Manager";
  return "your system keyring";
};

/** One line under the Provider picker: where the text goes. */
const PROVIDER_HINTS: Record<ProviderId, string> = {
  local: "Runs on this computer. Nothing leaves it.",
  openai: "Text is sent to api.openai.com.",
  anthropic: "Text is sent to api.anthropic.com.",
  compatible: "Text is sent to the API address you set.",
  acp: "An AI agent on this computer translates, using its own account.",
};

/** The provider's model list, loaded with the saved key. */
export interface ModelList {
  list: string[] | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Settings → Machine translation, the provider part of the form: who translates and how to reach
 * them. Everything edits the draft; nothing is saved until the form's Save.
 */
export function ProviderFields({
  draft,
  patch,
  savedKey,
  models,
}: {
  draft: MtDraft;
  patch: (p: Partial<MtDraft>) => void;
  /** Whether a key is saved for the provider (and address) in the draft; null while checking. */
  savedKey: boolean | null;
  models: ModelList;
}) {
  const p = draft.provider;
  return (
    <>
      <Group label="Who translates">
        <Row label="Provider" hint={PROVIDER_HINTS[p]} htmlFor="mt-provider">
          <select id="mt-provider" aria-label="Provider" className={fieldCls} value={p} onChange={(e) => patch({ provider: e.target.value as ProviderId })}>
            {(Object.keys(PROVIDER_LABELS) as ProviderId[]).map((id) => (
              <option key={id} value={id}>{PROVIDER_LABELS[id]}</option>
            ))}
          </select>
        </Row>
      </Group>
      {isCloud(p) && <CloudFields provider={p} draft={draft} patch={patch} savedKey={savedKey} models={models} />}
      {p === "acp" && <AcpFields draft={draft} patch={patch} />}
    </>
  );
}

/**
 * Test this model, for cloud and agent providers: sends one string exactly as a run would and shows
 * what was sent (instructions included) and the reply. Uses the saved settings.
 */
export function RemoteTest({ dirty, session }: { dirty: boolean; session: ProjectSession | null }) {
  const settings = useMt((s) => s.settings);
  const format = session?.data.format ?? "next-i18next";
  const [start] = useState(() => defaultPair(session?.data.baseLocale, session?.data.locales));
  const [text, setText] = useState("");
  const [source, setSource] = useState(start.from);
  const [target, setTarget] = useState(start.to);
  const [sent, setSent] = useState<string | null>(null);
  const [out, setOut] = useState<string | null>(null);
  const [unchanged, setUnchanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const pairError = languagePairError(source, target);
  const test = async () => {
    const p = protect(format, text);
    setUnchanged(false);
    const { system, user } = buildBatchPrompt({
      src: source,
      targets: [target],
      strings: [{ id: "test", key: "test", group: "", masked: p.masked, base: text, others: {} }],
      instructions: settings.instructions,
    });
    setSent(`${system}\n\n${user}`);
    setOut(null);
    setBusy(true);
    try {
      const reqId = nextReqId();
      let reply: string;
      if (settings.provider === "acp") {
        if (!settings.acp) throw new Error("Choose an agent first.");
        reply = await invoke<string>("mt_acp_prompt", { req: { command: settings.acp.command, args: settings.acp.args, text: `${system}\n\n${user}`, reqId } });
      } else {
        const p2 = settings.provider as Cloud;
        const cfg = settings.cloud[p2];
        if (!cfg?.model) throw new Error("Choose a model first.");
        const baseUrl = p2 === "compatible" ? (settings.cloud.compatible?.baseUrl ?? null) : null;
        reply = await invoke<string>("mt_cloud_chat", { req: { provider: p2, baseUrl, model: cfg.model, system, user, reqId } });
      }
      const raw = parseBatchReply(reply, ["test"], [target]).values.get("test")?.get(target);
      const back = raw === undefined ? null : restore(raw, p);
      setOut(raw === undefined ? "The model's reply was incomplete." : back?.ok ? back.text : "Couldn't translate safely");
      setUnchanged(!!back?.ok && sameAsInput(text, back.text));
    } catch (e) {
      setOut(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Group label="Try it">
      <Row
        stacked
        label="Test this model"
        hint={dirty ? "Uses the saved settings. Save your changes to try them." : "Sends one string exactly as a translation run would, with your instructions. Set From to the language you type in."}
      >
        <LanguagePair from={source} to={target} onFrom={setSource} onTo={setTarget} options={languageOptions(session?.data.locales)} />
        <div className="flex gap-2">
          <input
            aria-label="Test text"
            className={inputCls}
            placeholder={source && isValidLocale(source) ? `Text in ${localeLabel(source)}` : "Text to translate"}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="button" className={`${btnRow} shrink-0`} disabled={dirty || busy || !text.trim() || !!pairError} onClick={() => void test()}>
            {busy ? "Testing…" : "Test this model"}
          </button>
        </div>
        {pairError && <p className="text-xs text-danger">{pairError}</p>}
        {out !== null && <div role="status" className="rounded-md bg-surface px-3 py-2 text-sm">{out}</div>}
        {unchanged && <p className="text-xs text-warn">{UNCHANGED_NOTE}</p>}
        {sent !== null && (
          <details>
            <summary className="cursor-pointer text-xs text-muted">What was sent</summary>
            <pre aria-label="Sent to the provider" className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-surface p-2 text-xs text-muted">{sent}</pre>
          </details>
        )}
      </Row>
    </Group>
  );
}

function CloudFields({
  provider,
  draft,
  patch,
  savedKey,
  models,
}: {
  provider: Cloud;
  draft: MtDraft;
  patch: (p: Partial<MtDraft>) => void;
  savedKey: boolean | null;
  models: ModelList;
}) {
  const keyHint = draft.removeKey ? (
    <>
      The saved key will be removed when you save.{" "}
      <button type="button" className="text-brand-ink underline" onClick={() => patch({ removeKey: false })}>Undo</button>
    </>
  ) : savedKey ? (
    `Saved in ${storeName()}. Type a new key to replace it.`
  ) : provider === "compatible" ? (
    "Optional for keyless local servers, e.g. Ollama."
  ) : (
    `Stored in ${storeName()}, never in project files.`
  );
  return (
    <Group label="Configuration">
      {provider === "compatible" && (
        <Row label="Base URL" hint="OpenAI-compatible endpoint." htmlFor="mt-base-url">
          <input
            id="mt-base-url"
            aria-label="API base URL"
            className={`${fieldBase} w-64 font-mono`}
            placeholder="https://openrouter.ai/api/v1"
            value={draft.baseUrl}
            onChange={(e) => patch({ baseUrl: e.target.value })}
          />
        </Row>
      )}
      <Row
        label="Model"
        hint={models.error ? <span className="text-danger">{models.error}</span> : models.loading ? "Loading the model list…" : "Type or pick one from the provider's list."}
        htmlFor="mt-model"
      >
        <input
          id="mt-model"
          aria-label="Model"
          list="mt-model-list"
          autoComplete="off"
          className={`${fieldBase} w-56`}
          value={draft.models[provider]}
          onChange={(e) => patch({ models: { ...draft.models, [provider]: e.target.value } })}
        />
        <datalist id="mt-model-list" data-testid="model-list">
          {(models.list ?? []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <button type="button" aria-label="Reload model list" title="Reload model list" className="rounded-md p-1.5 text-muted transition-colors duration-150 hover:bg-hover hover:text-fg disabled:opacity-50" disabled={models.loading} onClick={models.reload}>
          <Icon name="refresh" size={15} className={models.loading ? "animate-spin motion-reduce:animate-none" : ""} />
        </button>
      </Row>
      <Row label="API key" hint={keyHint} htmlFor="mt-api-key">
        <input
          id="mt-api-key"
          aria-label="API key"
          type="password"
          autoComplete="off"
          className={`${fieldBase} w-64`}
          placeholder={savedKey && !draft.removeKey ? "•••••••• (saved)" : ""}
          value={draft.key}
          onChange={(e) => patch({ key: e.target.value, removeKey: false })}
        />
        {savedKey && !draft.removeKey && !draft.key && (
          <button type="button" className={btnRow} onClick={() => patch({ removeKey: true })}>Remove</button>
        )}
      </Row>
    </Group>
  );
}

function AcpFields({ draft, patch }: { draft: MtDraft; patch: (p: Partial<MtDraft>) => void }) {
  return (
    <Group label="Configuration" footer={<AcpNote />}>
      <Row label="Agent" hint="Runs on this computer with its own login." htmlFor="mt-agent">
        <select
          id="mt-agent"
          aria-label="Agent"
          className={fieldCls}
          value={draft.acpPreset}
          onChange={(e) => {
            const v = e.target.value as Acp["preset"];
            if (v === "custom") patch({ acpPreset: "custom" });
            else patch({ acpPreset: v, acpCommand: [ACP_PRESETS[v].command, ...ACP_PRESETS[v].args].join(" ") });
          }}
        >
          <option value="" disabled>Choose an agent…</option>
          {(Object.keys(ACP_PRESETS) as Array<keyof typeof ACP_PRESETS>).map((k) => (
            <option key={k} value={k}>{ACP_PRESETS[k].label}</option>
          ))}
          <option value="custom">Custom command</option>
        </select>
      </Row>
      {draft.acpPreset === "custom" && (
        <Row label="Command" hint="The agent's ACP command and arguments." htmlFor="mt-acp-command">
          <input
            id="mt-acp-command"
            aria-label="Command"
            className={`${fieldBase} w-64 font-mono`}
            value={draft.acpCommand}
            onChange={(e) => patch({ acpCommand: e.target.value })}
          />
        </Row>
      )}
    </Group>
  );
}

function AcpNote() {
  return (
    <>
      The agent uses its own login (your Claude, ChatGPT or Gemini subscription) and runs on this computer. Retrans gives it no file or
      terminal access of its own and refuses every permission it asks for, but its own built-in tools can still read files on this
      computer. Use agents you trust, and prefer an API provider for text from people you don't know.
    </>
  );
}
