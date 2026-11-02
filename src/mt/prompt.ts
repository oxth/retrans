import type { PromptTemplate } from "./catalog";

export function normalizeLocale(locale: string): string {
  return locale.replace(/_/g, "-");
}

export function languageName(locale: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(normalizeLocale(locale)) ?? locale;
  } catch {
    return locale;
  }
}

export function buildPrompt(
  t: PromptTemplate,
  src: string,
  tgt: string,
  masked: string,
): { prompt: string; addBos: boolean; stop: string[] } {
  const S = languageName(src);
  const T = languageName(tgt);
  const s = normalizeLocale(src);
  const tc = normalizeLocale(tgt);
  if (t === "translategemma") {
    return {
      prompt:
        `<start_of_turn>user\nYou are a professional ${S} (${s}) to ${T} (${tc}) translator. Your goal is to accurately convey the meaning and nuances of the original ${S} text while adhering to ${T} grammar, vocabulary, and cultural sensitivities.\n` +
        `Produce only the ${T} translation, without any additional explanations or commentary. Please translate the following ${S} text into ${T}:\n\n\n${masked}<end_of_turn>\n<start_of_turn>model\n`,
      addBos: true,
      stop: ["<end_of_turn>"],
    };
  }
  return {
    prompt:
      `<|im_start|>system\nYou translate software user-interface text from ${S} (${s}) to ${T} (${tc}). Output only the translation. Copy every token like [[0]] exactly as written and keep line breaks.<|im_end|>\n` +
      `<|im_start|>user\n${masked}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`,
    addBos: false,
    stop: ["<|im_end|>"],
  };
}

/** Strips chat markup and wrapping quotes the model added (quotes the `source` itself is wrapped in are kept). */
export function cleanOutput(raw: string, source?: string): string {
  let s = raw;
  const cut = s.search(/<end_of_turn>|<\|im_end\|>/);
  if (cut >= 0) s = s.slice(0, cut);
  s = s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const pairs: [string, string][] = [['"', '"'], ["“", "”"], ["「", "」"]];
  for (const [o, c] of pairs) {
    if (s.length >= 2 && s.startsWith(o) && s.endsWith(c)) {
      const src = source?.trim();
      if (src && src.length >= 2 && src.startsWith(o) && src.endsWith(c)) return s;
      return s.slice(o.length, s.length - c.length);
    }
  }
  return s;
}
