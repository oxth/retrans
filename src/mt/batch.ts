import { isTranslated, type KeyId } from "../core/model";
import { buildRows } from "../core/rows";
import type { ProjectSession } from "../core/session";
import { sourceText } from "./source";
import type { TranslateResult } from "./translate";

const TOO_LONG = "Text is too long to translate";

export interface BatchItem {
  id: KeyId;
  source: string;
}

export interface BatchResult {
  translated: number;
  unsafe: KeyId[];
  failed: Array<{ id: KeyId; message: string }>;
  skipped: number;
  cancelled: boolean;
}

/** Cells missing for `locale` that have translatable base text, in row order. */
export function missingItems(session: ProjectSession, locale: string, ns: string | "all"): BatchItem[] {
  const rows = buildRows(session, {
    search: "",
    ns,
    locales: [locale],
    missing: true,
    needsReview: false,
    machine: false,
    status: "all",
  });
  const items: BatchItem[] = [];
  for (const { id } of rows) {
    if (isTranslated(session.value(id, locale)) || session.readOnlyReason(id, locale) !== null) continue;
    const source = sourceText(session, id);
    if (source !== null) items.push({ id, source });
  }
  return items;
}

export async function translateMissing(
  session: ProjectSession,
  items: BatchItem[],
  locale: string,
  translate: (source: string) => Promise<TranslateResult>,
  onProgress: (p: { done: number; total: number; current: KeyId | null }) => void,
  signal: AbortSignal,
): Promise<BatchResult> {
  const result: BatchResult = { translated: 0, unsafe: [], failed: [], skipped: 0, cancelled: false };
  const total = items.length;
  onProgress({ done: 0, total, current: null });

  for (let i = 0; i < total; i++) {
    if (signal.aborted) {
      result.cancelled = true;
      break;
    }
    const { id, source } = items[i];
    const r = await translate(source);
    if (r.ok) {
      // The cell may have been filled or the key deleted while translating.
      let written = false;
      try {
        if (!isTranslated(session.value(id, locale))) {
          session.setText(id, locale, r.text, { machine: true });
          written = true;
        }
      } catch {
        written = false;
      }
      if (written) result.translated++;
      else result.skipped++;
    } else if (r.reason === "unsafe") {
      result.unsafe.push(id);
    } else if (r.reason === "error") {
      result.failed.push({ id, message: r.message });
      // Only an over-long item is specific to that item; any other error (model won't load,
      // engine crashed…) would fail every remaining item the same way.
      if (r.message !== TOO_LONG) break;
    } else {
      result.cancelled = true;
      break;
    }
    onProgress({ done: i + 1, total, current: items[i + 1]?.id ?? null });
  }
  return result;
}
