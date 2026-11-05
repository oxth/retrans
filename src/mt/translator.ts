/**
 * One interface for every translation provider: the built-in local model, cloud APIs (OpenAI,
 * Claude, OpenAI-compatible) and ACP agents. Remote providers get batches of strings with all their
 * target languages per request; placeholders are protected and checked exactly as for the local
 * model, and results are always written as machine translations needing review.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTranslated, type Format, type KeyId, parseKeyId } from "../core/model";
import type { ProjectSession } from "../core/session";
import { type BatchResult, missingItems } from "./batch";
import { buildBatchPrompt, parseBatchReply, type BatchString } from "./cloud-prompt";
import { protect, restore } from "./protect";
import { type ActiveModel, type MtEngine, nextReqId, translateText, type TranslateResult } from "./translate";

export interface TranslateJob {
  id: KeyId;
  locale: string;
  source: string;
}

export interface TranslatorCtx {
  session: ProjectSession;
  /** The combined custom instructions for a target language. */
  instructions: (locale: string) => string;
}

export interface Translator {
  /** Provider label, for "Translating with …". */
  readonly label: string;
  /** False only for the built-in local model: nothing leaves the computer. */
  readonly remote: boolean;
  translate(jobs: TranslateJob[], ctx: TranslatorCtx, onResult: (job: TranslateJob, r: TranslateResult) => void, signal: AbortSignal): Promise<void>;
}

export interface CloudConfig {
  provider: "openai" | "anthropic" | "compatible";
  model: string;
  baseUrl?: string;
}

export interface AcpConfig {
  preset: "claude-code" | "codex" | "gemini" | "custom";
  command: string;
  args: string[];
}

export const BATCH_STRINGS = 20;
export const INCOMPLETE = "The model's reply was incomplete.";
const TOO_LONG = "Text is too long to translate";

export const PROVIDER_LABELS = {
  local: "Built-in (on this computer)",
  openai: "OpenAI (ChatGPT)",
  anthropic: "Claude (Anthropic)",
  compatible: "OpenAI-compatible",
  acp: "AI agent (ACP)",
} as const;

const message = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : String(e));

/** The built-in model, one string at a time (today's translateText). */
export function localTranslator(engine: MtEngine, model: ActiveModel, format: Format): Translator {
  return {
    label: PROVIDER_LABELS.local,
    remote: false,
    async translate(jobs, ctx, onResult, signal) {
      const base = ctx.session.data.baseLocale;
      for (const job of jobs) {
        if (signal.aborted) return;
        const id = nextReqId();
        const cancel = () => void engine.cancel(id).catch(() => {});
        signal.addEventListener("abort", cancel, { once: true });
        let r: TranslateResult;
        try {
          r = await translateText(engine, model, format, base, job.locale, job.source, id, ctx.instructions(job.locale));
        } catch (e) {
          r = { ok: false, reason: "error", message: message(e) };
        } finally {
          signal.removeEventListener("abort", cancel);
        }
        onResult(job, signal.aborted ? { ok: false, reason: "cancelled" } : r);
      }
    },
  };
}

/** Instructions for a request covering several languages: shared text once, else per language. */
function batchInstructions(targets: string[], ctx: TranslatorCtx): string {
  const parts = targets.map((l) => ctx.instructions(l));
  if (parts.every((p) => p === parts[0])) return parts[0] ?? "";
  return targets.map((l, i) => (parts[i] ? `For ${l}: ${parts[i]}` : "")).filter(Boolean).join("\n\n");
}

const textOf = (session: ProjectSession, id: KeyId, locale: string) => {
  const v = session.value(id, locale);
  return v?.kind === "text" ? v.text : undefined;
};

