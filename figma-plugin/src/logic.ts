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
  /** The frame being previewed now and how much of its text the drafts reach; absent with no preview. */
  preview?: PreviewInfo;
  /** Marks per language, kept when switching away so switching back brings them back. */
  marks?: Record<string, Record<string, SavedMark>>;
}

/** A mark, with the text it was given for: it only comes back while the text is unchanged. */
export interface SavedMark { text: string; verdict: Verdict; note?: string }

export interface PreviewInfo { frameName: string; textLayers: number; linked: number }
export interface SelectedNode { id: string; topFrameId: string | null; inPreview: boolean }

/** The frame to preview for a selection: its first node's top-level frame; "keep" for nothing or a preview copy. */
export function frameToPreview(selection: SelectedNode[]): string | "keep" {
  const first = selection[0];
  if (!first || first.inPreview || !first.topFrameId) return "keep";
  return first.topFrameId;
}

/** How much of the previewed frame the drafts reach, as information; null when all of it. */
export function linkNote(p: PreviewInfo): string | null {
  if (p.textLayers === 0) return "This frame has no text layers.";
  if (p.linked >= p.textLayers) return null;
  if (p.linked === 0) {
    return `This frame's text isn't linked to these drafts: none of its ${p.textLayers} text layers use the variables you imported into Retrans.`;
  }
  return `${p.linked} of ${p.textLayers} text layers are linked.`;
}

type Row = PluginState["rows"][number];

/**
 * The frame to preview now, or null to leave things as they are. A copy deleted by hand is remade
 * when its frame is selected again; `force` (new drafts) re-previews the current frame.
 */
export function previewNeeded(target: string | "keep", current: { sourceId: string | null; copyAlive: boolean }, force: boolean): string | null {
  const frame = target === "keep" ? (force ? current.sourceId : null) : target;
  if (!frame) return null;
  if (frame === current.sourceId && current.copyAlive && !force) return null;
  return frame;
}

/** Loads new drafts: marks for the language being left are kept, marks for the new one come back. */
export function switchDrafts(prev: PluginState, bundle: PreviewBundle, fileName: string, projectId?: string): PluginState {
  const marks = { ...(prev.marks ?? {}) };
  if (prev.bundle) {
    const kept: Record<string, SavedMark> = {};
    for (const r of prev.rows) if (r.verdict) kept[r.key] = { text: r.text, verdict: r.verdict, ...(r.note ? { note: r.note } : {}) };
    marks[prev.bundle.locale] = kept;
  }
  const saved = marks[bundle.locale] ?? {};
  const rows = bundle.strings.map((str) => {
    const m = saved[str.key];
    const keep = m && m.text === str.text;
    return { key: str.key, text: str.text, flag: null, found: false, verdict: keep ? m.verdict : null, ...(keep && m.note ? { note: m.note } : {}) };
  });
  return { bundle, fileName, ...(projectId ? { projectId } : {}), rows, marks };
}

/** Where the designer is: getting drafts, selecting a frame, or checking its strings. */
export function currentStep(state: PluginState): "drafts" | "select" | "check" {
  if (!state.bundle) return "drafts";
  return state.preview ? "check" : "select";
}

export function progress(rows: Row[]): { total: number; found: number; flagged: number; checked: number; missing: number } {
  const found = rows.filter((r) => r.found);
  return {
    total: rows.length,
    found: found.length,
    flagged: found.filter((r) => r.flag).length,
    checked: rows.filter((r) => r.verdict).length,
    missing: rows.length - found.length,
  };
}

/** "Mark the rest as Fits": strings on the frames, not flagged and not decided yet. */
export function markRestFits(rows: Row[]): Row[] {
  return rows.map((r) => (r.found && !r.flag && r.verdict === null ? { ...r, verdict: "fits" } : r));
}

/** A frame is previewed, but none of its text is bound to a variable in the drafts. */
export function nothingLinked(state: PluginState): boolean {
  return state.preview?.linked === 0;
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

/** What the designer has marked, so "Sent" and "Copied" can tell when the marks changed since. */
export function resultsKey(state: PluginState): string {
  return JSON.stringify(state.rows.map((r) => [r.key, r.verdict, r.note ?? ""]));
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
