import type { Format } from "../core/model";

export interface Protected {
  masked: string;
  tokens: string[];
  lead: string;
  trail: string;
}

export function token(n: number): string {
  return `[[${n}]]`;
}

const TAG = String.raw`<\/?[A-Za-z0-9][\w-]*(?:\s[^<>]*)?\/?>`;
const LITERAL = String.raw`\[\[\d+\]\]`;
/** Chat-template special tokens (`<|im_end|>`…) must never reach the prompt as live text. */
const SPECIAL = String.raw`<\|[^|>]*\|>`;
const PATTERNS: Record<Format, RegExp> = {
  "next-i18next": new RegExp(String.raw`\{\{[^}]*\}\}|\$t\([^)]*\)|${TAG}|${LITERAL}|${SPECIAL}`, "g"),
  paraglide: new RegExp(String.raw`\{\s*[A-Za-z_]\w*\s*\}|${TAG}|${LITERAL}|${SPECIAL}`, "g"),
};

export function protect(format: Format, text: string): Protected {
  const [, lead, middle, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  const tokens: string[] = [];
  const masked = middle.replace(PATTERNS[format], (m) => {
    tokens.push(m);
    return token(tokens.length - 1);
  });
  return { masked, tokens, lead, trail };
}

export function restore(output: string, p: Protected): { ok: true; text: string } | { ok: false } {
  const body = output.trim();
  if (!body) return { ok: false };
  const seen = new Array<number>(p.tokens.length).fill(0);
  for (const m of body.matchAll(/\[\[(\d+)\]\]/g)) {
    const i = Number(m[1]);
    if (i >= p.tokens.length) return { ok: false };
    seen[i]++;
  }
  if (seen.some((c) => c !== 1)) return { ok: false };
  const text = body.replace(/\[\[(\d+)\]\]/g, (_, i) => p.tokens[Number(i)]);
  return { ok: true, text: p.lead + text + p.trail };
}
