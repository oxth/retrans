/** The plugin's decisions, kept free of the `figma` global so they can be unit tested. */
import type { PreviewBundle, PreviewFlag, PreviewResults, Verdict } from "../../src/preview/format";

export interface Box { x: number; y: number; width: number; height: number }
/** `needed` is the box the text takes when allowed to grow in height at its current width. */
export interface TextShape { box: Box; autoResize: "NONE" | "HEIGHT" | "WIDTH_AND_HEIGHT" | "TRUNCATE"; needed: Box }

export interface PluginState {
  bundle: PreviewBundle | null;
  fileName: string | null;
  /**
   * The Retrans tab id (from /v1/projects) the drafts were fetched from; absent for a file.
   * Tab ids change when Retrans reopens a project, so sending goes by the bundle's sourceProjectId instead.
   */
  projectId?: string;
  rows: Array<{ key: string; text: string; flag: PreviewFlag; found: boolean; verdict: Verdict | null; note?: string }>;
}

const EPS = 0.5;

/** A library variable used in another file has an id ending in `/<id in the library>`. */
export function matchesVariable(boundId: string, bundleId: string): boolean {
  if (boundId === bundleId) return true;
  const local = bundleId.replace(/^VariableID:/, "");
  return boundId.startsWith("VariableID:") && boundId.endsWith(`/${local}`);
}

/** How far the text spills: past its own box for fixed boxes, past its parent for growing text. */
function spill(s: TextShape, parent: Box | null): number {
  if (s.autoResize === "NONE" || s.autoResize === "TRUNCATE") return Math.max(0, s.needed.height - s.box.height);
  if (!parent) return 0;
  return Math.max(0, s.box.y + s.box.height - (parent.y + parent.height), s.box.x + s.box.width - (parent.x + parent.width));
}

/** True when the new text spills further than the original did. */
export function isOverflow(before: TextShape, after: TextShape, parent: Box | null): boolean {
  return spill(after, parent) > spill(before, parent) + EPS;
}

export function planCopies(
  selected: string[],
  existing: Array<{ copyId: string; sourceId: string; locale: string }>,
  locale: string,
): { remove: string[]; copy: string[] } {
  const sourceOf = new Map(existing.map((e) => [e.copyId, e.sourceId]));
  const copy = [...new Set(selected.map((id) => sourceOf.get(id) ?? id))];
  const remove = existing.filter((e) => e.locale === locale && copy.includes(e.sourceId)).map((e) => e.copyId);
  return { remove, copy };
}

/** Pages and sections place children freely; anywhere else (auto-layout, nested frames) the copy goes on the page. */
export function copyPlacement(source: { x: number; y: number; width: number; abs: Box; parentType: string }, gap = 80): { into: "parent" | "page"; x: number; y: number } {
  if (source.parentType === "PAGE" || source.parentType === "SECTION") return { into: "parent", x: source.x + source.width + gap, y: source.y };
  return { into: "page", x: source.abs.x + source.abs.width + gap, y: source.abs.y };
}

export function toResults(state: PluginState, now: Date): PreviewResults {
  const b = state.bundle;
  if (!b) throw new Error("Load a preview file first.");
  const byKey = new Map(b.strings.map((s) => [s.key, s]));
  const results = state.rows.flatMap((r) => {
    const s = byKey.get(r.key);
    if (!s || !r.verdict) return [];
    return [{ key: r.key, hash: s.hash, verdict: r.verdict, ...(r.note?.trim() ? { note: r.note } : {}), flag: r.flag }];
  });
  return { retransPreviewResults: 1, sourceProjectId: b.sourceProjectId, locale: b.locale, checkedAt: now.toISOString(), results };
}
