import { keyId, parseKeyId, type KeyId } from "../core/model";
import { splitPlural } from "../core/plurals";
import type { ProjectSession } from "../core/session";

/** Base-locale text to translate for a key, or null when there is nothing safe to send. */
export function sourceText(session: ProjectSession, id: KeyId): string | null {
  const base = session.data.baseLocale;
  let v = session.value(id, base);
  if (!v) {
    const { ns, key } = parseKeyId(id);
    const pl = splitPlural(key);
    if (pl) v = session.value(keyId(ns, `${pl.base}_other`), base);
  }
  if (!v || v.kind !== "text" || !v.text.trim()) return null;
  return v.text;
}
