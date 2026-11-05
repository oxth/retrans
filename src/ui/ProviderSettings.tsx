import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { buildBatchPrompt, parseBatchReply } from "../mt/cloud-prompt";
import { protect, restore } from "../mt/protect";
import { nextReqId } from "../mt/translate";
import { PROVIDER_LABELS } from "../mt/translator";
import type { MtSettings, ProviderId } from "../platform/prefs";
import { deleteSecret, hasSecret, setSecret } from "../platform/secrets";
import { btnGhost, btnPrimary, Dialog, inputCls } from "./Dialog";
import { useMt } from "./mt-store";

type Cloud = "openai" | "anthropic" | "compatible";
type Acp = NonNullable<MtSettings["acp"]>;

/** Commands checked against each project's docs (2026-11-05). */
export const ACP_PRESETS: Record<Exclude<Acp["preset"], "custom">, { label: string; command: string; args: string[] }> = {
  "claude-code": { label: "Claude Code", command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"] },
  codex: { label: "Codex", command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] },
  gemini: { label: "Gemini CLI", command: "gemini", args: ["--acp"] },
};

const trimBase = (u: string) => u.trim().replace(/\/+$/, "");
const accountOf = (p: Cloud, baseUrl?: string) => (p === "compatible" ? `compatible:${trimBase(baseUrl ?? "")}` : p);
const storeName = () => (/Mac/.test(navigator.userAgent) ? "Keychain" : "Credential Manager");

/** Where text goes, for the one-time consent. */
function destination(p: ProviderId, s: MtSettings): string {
  if (p === "openai") return "api.openai.com";
  if (p === "anthropic") return "api.anthropic.com";
  if (p === "compatible") {
    try {
      return new URL(s.cloud.compatible?.baseUrl ?? "").host || "the API address you set";
    } catch {
      return "the API address you set";
    }
  }
  return "the AI agent you choose, which runs on this computer and uses its own account";
}

