import type { Format } from "../core/model";
import type { PromptTemplate } from "./catalog";
import { buildPrompt, cleanOutput } from "./prompt";
import { protect, type Protected, restore } from "./protect";

export interface GenerateRequest {
  reqId: number;
  modelPath: string;
  prompt: string;
  addBos: boolean;
  maxTokens: number;
  stop: string[];
}

/** Several prompts decoded together by the built-in model (same model, start token and stops). */
export interface ManyRequest {
  reqId: number;
  modelPath: string;
  prompts: { prompt: string; maxTokens: number }[];
  addBos: boolean;
  stop: string[];
}

export type ManyResult = { ok: true; text: string } | { ok: false; message: string };

export interface MtEngine {
  generate(r: GenerateRequest): Promise<string>;
  /** Optional: engines without it are asked one prompt at a time. */
  generateMany?(r: ManyRequest): Promise<ManyResult[]>;
  cancel(reqId: number): Promise<void>;
}

export interface ActiveModel {
  path: string;
  template: PromptTemplate;
}

export type TranslateResult =
  | { ok: true; text: string }
  | { ok: false; reason: "unsafe" }
  | { ok: false; reason: "cancelled" }
  | { ok: false; reason: "error"; message: string };

let counter = 0;
export function nextReqId(): number {
  return ++counter;
}

export async function translateText(
  engine: MtEngine,
  model: ActiveModel,
  format: Format,
  src: string,
  tgt: string,
  text: string,
  reqId: number = nextReqId(),
  /** Custom instructions (used by Qwen-style models; TranslateGemma's prompt is fixed). */
  instructions?: string,
): Promise<TranslateResult> {
  const p = prepareText(model, format, src, tgt, text, instructions);
  let raw: string;
  try {
    raw = await engine.generate({ reqId, modelPath: model.path, prompt: p.prompt, addBos: p.addBos, maxTokens: p.maxTokens, stop: p.stop });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return message === "cancelled" ? { ok: false, reason: "cancelled" } : { ok: false, reason: "error", message };
  }
  return finishText(raw, p.guard);
}

/** A text ready for the model: placeholders masked, the prompt built, its token budget. */
export interface PreparedText {
  guard: Protected;
  prompt: string;
  addBos: boolean;
  stop: string[];
  maxTokens: number;
}

export function prepareText(model: ActiveModel, format: Format, src: string, tgt: string, text: string, instructions?: string): PreparedText {
  const guard = protect(format, text);
  const { prompt, addBos, stop } = buildPrompt(model.template, src, tgt, guard.masked, instructions);
  return { guard, prompt, addBos, stop, maxTokens: Math.min(1024, 64 + guard.masked.length * 4) };
}

/** The model's raw output as a result: cleaned up, placeholders put back and checked. */
export function finishText(raw: string, guard: Protected): TranslateResult {
  const r = restore(cleanOutput(raw, guard.masked), guard);
  return r.ok ? { ok: true, text: r.text } : { ok: false, reason: "unsafe" };
}
