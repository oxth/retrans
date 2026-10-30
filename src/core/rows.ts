import { keyId, type KeyId, type MessageValue, parseKeyId, type Status } from "./model";
import { isApplicable, splitPlural } from "./plurals";
import type { ProjectSession } from "./session";

export interface RowFilter {
  search: string;
  ns: string | "all";
  locales: string[]; // visible target locales
  missing: boolean;
  needsReview: boolean;
  machine: boolean;
  status: Status | "all";
}

export interface Row {
  id: KeyId;
  ns: string;
  key: string;
  pluralGroup?: string;
  pluralCategory?: string;
}

function valueText(v: MessageValue | undefined): string {
  if (!v) return "";
  return v.kind === "text" ? v.text : (JSON.stringify(v.raw) ?? "");
}

export function buildRows(s: ProjectSession, f: RowFilter): Row[] {
  const data = s.data;
  const needle = f.search.toLocaleLowerCase();
  const needMeta = f.needsReview || f.machine || f.status !== "all";
  const rows: Row[] = [];

  const otherIds = new Set<KeyId>();
  for (const id of data.keyOrder) if (id.endsWith("_other")) otherIds.add(id);

  for (const id of data.keyOrder) {
    const { ns, key } = parseKeyId(id);
    if (f.ns !== "all" && ns !== f.ns) continue;

    if (needle) {
      let hit = key.toLocaleLowerCase().includes(needle);
      const cells = data.values.get(id);
      if (!hit && cells) {
        hit = valueText(cells.get(data.baseLocale)).toLocaleLowerCase().includes(needle);
        for (let i = 0; !hit && i < f.locales.length; i++) {
          hit = valueText(cells.get(f.locales[i])).toLocaleLowerCase().includes(needle);
        }
      }
      if (!hit) continue;
    }

    if (f.missing || needMeta) {
      const cells = data.values.get(id);
      let missing = !f.missing;
      let review = !f.needsReview;
      let machine = !f.machine;
      let status = f.status === "all";
      for (const l of f.locales) {
        if (!isApplicable(data, id, l)) continue;
        if (!missing && !cells?.get(l)) missing = true;
        if (needMeta && !(review && machine && status)) {
          const m = s.meta(id, l);
          if (m.needsReview) review = true;
          if (m.machine) machine = true;
          if (f.status !== "all" && m.status === f.status) status = true;
        }
      }
      if (!(missing && review && machine && status)) continue;
    }

    const row: Row = { id, ns, key };
    const sp = splitPlural(key);
    if (sp && otherIds.has(keyId(ns, `${sp.base}_other`))) {
      row.pluralGroup = sp.base;
      row.pluralCategory = sp.category;
    }
    rows.push(row);
  }
  return rows;
}

export function nextMissing(
  s: ProjectSession,
  rows: Row[],
  from: { id: KeyId; locale: string },
  locales: string[],
): { id: KeyId; locale: string } | null {
  const n = rows.length;
  const m = locales.length;
  if (!n || !m) return null;
  let r0 = rows.findIndex((r) => r.id === from.id);
  let l0 = locales.indexOf(from.locale);
  if (r0 < 0) { r0 = -1; l0 = m - 1; } // start at first row
  else if (l0 < 0) l0 = -1; // unknown locale: start of that row
  const total = n * m;
  const start = r0 * m + l0; // linear index of `from`
  for (let step = 1; step <= total; step++) {
    const idx = (((start + step) % total) + total) % total;
    const row = rows[Math.floor(idx / m)];
    const locale = locales[idx % m];
    if (!isApplicable(s.data, row.id, locale)) continue;
    if (!s.value(row.id, locale)) return { id: row.id, locale };
  }
  return null;
}
