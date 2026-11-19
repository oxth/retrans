/**
 * The sample project on the start screen: a small workspace to try Retrans on (and to take the
 * tour on) without your own files. English base with French and Japanese, and a bit of every
 * status: reviewed, not reviewed yet, AI-made, source changed and missing.
 */
import { hashValue } from "../core/hash";
import { keyId } from "../core/model";
import { serializeState, STATE_PATH, type StateEntry, type StateFile } from "../core/state-file";
import { joinPath, type Fs } from "../platform/fs";
import { WORKSPACE_DIR } from "./meta";
import { createWorkspace } from "./store";

export const SAMPLE_NAME = "Sample project";
const GROUP = "common";

/** Per key: English, then French and Japanese (null: missing). */
const TEXTS: Array<[key: string, en: string, fr: string | null, ja: string | null]> = [
  ["app_title", "Recipe Box", "Boîte à recettes", "レシピボックス"],
  ["nav_home", "Home", "Accueil", "ホーム"],
  ["nav_favorites", "Favorites", "Favoris", "お気に入り"],
  ["nav_settings", "Settings", "Paramètres", "設定"],
  ["search_placeholder", "Search recipes", "Rechercher des recettes", null],
  ["recipe_servings", "Serves {{count}}", "Pour {{count}} personnes", "{{count}}人分"],
  ["recipe_time", "Ready in {{minutes}} minutes", "Prêt en {{minutes}} minutes", null],
  ["button_save", "Save recipe", "Enregistrer la recette", "レシピを保存"],
  ["button_share", "Share", null, "共有"],
  ["button_delete", "Delete", "Supprimer", "削除"],
  ["empty_favorites", "You haven't saved any recipes yet.", null, null],
  ["welcome_message", "Welcome back! What are we cooking today?", "Bon retour ! Qu'est-ce qu'on cuisine aujourd'hui ?", "おかえりなさい！今日は何を作りますか？"],
];

/** Status records, per key and language; cells not listed are "Translated, not reviewed yet". */
const REVIEWED: Array<[key: string, locale: string]> = [
  ["app_title", "fr"], ["app_title", "ja"], ["nav_home", "fr"], ["nav_home", "ja"],
  ["nav_favorites", "fr"], ["nav_settings", "ja"], ["button_delete", "fr"], ["button_delete", "ja"],
];
/** Translated by AI and not reviewed yet: shown with the AI tag. */
const MACHINE: Array<[key: string, locale: string]> = [["recipe_servings", "ja"], ["button_save", "ja"]];
/** Translated from an older English text, so they show "Source changed". */
const OLD_BASE: Record<string, string> = { welcome_message: "Welcome back!" };

/** Makes the sample project in `root` (an empty or missing folder). */
export async function createSampleProject(fs: Fs, root: string): Promise<void> {
  const locales = ["en", "fr", "ja"];
  for (const [i, locale] of locales.entries()) {
    const doc: Record<string, string> = {};
    for (const row of TEXTS) {
      const text = row[i + 1];
      if (text !== null) doc[row[0]] = text;
    }
    await fs.writeTextAtomic(joinPath(root, WORKSPACE_DIR, locale, `${GROUP}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  }

  const base = (key: string) => hashValue({ kind: "text", text: TEXTS.find((r) => r[0] === key)![1] });
  const state: StateFile = { version: 1, project: { baseLocale: "en" }, entries: {} };
  const put = (key: string, locale: string, entry: StateEntry) =>
    void ((state.entries[keyId(GROUP, key)] ??= {})[locale] = entry);
  for (const [key, locale] of REVIEWED) put(key, locale, { s: "reviewed", h: base(key) });
  for (const [key, locale] of MACHINE) put(key, locale, { s: "translated", h: base(key), m: true });
  for (const [key, old] of Object.entries(OLD_BASE)) {
    for (const locale of ["fr", "ja"]) put(key, locale, { s: "reviewed", h: hashValue({ kind: "text", text: old }) });
  }
  await fs.writeTextAtomic(joinPath(root, STATE_PATH), serializeState(state));

  // Last: it keeps the files above and the state, and writes the meta that makes this a workspace.
  await createWorkspace(fs, root, { name: SAMPLE_NAME, baseLocale: "en", locales: ["fr", "ja"], group: GROUP });
}
