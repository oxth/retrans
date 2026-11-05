import type { KeyId } from "../core/model";

export interface BatchString {
  id: KeyId;
  key: string;
  group: string;
  masked: string;
  base: string;
  others: Record<string, string>;
}

export function buildBatchPrompt(a: {
  src: string;
  targets: string[];
  strings: BatchString[];
  instructions: string;
}): { system: string; user: string } {
  return {
    system:
      "You are Retrans, an app that translates software user-interface text. " +
      "Keep every placeholder token like [[0]] exactly as written. Keep line breaks exactly. " +
      "Output only JSON. " +
      a.instructions,
    user: JSON.stringify({
      source: a.src,
      targets: a.targets,
      strings: a.strings.map((s) => ({
        id: s.id,
        key: s.key,
        group: s.group,
        text: s.masked,
        base: s.base,
        others: s.others,
      })),
    }),
  };
}

export function parseBatchReply(
  text: string,
  ids: KeyId[],
  targets: string[],
): { values: Map<KeyId, Map<string, string>>; missing: Array<{ id: KeyId; locale: string }> } {
  const values = new Map<KeyId, Map<string, string>>();
  const idSet = new Set(ids);
  const targetSet = new Set(targets);

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    return { values, missing: expectedMissing(ids, targets, values) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { values, missing: expectedMissing(ids, targets, values) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { values, missing: expectedMissing(ids, targets, values) };
  }

  for (const id of ids) {
    const idValue = (parsed as Record<string, unknown>)[id];
    if (!idSet.has(id) || !idValue || typeof idValue !== "object" || Array.isArray(idValue)) continue;
    for (const locale of targets) {
      if (!targetSet.has(locale)) continue;
      const translated = (idValue as Record<string, unknown>)[locale];
      if (typeof translated !== "string") continue;
      let byLocale = values.get(id);
      if (!byLocale) {
        byLocale = new Map<string, string>();
        values.set(id, byLocale);
      }
      byLocale.set(locale, translated);
    }
  }

  return { values, missing: expectedMissing(ids, targets, values) };
}

function expectedMissing(
  ids: KeyId[],
  targets: string[],
  values: Map<KeyId, Map<string, string>>,
): Array<{ id: KeyId; locale: string }> {
  const missing: Array<{ id: KeyId; locale: string }> = [];
  for (const id of ids) {
    for (const locale of targets) {
      if (!values.get(id)?.has(locale)) missing.push({ id, locale });
    }
  }
  return missing;
}

export function combineInstructions(
  global: string | undefined,
  project: string | undefined,
  locale: string | undefined,
): string {
  return [global, project, locale]
    .map((s) => s?.trim() ?? "")
    .filter((s) => s.length > 0)
    .join("\n\n");
}