/** Cloud APIs and ACP agents: batches of strings, all their target languages in one request. */
function remoteTranslator(
  label: string,
  format: Format,
  send: (system: string, user: string, reqId: number) => Promise<string>,
  cancel: (reqId: number) => Promise<void>,
): Translator {
  return {
    label,
    remote: true,
    async translate(jobs, ctx, onResult, signal) {
      const { session } = ctx;
      const base = session.data.baseLocale;
      const byId = new Map<KeyId, TranslateJob[]>();
      for (const job of jobs) byId.set(job.id, [...(byId.get(job.id) ?? []), job]);
      const ids = [...byId.keys()];
      for (let i = 0; i < ids.length; i += BATCH_STRINGS) {
        if (signal.aborted) return;
        const chunk = ids.slice(i, i + BATCH_STRINGS);
        const targets = [...new Set(chunk.flatMap((id) => byId.get(id)!.map((j) => j.locale)))];
        const guarded = new Map(chunk.map((id) => [id, protect(format, byId.get(id)![0].source)]));
        const strings: BatchString[] = chunk.map((id) => {
          const { ns, key } = parseKeyId(id);
          const others: Record<string, string> = {};
          for (const l of session.data.locales) {
            const t = l === base ? undefined : textOf(session, id, l);
            if (t !== undefined) others[l] = t;
          }
          return { id, key, group: ns, masked: guarded.get(id)!.masked, base: textOf(session, id, base) ?? "", others };
        });
        const { system, user } = buildBatchPrompt({ src: base, targets, strings, instructions: batchInstructions(targets, ctx) });
        const reqId = nextReqId();
        const stop = () => void cancel(reqId).catch(() => {});
        signal.addEventListener("abort", stop, { once: true });
        let reply: string;
        try {
          reply = await send(system, user, reqId);
        } catch (e) {
          const m = message(e);
          const r: TranslateResult = m === "cancelled" || signal.aborted ? { ok: false, reason: "cancelled" } : { ok: false, reason: "error", message: m };
          for (const id of chunk) for (const job of byId.get(id)!) onResult(job, r);
          return; // a provider error stops the run
        } finally {
          signal.removeEventListener("abort", stop);
        }
        const parsed = parseBatchReply(reply, chunk, targets);
        for (const id of chunk) {
          for (const job of byId.get(id)!) {
            if (signal.aborted) {
              onResult(job, { ok: false, reason: "cancelled" });
              continue;
            }
            const raw = parsed.values.get(id)?.get(job.locale);
            if (raw === undefined) {
              onResult(job, { ok: false, reason: "error", message: INCOMPLETE });
              continue;
            }
            const back = restore(raw, guarded.get(id)!);
            onResult(job, back.ok ? { ok: true, text: back.text } : { ok: false, reason: "unsafe" });
          }
        }
      }
    },
  };
}

export function cloudTranslator(cfg: CloudConfig, format: Format): Translator {
  return remoteTranslator(
    PROVIDER_LABELS[cfg.provider],
    format,
    (system, user, reqId) =>
      invoke<string>("mt_cloud_chat", { req: { provider: cfg.provider, baseUrl: cfg.baseUrl ?? null, model: cfg.model, system, user, reqId } }),
    (reqId) => invoke<void>("mt_cloud_cancel", { reqId }),
  );
}

export function acpTranslator(cfg: AcpConfig, format: Format): Translator {
  return remoteTranslator(
    PROVIDER_LABELS.acp,
    format,
    (system, user, reqId) => invoke<string>("mt_acp_prompt", { req: { command: cfg.command, args: cfg.args, text: `${system}\n\n${user}`, reqId } }),
    (reqId) => invoke<void>("mt_acp_cancel", { reqId }),
  );
}

export interface MultiProgress {
  perLocale: Record<string, { done: number; total: number }>;
  current: KeyId | null;
}

/**
 * Translate missing for several languages in one run. Writes go through `write` (one undo step per
 * run); a cell filled meanwhile is skipped; a provider error (other than an over-long string) stops
 * everything. Cancel keeps what finished.
 */
export async function translateMissingMulti(
  session: ProjectSession,
  locales: string[],
  ns: string,
  translator: Translator,
  onProgress: (p: MultiProgress) => void,
  signal: AbortSignal,
  write: (fn: () => void) => void = (fn) => fn(),
  instructions: (locale: string) => string = () => "",
): Promise<Record<string, BatchResult>> {
  const results: Record<string, BatchResult> = {};
  const perLocale: MultiProgress["perLocale"] = {};
  const byId = new Map<KeyId, TranslateJob[]>();
  for (const locale of locales) {
    results[locale] = { translated: 0, unsafe: [], failed: [], skipped: 0, cancelled: false };
    const items = missingItems(session, locale, ns);
    perLocale[locale] = { done: 0, total: items.length };
    for (const it of items) byId.set(it.id, [...(byId.get(it.id) ?? []), { id: it.id, locale, source: it.source }]);
  }
  const jobs = [...byId.values()].flat();
  onProgress({ perLocale: structuredClone(perLocale), current: jobs[0]?.id ?? null });

  let reported = 0;
  const run = new AbortController();
  const abort = () => run.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) run.abort();
  try {
    await translator.translate(jobs, { session, instructions }, (job, r) => {
      const res = results[job.locale];
      if (r.ok) {
        let written = false;
        try {
          if (!isTranslated(session.value(job.id, job.locale))) {
            write(() => session.setText(job.id, job.locale, r.text, { machine: true }));
            written = true;
          }
        } catch {
          written = false;
        }
        if (written) res.translated++;
        else res.skipped++;
      } else if (r.reason === "unsafe") {
        res.unsafe.push(job.id);
      } else if (r.reason === "error") {
        res.failed.push({ id: job.id, message: r.message });
        if (r.message !== TOO_LONG && r.message !== INCOMPLETE) run.abort();
      } else {
        res.cancelled = true;
        return;
      }
      perLocale[job.locale].done++;
      reported++;
      // "current" is the string being translated now: the next one not yet reported.
      onProgress({ perLocale: structuredClone(perLocale), current: jobs[reported]?.id ?? null });
    }, run.signal);
  } finally {
    signal.removeEventListener("abort", abort);
  }
  if (signal.aborted) for (const l of locales) if (perLocale[l].done < perLocale[l].total) results[l].cancelled = true;
  return results;
}
