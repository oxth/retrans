/**
 * Builds a designer preview bundle: the drafts of one language that are linked to a Figma variable,
 * so the Retrans Preview plugin can show them in copies of the real frames.
 */
import { hashValue } from "../core/hash";
import { isTranslated } from "../core/model";
import type { ProjectSession } from "../core/session";
import { varIdOfRow } from "../figma/meta";
import type { PreviewBundle, PreviewString } from "./format";

export interface BuiltBundle { bundle: PreviewBundle; leftOut: { complex: number; noVariable: number } }

export function buildPreviewBundle(
  session: ProjectSession,
  locale: string,
  opts: { includeReviewed: boolean; now?: Date },
): BuiltBundle {
  const { baseLocale, keyOrder } = session.data;
  if (locale === baseLocale) throw new Error("Pick a language other than the base language.");
  const sourceProjectId = session.state.project.id;
  if (!sourceProjectId) throw new Error("Save your changes first.");
  const meta = session.workspace;
  const strings: PreviewString[] = [];
  const leftOut = { complex: 0, noVariable: 0 };

  for (const key of keyOrder) {
    const value = session.value(key, locale);
    if (!isTranslated(value)) continue;
    const m = session.meta(key, locale);
    if (m.status === "reviewed" && !opts.includeReviewed) continue;
    const figmaVariableId = meta ? varIdOfRow(meta, key) : null;
    if (!figmaVariableId) {
      leftOut.noVariable++;
      continue;
    }
    const base = session.value(key, baseLocale);
    if (value!.kind !== "text" || base?.kind !== "text") {
      leftOut.complex++;
      continue;
    }
    strings.push({
      key,
      figmaVariableId,
      base: base.text,
      text: value!.text,
      hash: hashValue(value),
      status: m.status === "reviewed" ? "reviewed" : "translated",
      machine: m.machine,
    });
  }

  const bundle: PreviewBundle = {
    retransPreview: 1,
    sourceProjectId,
    exportedAt: (opts.now ?? new Date()).toISOString(),
    baseLocale,
    locale,
    strings,
  };
  return { bundle, leftOut };
}
