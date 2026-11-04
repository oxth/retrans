/**
 * Giving a Figma string a code key, or linking it to a key the code already has (spec C3–C4).
 * Linked strings are one translation: the row is the code key's row, and the Figma variable
 * points at it.
 */
import { type KeyId, type MessageValue, parseKeyId, valuesEqual } from "../core/model";
import type { ProjectSession } from "../core/session";
import { KeyError } from "../core/session-helpers";
import { figmaGroups } from "./meta";
import type { FigmaConflict } from "./sync";

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const textOf = (v: MessageValue | undefined) => (v?.kind === "text" ? v.text : undefined);

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  const max = Math.max(x.length, y.length);
  return max === 0 ? 0 : 1 - levenshtein(x, y) / max;
}

/**
 * Code keys whose text looks like the Figma string's: base-language similarity (1 = equal), plus
 * 0.1 for every other language with exactly the same text. Scores below 0.6 are left out.
 */
export function suggestLinks(session: ProjectSession, row: KeyId, limit = 5): KeyId[] {
  const meta = session.workspace;
  if (!meta) return [];
  const figma = figmaGroups(meta);
  const { baseLocale, locales } = session.data;
  const baseText = textOf(session.value(row, baseLocale));
  if (baseText === undefined) return [];
  const scored: Array<{ id: KeyId; score: number; at: number }> = [];
  session.data.keyOrder.forEach((id, at) => {
    if (figma.has(parseKeyId(id).ns)) return;
    const t = textOf(session.value(id, baseLocale));
    if (t === undefined) return;
    let score = similarity(baseText, t);
    if (score < 0.6) return;
    for (const l of locales) {
      if (l === baseLocale) continue;
      const a = textOf(session.value(row, l));
      if (a !== undefined && a === textOf(session.value(id, l))) score += 0.1;
    }
    scored.push({ id, score, at });
  });
  return scored
    .sort((x, y) => y.score - x.score || x.at - y.at)
    .slice(0, limit)
    .map((s) => s.id);
}

/** Moves a Figma row into a code group under its new key; its Figma variable follows it. */
export function setCodeKey(session: ProjectSession, row: KeyId, to: KeyId): KeyId {
  const meta = session.workspace;
  const f = meta?.figma;
  if (!meta || !f) throw new Error("This workspace has no Figma source");
  if (figmaGroups(meta).has(parseKeyId(to).ns)) throw new KeyError("invalid", "Pick a code group, not a Figma group");
  let moved = row;
  session.batch(() => {
    moved = session.moveKey(row, to);
    const cur = session.workspace!.figma!;
    const vars = Object.fromEntries(
      Object.entries(cur.vars).map(([id, link]) => [id, link.row === row ? { ...link, row: moved } : link]),
    );
    session.setWorkspaceMeta({ figma: { ...cur, vars } });
  });
  return moved;
}

/**
 * Links a Figma row to an existing code key: languages the code lacks take the Figma text, equal
 * ones merge, and each differing language is returned as a conflict (the code text stays until
 * it's resolved). The Figma row is removed and its variable points at `target`.
 */
export function linkToKey(session: ProjectSession, row: KeyId, target: KeyId): FigmaConflict[] {
  const meta = session.workspace;
  const f = meta?.figma;
  if (!meta || !f) throw new Error("This workspace has no Figma source");
  if (figmaGroups(meta).has(parseKeyId(target).ns)) throw new KeyError("invalid", "Pick a code key, not a Figma string");
  const varIds = Object.keys(f.vars).filter((id) => f.vars[id].row === row);
  const conflicts: FigmaConflict[] = [];
  session.batch(() => {
    for (const locale of session.data.locales) {
      const fig = session.value(row, locale);
      if (fig === undefined) continue;
      const code = session.value(target, locale);
      if (code === undefined) {
        session.importCell(target, locale, fig, undefined);
        continue;
      }
      if (valuesEqual(code, fig)) continue;
      const c: FigmaConflict = { id: target, locale, mine: code, theirs: fig };
      const base = varIds.length ? f.baseline[varIds[0]]?.[locale] : undefined;
      if (base !== undefined) c.base = { kind: "text", text: base };
      conflicts.push(c);
    }
    const cur = session.workspace!.figma!;
    const vars = Object.fromEntries(
      Object.entries(cur.vars).map(([id, link]) => [id, link.row === row ? { ...link, row: target } : link]),
    );
    session.setWorkspaceMeta({ figma: { ...cur, vars } });
    session.deleteKey(row);
  });
  return conflicts;
}