/** Settings → Machine translation: who translates (built-in model, a cloud API, or an ACP agent). */
export function ProviderSettings() {
  const s = useMt();
  const settings = s.settings;
  const [asking, setAsking] = useState<ProviderId | null>(null);

  const choose = (p: ProviderId) => {
    if (p !== "local" && !settings.consent.includes(p)) setAsking(p);
    else void s.setProvider(p);
  };

  return (
    <div className="space-y-3">
      <label className="block">
        Provider
        <select aria-label="Provider" className={inputCls} value={settings.provider} onChange={(e) => choose(e.target.value as ProviderId)}>
          {(Object.keys(PROVIDER_LABELS) as ProviderId[]).map((p) => (
            <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
          ))}
        </select>
      </label>
      {(settings.provider === "openai" || settings.provider === "anthropic" || settings.provider === "compatible") && (
        <CloudFields provider={settings.provider} />
      )}
      {settings.provider === "acp" && <AcpFields />}
      {settings.provider !== "local" && <RemoteTest />}
      {asking && (
        <Dialog title={`Send text to ${PROVIDER_LABELS[asking]}?`} onClose={() => setAsking(null)}>
          <p className="text-sm">
            Text you translate will be sent to {PROVIDER_LABELS[asking]} ({destination(asking, settings)}). The built-in model keeps everything on
            this computer. Continue?
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setAsking(null)}>Cancel</button>
            <button
              className={btnPrimary}
              onClick={async () => {
                const p = asking;
                setAsking(null);
                await s.grantConsent(p);
                await s.setProvider(p);
              }}
            >
              Continue
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/**
 * Test this model, for cloud and agent providers: sends one string exactly as a run would and shows
 * what was sent (instructions included) and the reply.
 */
function RemoteTest() {
  const settings = useMt((s) => s.settings);
  const [text, setText] = useState("");
  const [target, setTarget] = useState("th");
  const [sent, setSent] = useState<string | null>(null);
  const [out, setOut] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const test = async () => {
    const p = protect("next-i18next", text);
    const { system, user } = buildBatchPrompt({
      src: "en",
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
    } catch (e) {
      setOut(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded-md border border-gray-200 p-3">
      <div className="flex gap-2">
        <input aria-label="Test text" className={inputCls} placeholder="Text to translate" value={text} onChange={(e) => setText(e.target.value)} />
        <input aria-label="Translate to" className={`${inputCls} w-20`} value={target} onChange={(e) => setTarget(e.target.value.trim())} />
        <button className={btnGhost} disabled={busy || !text.trim() || !target} onClick={() => void test()}>Test this model</button>
      </div>
      {out !== null && <div role="status" className="text-sm">{out}</div>}
      {sent !== null && (
        <details>
          <summary className="cursor-pointer text-xs text-gray-500">What was sent</summary>
          <pre aria-label="Sent to the provider" className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-gray-600">{sent}</pre>
        </details>
      )}
    </div>
  );
}

function CloudFields({ provider }: { provider: Cloud }) {
  const s = useMt();
  const cfg = s.settings.cloud[provider];
  const baseUrl = provider === "compatible" ? (s.settings.cloud.compatible?.baseUrl ?? "") : undefined;
  const account = accountOf(provider, baseUrl);
  const [saved, setSaved] = useState<boolean | null>(null);
  const [key, setKey] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [base, setBase] = useState(baseUrl ?? "");

  useEffect(() => {
    let live = true;
    setSaved(null);
    hasSecret(account).then(
      (v) => live && setSaved(v),
      () => live && setSaved(false),
    );
    return () => {
      live = false;
    };
  }, [account]);

  // The provider's model list, once it can be asked (a key is saved, or a compatible URL is set).
  useEffect(() => {
    let live = true;
    setModels(null);
    if (provider === "compatible" ? !baseUrl : !saved) return;
    invoke<string[]>("mt_cloud_models", { provider, baseUrl: baseUrl ?? null }).then(
      (list) => {
        if (!live) return;
        setModels(list);
        if (list.length && !cfg?.model) void s.setCloud(provider, { model: list[0], baseUrl });
      },
      (e) => live && setError(typeof e === "string" ? e : String(e)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, baseUrl, saved]);

  return (
    <div className="space-y-3">
      {provider === "compatible" && (
        <label className="block">
          API base URL
          <div className="flex gap-2">
            <input aria-label="API base URL" className={inputCls} placeholder="https://openrouter.ai/api/v1" value={base} onChange={(e) => setBase(e.target.value)} />
            <button className={btnGhost} onClick={() => void s.setCloud("compatible", { model: cfg?.model ?? "", baseUrl: trimBase(base) })}>Save</button>
          </div>
        </label>
      )}
      {saved ? (
        <div className="flex items-center gap-2 text-sm">
          <span>Saved in {storeName()}</span>
          <button className={btnGhost} onClick={() => setSaved(false)}>Replace</button>
          <button
            className={btnGhost}
            onClick={async () => {
              await deleteSecret(account);
              setSaved(false);
            }}
          >
            Remove
          </button>
        </div>
      ) : (
        <label className="block">
          API key{provider === "compatible" ? " (optional for local servers)" : ""}
          <div className="flex gap-2">
            <input aria-label="API key" type="password" autoComplete="off" className={inputCls} value={key} onChange={(e) => setKey(e.target.value)} />
            <button
              className={btnPrimary}
              disabled={!key.trim()}
              onClick={async () => {
                try {
                  await setSecret(account, key.trim());
                  setKey("");
                  setSaved(true);
                  setError(null);
                } catch (e) {
                  setError(typeof e === "string" ? e : String(e));
                }
              }}
            >
              Save key
            </button>
          </div>
        </label>
      )}
      {models && models.length > 0 ? (
        <label className="block">
          Model
          <select
            aria-label="Model"
            className={inputCls}
            value={cfg?.model ?? models[0]}
            onChange={(e) => void s.setCloud(provider, { model: e.target.value, baseUrl })}
          >
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
      ) : (
        <label className="block">
          Model
          <input
            aria-label="Model"
            className={inputCls}
            defaultValue={cfg?.model ?? ""}
            onBlur={(e) => e.target.value.trim() && void s.setCloud(provider, { model: e.target.value.trim(), baseUrl })}
          />
        </label>
      )}
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

function AcpFields() {
  const s = useMt();
  const acp = s.settings.acp;
  const preset = acp?.preset ?? "";
  return (
    <div className="space-y-3">
      <label className="block">
        Agent
        <select
          aria-label="Agent"
          className={inputCls}
          value={preset}
          onChange={(e) => {
            const v = e.target.value as Acp["preset"];
            if (v === "custom") void s.setAcp({ preset: "custom", command: acp?.command ?? "", args: acp?.args ?? [] });
            else void s.setAcp({ preset: v, command: ACP_PRESETS[v].command, args: ACP_PRESETS[v].args });
          }}
        >
          <option value="" disabled>Choose an agent…</option>
          {(Object.keys(ACP_PRESETS) as Array<keyof typeof ACP_PRESETS>).map((k) => (
            <option key={k} value={k}>{ACP_PRESETS[k].label}</option>
          ))}
          <option value="custom">Custom command</option>
        </select>
      </label>
      {acp?.preset === "custom" && (
        <label className="block">
          Command
          <input
            aria-label="Command"
            className={inputCls}
            defaultValue={[acp.command, ...acp.args].join(" ")}
            onBlur={(e) => {
              const [command = "", ...args] = e.target.value.trim().split(/\s+/);
              void s.setAcp({ preset: "custom", command, args });
            }}
          />
        </label>
      )}
      <p className="text-xs text-gray-500">
        The agent uses its own login (your Claude, ChatGPT or Gemini subscription). Retrans gives it no access to your files or terminal: it
        can only reply with text.
      </p>
    </div>
  );
}
