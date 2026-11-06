import type { PromptTemplate } from "../mt/catalog";
import type { MtSettings, ProviderId } from "../platform/prefs";
import { deleteSecret, setSecret } from "../platform/secrets";
import type { MtState } from "./mt-store";

/**
 * Settings → Machine translation is a form: edits stay in a draft until Save. Downloads, pausing
 * and deleting models are actions and still happen straight away.
 */

export type Cloud = "openai" | "anthropic" | "compatible";
export type Acp = NonNullable<MtSettings["acp"]>;

export interface MtDraft {
  enabled: boolean;
  provider: ProviderId;
  /** The built-in (or custom) model to use. */
  modelId: string | null;
  customPath: string | null;
  customTemplate: PromptTemplate;
  /** Model name per cloud provider, so switching provider back and forth keeps each one. */
  models: Record<Cloud, string>;
  baseUrl: string;
  /** A newly typed API key; empty keeps the saved one. */
  key: string;
  /** Remove the saved key on Save. */
  removeKey: boolean;
  acpPreset: Acp["preset"] | "";
  /** Custom agent command line ("command arg arg"). */
  acpCommand: string;
}

export const isCloud = (p: ProviderId): p is Cloud => p === "openai" || p === "anthropic" || p === "compatible";
export const trimBase = (u: string) => u.trim().replace(/\/+$/, "");
/** The keychain entry for a provider's key: one per compatible address. */
export const accountOf = (p: Cloud, baseUrl?: string) => (p === "compatible" ? `compatible:${trimBase(baseUrl ?? "")}` : p);

export function draftFrom(s: MtSettings): MtDraft {
  return {
    enabled: s.enabled,
    provider: s.provider ?? "local",
    modelId: s.modelId,
    customPath: s.custom?.path ?? null,
    customTemplate: s.custom?.template ?? "qwen3",
    models: {
      openai: s.cloud.openai?.model ?? "",
      anthropic: s.cloud.anthropic?.model ?? "",
      compatible: s.cloud.compatible?.model ?? "",
    },
    baseUrl: s.cloud.compatible?.baseUrl ?? "",
    key: "",
    removeKey: false,
    acpPreset: s.acp?.preset ?? "",
    acpCommand: s.acp ? [s.acp.command, ...s.acp.args].join(" ") : "",
  };
}

export function isDirty(d: MtDraft, s: MtSettings): boolean {
  const base = draftFrom(s);
  if (d.key.trim() || d.removeKey) return true;
  return JSON.stringify({ ...d, key: "", baseUrl: trimBase(d.baseUrl), acpCommand: d.acpCommand.trim() }) !== JSON.stringify(base);
}

/** What's wrong with the draft, if anything, before it can be saved. */
export function draftError(d: MtDraft): string | null {
  if (!d.enabled) return null;
  if (d.provider === "compatible" && !trimBase(d.baseUrl)) return "Enter the API base URL.";
  if (d.provider === "compatible") {
    try {
      new URL(trimBase(d.baseUrl));
    } catch {
      return "The API base URL isn't a valid address.";
    }
  }
  if (d.provider === "acp" && !d.acpPreset) return "Choose an agent.";
  if (d.provider === "acp" && d.acpPreset === "custom" && !d.acpCommand.trim()) return "Enter the agent's command.";
  return null;
}

/** The consent this draft needs before text may be sent, or null. */
export function consentNeeded(d: MtDraft, s: MtSettings): { provider: ProviderId; key: string; where: string } | null {
  if (!d.enabled || d.provider === "local") return null;
  const key = d.provider === "compatible" ? `compatible:${trimBase(d.baseUrl)}` : d.provider;
  if (s.consent.includes(key)) return null;
  return { provider: d.provider, key, where: destination(d) };
}

/** Where text goes, for the one-time consent. */
export function destination(d: Pick<MtDraft, "provider" | "baseUrl">): string {
  if (d.provider === "openai") return "api.openai.com";
  if (d.provider === "anthropic") return "api.anthropic.com";
  if (d.provider === "compatible") {
    try {
      return new URL(trimBase(d.baseUrl)).host || "the API address you set";
    } catch {
      return "the API address you set";
    }
  }
  return "the AI agent you choose, which runs on this computer and uses its own account";
}

/** Applies a saved-for-real draft: the key first, then settings, then the switch. */
export async function applyDraft(d: MtDraft, mt: MtState): Promise<void> {
  const s = mt.settings;
  const base = trimBase(d.baseUrl);
  if (isCloud(d.provider)) {
    const account = accountOf(d.provider, base);
    if (d.removeKey) await deleteSecret(account);
    if (d.key.trim()) await setSecret(account, d.key.trim());
  }
  for (const p of ["openai", "anthropic", "compatible"] as const) {
    const was = s.cloud[p];
    const model = d.models[p].trim();
    const changed = p === "compatible" ? model !== (was?.model ?? "") || base !== (s.cloud.compatible?.baseUrl ?? "") : model !== (was?.model ?? "");
    if (changed) await mt.setCloud(p, { model, baseUrl: p === "compatible" ? base : undefined });
  }
  const acpBefore = draftFrom(s);
  if (d.acpPreset && (d.acpPreset !== acpBefore.acpPreset || d.acpCommand.trim() !== acpBefore.acpCommand)) {
    const [command = "", ...args] = d.acpCommand.trim().split(/\s+/);
    await mt.setAcp({ preset: d.acpPreset, command, args });
  }
  if (d.customPath && (d.customPath !== s.custom?.path || d.customTemplate !== s.custom?.template)) {
    await mt.setCustom(d.customPath, d.customTemplate); // this also picks the custom model
  }
  const nowModel = d.customPath && (d.customPath !== s.custom?.path || d.customTemplate !== s.custom?.template) ? "custom" : s.modelId;
  if (d.modelId && d.modelId !== nowModel) await mt.selectModel(d.modelId);
  if (d.provider !== (s.provider ?? "local")) await mt.setProvider(d.provider);
  if (d.enabled !== s.enabled) await mt.setEnabled(d.enabled);
}
