import { parseKeyId, keyId, type KeyId, type ProjectData } from "./model";

export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;

export function splitPlural(key: string): { base: string; category: string } | null {
  const i = key.lastIndexOf("_");
  if (i <= 0) return null;
  const category = key.slice(i + 1);
  if (!(PLURAL_CATEGORIES as readonly string[]).includes(category)) return null;
  return { base: key.slice(0, i), category };
}

const catCache = new Map<string, readonly string[]>();
export function pluralCategories(locale: string): readonly string[] {
  let r = catCache.get(locale);
  if (!r) {
    let cats: string[];
    try {
      cats = new Intl.PluralRules(locale).resolvedOptions().pluralCategories as string[];
    } catch {
      cats = ["one", "other"];
    }
    r = Object.freeze(PLURAL_CATEGORIES.filter((c) => cats.includes(c)));
    catCache.set(locale, r);
  }
  return r;
}

/** Plural groups: `${ns}::${base}` -> existing categories (only groups that have `_other`). */
function pluralGroups(data: ProjectData): Map<string, { ns: string; base: string; cats: Set<string>; lastIdx: number }> {
  const groups = new Map<string, { ns: string; base: string; cats: Set<string>; lastIdx: number }>();
  data.keyOrder.forEach((id, idx) => {
    const { ns, key } = parseKeyId(id);
    const sp = splitPlural(key);
    if (!sp) return;
    const gid = keyId(ns, sp.base);
    let g = groups.get(gid);
    if (!g) groups.set(gid, (g = { ns, base: sp.base, cats: new Set(), lastIdx: idx }));
    g.cats.add(sp.category);
    g.lastIdx = idx;
  });
  for (const [gid, g] of groups) if (!g.cats.has("other")) groups.delete(gid);
  return groups;
}

const otherKeysCache = new WeakMap<KeyId[], Set<KeyId>>();
function otherKeys(order: KeyId[]): Set<KeyId> {
  let s = otherKeysCache.get(order);
  if (!s) {
    s = new Set(order.filter((id) => id.endsWith("_other")));
    otherKeysCache.set(order, s);
  }
  return s;
}

export function isApplicable(data: ProjectData, id: KeyId, locale: string): boolean {
  if (data.format === "paraglide") return true;
  const { ns, key } = parseKeyId(id);
  const sp = splitPlural(key);
  if (!sp) return true;
  const hasOther = otherKeys(data.keyOrder).has(keyId(ns, `${sp.base}_other`));
  if (!hasOther) return true;
  return pluralCategories(locale).includes(sp.category);
}

export function expandPluralKeys(data: ProjectData): KeyId[] {
  if (data.format !== "next-i18next") return data.keyOrder;
  const needed = new Set<string>();
  for (const l of data.locales) for (const c of pluralCategories(l)) needed.add(c);
  const inserts = new Map<number, KeyId[]>();
  for (const g of pluralGroups(data).values()) {
    const add = PLURAL_CATEGORIES.filter((c) => needed.has(c) && !g.cats.has(c)).map((c) => keyId(g.ns, `${g.base}_${c}`));
    if (add.length) inserts.set(g.lastIdx, add);
  }
  const out: KeyId[] = [];
  data.keyOrder.forEach((id, idx) => {
    out.push(id);
    const add = inserts.get(idx);
    if (add) out.push(...add);
  });
  return out;
}
