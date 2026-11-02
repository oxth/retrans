import type { Format } from "../core/model";
import type { PromptTemplate } from "./catalog";
import { buildPrompt, cleanOutput } from "./prompt";
import { protect, restore } from "./protect";

export interface GenerateRequest {
  reqId: number;
  modelPath: string;
  prompt: string;
  addBos: boolean;
  maxTokens: number;
  stop: string[];
}

export interface MtEngine {
  generate(r: GenerateRequest): Promise<string>;
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
): Promise<TranslateResult> {
  const p = protect(format, text);
  const { prompt, addBos, stop } = buildPrompt(model.template, src, tgt, p.masked);
  let raw: string;
  try {
    raw = await engine.generate({
      reqId,
      modelPath: model.path,
      prompt,
      addBos,
      maxTokens: Math.min(1024, 64 + p.masked.length * 4),
      stop,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return message === "cancelled" ? { ok: false, reason: "cancelled" } : { ok: false, reason: "error", message };
  }
  const r = restore(cleanOutput(raw), p);
  return r.ok ? { ok: true, text: r.text } : { ok: false, reason: "unsafe" };
}
