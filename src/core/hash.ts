import type { MessageValue } from "./model";

/** FNV-1a 32-bit over UTF-8 bytes, 8 lowercase hex chars. */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function hashValue(v: MessageValue | undefined): string {
  if (!v) return "";
  return v.kind === "text" ? hashText(v.text) : hashText(JSON.stringify(v.raw));
}
