# Paratrans Local Machine Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add offline machine translation to Paratrans: download a model on demand, suggest translations for missing cells, and translate all missing cells for a language, with every result marked `machine=true` for review.

**Architecture:**
- **TypeScript (testable without a model):**
  - placeholder protection
  - prompt building
  - output cleanup and safety checks
  - batch logic
  - all UI
- **Rust (two small modules):**
  - `mt/download.rs` streams pinned Hugging Face files into the app data folder, with resume and SHA-256 checks. It is the only code in the app that uses the network.
  - `mt/engine.rs` embeds llama.cpp via `llama-cpp-2`. It loads the model on first use, generates text from a prompt string it is given, supports cancelling, and unloads after 5 idle minutes.
- The model catalog is a JSON file shipped with the app.

**Tech Stack:**
- Existing: Tauri 2, React 19, TS 6, Vitest 5, Zustand, `@tauri-apps/plugin-store`, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-opener`.
- New (Rust): `llama-cpp-2` 0.1.160, `reqwest` 0.13 (native-tls, stream), `sha2` 0.11, `futures-util` 0.3, `tokio` 1, `tempfile` 3 (dev only).

**Spec:** `docs/superpowers/specs/2026-10-30-paratrans-design.md` §9 (also §4 anti-goals, §8.3 status rules, §11 quality bar).

## Global Constraints

**Off by default:**
- `MtSettings.enabled` defaults to `false`.
- No model is downloaded and the engine loads nothing until the user enables translation and picks a model.

**Network:**
- The only network code is `src-tauri/src/mt/download.rs`.
- `mt_download_start` rejects any URL that doesn't start with `https://huggingface.co/`.
- Translation never touches the network.

**Machine output is never final:**
- An accepted suggestion or batch result is written only via `session.setText(id, locale, text, { machine: true })`.
- Nothing in this plan calls `markReviewed`.

**Models:**
- Never bundled, never self-hosted.
- Each catalog entry pins an exact URL (`/resolve/<commit>/<file>`), byte size and SHA-256.
- Models are stored in `<appDataDir>/models/`, never in the project.

**Installer:** under ~40 MB. Task 6 measures it.

**Engine acceleration:**
- macOS: `llama-cpp-2` with the `metal` feature and all layers on the GPU.
- Other targets: default features off, CPU only.
- Never build with `target-cpu=native`, so builds run on any x64 machine.

**Exact user-facing copy:**
- Unsafe result: `Couldn't translate safely`
- Too long: `Text is too long to translate`
- Load failure: `Couldn't load the model file. Is it a llama.cpp GGUF model?`

**Skipped content:**
- Complex Paraglide messages (`kind: "complex"`) are never sent to the model.
- Base text that is empty or only whitespace is never sent either.

**Verification:**
- `pnpm test`, `pnpm exec tsc --noEmit`, and `cargo test` (in `src-tauri`) pass after every task.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Branch:** work on `feat/local-mt`, created from `main`.

## Review Focus

1. **Edits during a batch.**
   - Trigger: a cell gets filled by a file reload (git pull) or a key gets deleted while "Translate missing" runs.
   - Expected: the batch skips that cell. It never overwrites a value or crashes.
   - Tested in Task 4.
2. **Interrupted or bad downloads.**
   - Triggers: the app quits mid-download, the server ignores `Range` (returns 200), the checksum doesn't match, or the server returns 416 for an already-complete `.part`.
   - Expected: resume where possible, restart cleanly otherwise, and never keep a corrupt file.
   - Tested in Task 5.
3. **Messy model output.**
   - Triggers: a token is dropped, duplicated or invented; the output is wrapped in quotes; trailing `<end_of_turn>` or a `<think>` block appears; the source text has leading or trailing spaces.
   - Expected: restore exactly or report `Couldn't translate safely`, and keep the source's outer whitespace.
   - Tested in Tasks 1–3.
4. **Stale suggestions.**
   - Trigger: the user leaves a cell before its suggestion arrives.
   - Expected: the result never shows in another cell, and the in-flight request is cancelled.
   - Tested in Task 9.
5. **Odd locale codes.**
   - Inputs: `en_US`, `zh-Hans`, `pt-BR`, or a non-BCP-47 folder name.
   - Expected: the prompt uses a readable language name or falls back to the raw code. It never throws.
   - Tested in Task 2.

---

## File Structure

```
src/mt/
  protect.ts            placeholder -> [[n]] tokens and back, with safety check
  catalog.json          model catalog (data)
  catalog.ts            catalog types + loader + modelKey helpers
  prompt.ts             per-template prompt strings, language names, output cleanup
  translate.ts          MtEngine interface, translateText(), request ids
  source.ts             sourceText(): which base text a target cell translates from
  batch.ts              missingItems(), translateMissing()
src/platform/mt.ts      invoke/listen wrappers for the Rust commands (tauriEngine, downloads)
src/platform/prefs.ts   + getMtSettings/setMtSettings
src/ui/mt-store.ts      zustand store: settings, files, downloads, readiness
src/ui/MtSettings.tsx   Settings -> Machine Translation section (catalog, license, downloads, custom file, test panel)
src/ui/Suggestion.tsx   useSuggestion() hook + SuggestionBox view
src/ui/TranslateMissingDialog.tsx
src-tauri/src/mt/mod.rs, download.rs, engine.rs
```

Modified:
- `src/ui/CellEditor.tsx`: suggestion slot and Cmd/Ctrl+Enter accept
- `src/ui/Cell.tsx`: wires the suggestion
- `src/ui/AppShell.tsx`: `commitMachine` action and the dialog
- `src/ui/Toolbar.tsx`: "Translate missing…" button
- `src/ui/SettingsPage.tsx`: mounts `MtSettings`
- `src/App.tsx`: calls `useMt.getState().init()` once
- `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `README.md`

---

### Task 1: Placeholder protection

**Files:**
- Create: `src/mt/protect.ts`
- Test: `src/mt/protect.test.ts`

**Interfaces:**
- Consumes: `Format` from `src/core/model.ts`.
- Produces:
  - `interface Protected { masked: string; tokens: string[]; lead: string; trail: string }`
  - `protect(format: Format, text: string): Protected`
  - `restore(output: string, p: Protected): { ok: true; text: string } | { ok: false }`
  - `token(n: number): string` returns `[[n]]`.

**Rules:**
- **What gets protected,** in one left-to-right scan; each match becomes `[[i]]` with i counting from 0:
  - next-i18next: `{{…}}`, `$t(…)`
  - Paraglide: `{name}`
  - Both formats: HTML-like tags matching `/<\/?[A-Za-z0-9][\w-]*(?:\s[^<>]*)?\/?>/` and any literal `[[digits]]` already in the text.
- **Whitespace:** leading and trailing whitespace is cut off into `lead`/`trail`, and `masked` is the trimmed middle.
- **`restore` succeeds only when** the output, after trimming:
  - is non-empty;
  - contains each `[[i]]` for i < tokens.length exactly once;
  - contains no other `[[n]]`.

  It then returns `lead + output-with-tokens-replaced + trail`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { protect, restore } from "./protect";

describe("protect", () => {
  it("masks i18next placeholders, nesting and tags in order", () => {
    const p = protect("next-i18next", "Hi {{name}}, see <b>$t(common.more)</b>");
    expect(p.masked).toBe("Hi [[0]], see [[1]][[2]][[3]]");
    expect(p.tokens).toEqual(["{{name}}", "<b>", "$t(common.more)", "</b>"]);
  });
  it("masks paraglide {name} but not i18next {{x}} rules", () => {
    expect(protect("paraglide", "Hello {name}!").masked).toBe("Hello [[0]]!");
  });
  it("keeps format modifiers inside the token", () => {
    expect(protect("next-i18next", "On {{date, datetime}}").tokens).toEqual(["{{date, datetime}}"]);
  });
  it("protects literal [[n]] already in the text", () => {
    expect(protect("next-i18next", "a [[0]] b").tokens).toEqual(["[[0]]"]);
  });
  it("does not treat a < b > c as a tag", () => {
    expect(protect("next-i18next", "a < b > c").tokens).toEqual([]);
  });
  it("splits outer whitespace", () => {
    const p = protect("next-i18next", "  {{count}} items\n");
    expect([p.lead, p.masked, p.trail]).toEqual(["  ", "[[0]] items", "\n"]);
  });
});

describe("restore", () => {
  const p = protect("next-i18next", " Hi {{name}} <b>x</b>");
  it("restores tokens even when the model moved them", () => {
    expect(restore("[[1]]x[[2]] สวัสดี [[0]]", p)).toEqual({ ok: true, text: " <b>x</b> สวัสดี {{name}}" });
  });
  it("fails on a missing token", () => expect(restore("สวัสดี [[0]] [[1]]x", p).ok).toBe(false));
  it("fails on a duplicated token", () => expect(restore("[[0]] [[0]] [[1]][[2]]", p).ok).toBe(false));
  it("fails on an invented token", () => expect(restore("[[0]][[1]][[2]][[3]]", p).ok).toBe(false));
  it("fails on empty output", () => expect(restore("   ", protect("paraglide", "Hi")).ok).toBe(false));
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm test src/mt/protect.test.ts`. Expected: FAIL, because the module isn't found.
- [ ] **Step 3: Implement `protect`, `restore` and `token`** in `src/mt/protect.ts`, following the rules above.
- [ ] **Step 4: Run them again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(mt): placeholder protection"
  ```

---

### Task 2: Model catalog and prompts

**Files:**
- Create: `src/mt/catalog.json`, `src/mt/catalog.ts`, `src/mt/prompt.ts`
- Test: `src/mt/catalog.test.ts`, `src/mt/prompt.test.ts`

**Interfaces:**
- Produces from `catalog.ts`:
  - `type PromptTemplate = "translategemma" | "qwen3"`
  - `interface CatalogModel { id: string; name: string; tier: "small" | "recommended" | "best" | "best-alt"; repo: string; file: string; url: string; sha256: string; sizeBytes: number; ramGb: string; languages: string; license: { name: string; url: string; requiresAcceptance: boolean }; template: PromptTemplate; recommended?: boolean }`
  - `CATALOG: CatalogModel[]`
  - `findModel(id: string): CatalogModel | undefined`
  - `formatBytes(n: number): string`, e.g. `"2.49 GB"`, using base 1000 with two decimals for GB and one for MB.
- Produces from `prompt.ts`:
  - `buildPrompt(t: PromptTemplate, src: string, tgt: string, masked: string): { prompt: string; addBos: boolean; stop: string[] }`
  - `languageName(locale: string): string`
  - `normalizeLocale(locale: string): string`, which replaces `_` with `-`
  - `cleanOutput(raw: string): string`

**`catalog.json`:**
- Exact values. The URL is always `https://huggingface.co/<repo>/resolve/<commit>/<file>`.
- All entries checked on 2026-10-31 via the Hugging Face API; every repo is ungated.
- **Order:** the array follows the order of these entries.

**TranslateGemma terms (entries 1 and 2):**
- License `{ name: "Gemma Terms of Use", url: "https://ai.google.dev/gemma/terms", requiresAcceptance: true }`.
- Template `translategemma`.
- Languages: `55 languages incl. Thai, English`.

**Qwen3 terms (entries 3 and 4):**
- License `{ name: "Apache 2.0", url: "https://www.apache.org/licenses/LICENSE-2.0", requiresAcceptance: false }`.
- Template `qwen3`.
- Languages: `119 languages incl. Thai, English`.

1. **`translategemma-4b`** — "TranslateGemma 4B"
   - Tier `recommended`, `recommended: true`, `ramGb: "8–16 GB"`.
   - Repo `bullerwins/translategemma-4b-it-GGUF`, commit `7c938465a870d8624bcfa98a8e4a3510053c19a8`.
   - File `translategemma-4b-it-Q4_K_M.gguf`.
   - Size `2489909312`.
   - SHA-256 `7f7357c14abd9da4eb200b38b05da502cd6e10d7e1d403fbc9f78c19f3209b72`.
2. **`translategemma-12b`** — "TranslateGemma 12B"
   - Tier `best`, `ramGb: "16–32 GB"`.
   - Repo `bullerwins/translategemma-12b-it-GGUF`, commit `d7d1d8cc4ff53d4bc883ef33eae3894f07833b63`.
   - File `translategemma-12b-it-Q4_K_M.gguf`.
   - Size `7300793664`.
   - SHA-256 `9196d728812afbf5efc10b539298585725edc3a4ecc092c22fdde5bbaf41879e`.
3. **`qwen3-1.7b`** — "Qwen3 1.7B"
   - Tier `small`, `ramGb: "8 GB"`.
   - Repo `Qwen/Qwen3-1.7B-GGUF`, commit `90862c4b9d2787eaed51d12237eafdfe7c5f6077`.
   - File `Qwen3-1.7B-Q8_0.gguf`.
   - Size `1834426016`.
   - SHA-256 `061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a`.
4. **`qwen3-8b`** — "Qwen3 8B"
   - Tier `best-alt`, `ramGb: "16 GB"`.
   - Repo `Qwen/Qwen3-8B-GGUF`, commit `7c41481f57cb95916b40956ab2f0b139b296d974`.
   - File `Qwen3-8B-Q4_K_M.gguf`.
   - Size `5027783488`.
   - SHA-256 `d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785`.

**Fallback if TranslateGemma fails the Task 11 check (spec §9.2).** Do not add this unless that check fails. Replace entry 1 with **`qwen3-4b`** — "Qwen3 4B":
- Tier `recommended`, `recommended: true`, `ramGb: "8–16 GB"`.
- Repo `Qwen/Qwen3-4B-GGUF`, commit `bc640142c66e1fdd12af0bd68f40445458f3869b`.
- File `Qwen3-4B-Q4_K_M.gguf`.
- Size `2497280256`.
- SHA-256 `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`.
- Apache 2.0, template `qwen3`.

**Prompt templates:**
- **`translategemma`** is the official TranslateGemma chat template, copied from the model file's `tokenizer.chat_template`, text type:
  - `addBos: true`, `stop: ["<end_of_turn>"]`.
  - S and T are `languageName(src)` and `languageName(tgt)`; s and t are the normalized codes.
  - The prompt is exactly:
    ```
    <start_of_turn>user\nYou are a professional S (s) to T (t) translator. Your goal is to accurately convey the meaning and nuances of the original S text while adhering to T grammar, vocabulary, and cultural sensitivities.\nProduce only the T translation, without any additional explanations or commentary. Please translate the following S text into T:\n\n\n{masked}<end_of_turn>\n<start_of_turn>model\n
    ```
- **`qwen3`** is ChatML with thinking disabled (the empty think block Qwen3 uses for `enable_thinking=false`):
  - `addBos: false`, `stop: ["<|im_end|>"]`.
  - The prompt is exactly:
    ```
    <|im_start|>system\nYou translate software user-interface text from S (s) to T (t). Output only the translation. Copy every token like [[0]] exactly as written and keep line breaks.<|im_end|>\n<|im_start|>user\n{masked}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n
    ```

**`languageName`:**
- Returns `new Intl.DisplayNames(["en"], { type: "language" }).of(normalizeLocale(l))`.
- Falls back to the raw input if that call throws or returns `undefined`.

**`cleanOutput`:**
- Cut at the first `<end_of_turn>` or `<|im_end|>`.
- Remove any `<think>…</think>` block.
- Trim.
- Strip one pair of wrapping quotes when the whole output is wrapped in `"…"`, `“…”` or `「…」`.

- [ ] **Step 1: Write the failing tests**

```ts
// catalog.test.ts
import { CATALOG, findModel, formatBytes } from "./catalog";
it("has exactly one recommended model and pinned https URLs", () => {
  expect(CATALOG.filter((m) => m.recommended).map((m) => m.id)).toEqual(["translategemma-4b"]);
  for (const m of CATALOG) {
    expect(m.url).toBe(`https://huggingface.co/${m.repo}/resolve/${m.url.split("/resolve/")[1].split("/")[0]}/${m.file}`);
    expect(m.url).not.toContain("/resolve/main/");
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.file).toMatch(/^[A-Za-z0-9._-]+\.gguf$/);
  }
});
it("formats sizes", () => {
  expect(formatBytes(2489909312)).toBe("2.49 GB");
  expect(formatBytes(512_000_000)).toBe("512.0 MB");
  expect(findModel("qwen3-8b")?.sizeBytes).toBe(5027783488);
});

// prompt.test.ts
import { buildPrompt, cleanOutput, languageName } from "./prompt";
it("builds the exact TranslateGemma prompt", () => {
  expect(buildPrompt("translategemma", "en", "th", "Hello [[0]]")).toEqual({
    prompt:
      "<start_of_turn>user\nYou are a professional English (en) to Thai (th) translator. Your goal is to accurately convey the meaning and nuances of the original English text while adhering to Thai grammar, vocabulary, and cultural sensitivities.\nProduce only the Thai translation, without any additional explanations or commentary. Please translate the following English text into Thai:\n\n\nHello [[0]]<end_of_turn>\n<start_of_turn>model\n",
    addBos: true,
    stop: ["<end_of_turn>"],
  });
});
it("builds the Qwen3 prompt with thinking disabled", () => {
  const r = buildPrompt("qwen3", "th", "en_US", "สวัสดี");
  expect(r.addBos).toBe(false);
  expect(r.stop).toEqual(["<|im_end|>"]);
  expect(r.prompt).toContain("from Thai (th) to American English (en-US)");
  expect(r.prompt.endsWith("<|im_start|>assistant\n<think>\n\n</think>\n\n")).toBe(true);
});
it("names odd locales without throwing", () => {
  expect(languageName("th")).toBe("Thai");
  expect(languageName("pt-BR")).toBe("Brazilian Portuguese");
  expect(languageName("not a locale!")).toBe("not a locale!");
});
it("cleans model output", () => {
  expect(cleanOutput("สวัสดี<end_of_turn>junk")).toBe("สวัสดี");
  expect(cleanOutput("<think>\nhmm\n</think>\n\n“Hello”<|im_end|>")).toBe("Hello");
  expect(cleanOutput('  "He said \\"hi\\""  ')).toBe('He said \\"hi\\"');
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm test src/mt/catalog.test.ts src/mt/prompt.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the three files** as specified. `catalog.ts` imports the JSON; `resolveJsonModule` is already on via Vite. If tsc complains, add `"resolveJsonModule": true` to `tsconfig.json`.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(mt): model catalog and prompt templates"
  ```

---

### Task 3: Translating one text

**Files:**
- Create: `src/mt/translate.ts`, `src/mt/source.ts`
- Test: `src/mt/translate.test.ts`, `src/mt/source.test.ts`

**Interfaces:**
- Consumes:
  - `protect`/`restore` (Task 1)
  - `buildPrompt`/`cleanOutput`/`PromptTemplate` (Task 2)
  - `ProjectSession.value`
  - `splitPlural`, `parseKeyId`, `keyId`
- Produces:
  - `interface GenerateRequest { reqId: number; modelPath: string; prompt: string; addBos: boolean; maxTokens: number; stop: string[] }`
  - `interface MtEngine { generate(r: GenerateRequest): Promise<string>; cancel(reqId: number): Promise<void> }`
  - `interface ActiveModel { path: string; template: PromptTemplate }`
  - `type TranslateResult = { ok: true; text: string } | { ok: false; reason: "unsafe" } | { ok: false; reason: "cancelled" } | { ok: false; reason: "error"; message: string }`
  - `nextReqId(): number` (a module counter starting at 1)
  - `translateText(engine: MtEngine, model: ActiveModel, format: Format, src: string, tgt: string, text: string, reqId?: number): Promise<TranslateResult>`
  - `sourceText(session: ProjectSession, id: KeyId): string | null`

**`translateText` rules:**
- `maxTokens = Math.min(1024, 64 + masked.length * 4)`.
- **Engine rejections:**
  - Message `"cancelled"` → `{ok:false, reason:"cancelled"}`.
  - Any other message → `{ok:false, reason:"error", message}`. The Rust side's own messages, such as `Text is too long to translate`, pass through unchanged.
- **Otherwise:** run `cleanOutput`, then `restore`. A failed restore gives `{ok:false, reason:"unsafe"}`.

**`sourceText` rules:**
- Returns the base locale's text value.
- If the key is a plural variant with no base value, it uses the base `<base>_other` text.
- Returns `null` when the source is complex, missing, or only whitespace.

- [ ] **Step 1: Write the failing tests**

```ts
// translate.test.ts
const model = { path: "/m/x.gguf", template: "translategemma" as const };
const fake = (out: string | Error) => {
  const calls: GenerateRequest[] = [];
  const engine: MtEngine = {
    generate: async (r) => { calls.push(r); if (out instanceof Error) throw out; return out; },
    cancel: async () => {},
  };
  return { engine, calls };
};
it("masks, prompts, cleans and restores", async () => {
  const { engine, calls } = fake("สวัสดี [[0]]<end_of_turn>");
  const r = await translateText(engine, model, "next-i18next", "en", "th", " Hello {{name}}", 7);
  expect(r).toEqual({ ok: true, text: " สวัสดี {{name}}" });
  expect(calls[0]).toMatchObject({ reqId: 7, modelPath: "/m/x.gguf", addBos: true, stop: ["<end_of_turn>"] });
  expect(calls[0].prompt).toContain("Hello [[0]]<end_of_turn>");
  expect(calls[0].maxTokens).toBe(64 + "Hello [[0]]".length * 4);
});
it("reports a lost placeholder as unsafe", async () => {
  expect(await translateText(fake("สวัสดี").engine, model, "next-i18next", "en", "th", "Hi {{name}}")).toEqual({ ok: false, reason: "unsafe" });
});
it("maps engine errors", async () => {
  expect(await translateText(fake(new Error("cancelled")).engine, model, "paraglide", "en", "th", "Hi")).toEqual({ ok: false, reason: "cancelled" });
  expect(await translateText(fake(new Error("Text is too long to translate")).engine, model, "paraglide", "en", "th", "Hi"))
    .toEqual({ ok: false, reason: "error", message: "Text is too long to translate" });
});

// source.test.ts: build sessions with MemoryFs fixtures, the same way src/core/session.test.ts does
it("uses the base text", ...);                                  // expect "Welcome"
it("falls back to the base _other for a target-only plural variant", ...); // key "items_few", base has items_one/items_other → base items_other text
it("returns null for complex, missing and whitespace-only base values", ...);
```

The `source.test.ts` bodies follow the fixture helpers already in `src/core/session.test.ts`: a next-i18next MemoryFs project where `en` has `items_one`/`items_other` and `ru` has `items_few`, plus a Paraglide project with one complex message.

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement both modules.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(mt): translateText and source text selection"
  ```

---

### Task 4: Translate all missing (logic)

**Files:**
- Create: `src/mt/batch.ts`
- Test: `src/mt/batch.test.ts`

**Interfaces:**
- Consumes:
  - `buildRows` (`src/core/rows.ts`)
  - `sourceText`, `TranslateResult` (Task 3)
  - `isTranslated`
  - `session.setText`
- Produces:
  - `interface BatchItem { id: KeyId; source: string }`
  - `missingItems(session: ProjectSession, locale: string, ns: string | "all"): BatchItem[]`
  - `interface BatchResult { translated: number; unsafe: KeyId[]; failed: Array<{ id: KeyId; message: string }>; skipped: number; cancelled: boolean }`
  - `translateMissing(session: ProjectSession, items: BatchItem[], locale: string, translate: (source: string) => Promise<TranslateResult>, onProgress: (p: { done: number; total: number; current: KeyId | null }) => void, signal: AbortSignal): Promise<BatchResult>`

**`missingItems`:**
- Use `buildRows(session, { search: "", ns, locales: [locale], missing: true, needsReview: false, machine: false, status: "all" })`. This matches the Missing count exactly.
- Keep rows where the cell is missing for `locale` and `sourceText` isn't null.

**`translateMissing`:**
- Items run one at a time, in order.
- **Before each write,** re-check `!isTranslated(session.value(id, locale))`. If the cell got filled, or `value`/`setText` throws because the key was deleted, `skipped++`.
- **Writes** go through `session.setText(id, locale, text, { machine: true })`.
- **When `signal` aborts,** stop before the next item and set `cancelled: true`. Results already written stay.
- **Results:** `unsafe` gets an id appended; `error` adds to `failed`; `cancelled` ends the loop with `cancelled: true`.
- **Progress:** `onProgress` fires with `done: 0` first, then after every item.

- [ ] **Step 1: Write the failing tests** (MemoryFs project with `en` as base and `th` as target):

```ts
it("translates only missing cells and marks them machine", async () => {
  // en: {a:"A", b:"B", c:"C"}, th: {b:"บี"}
  const items = missingItems(session, "th", "all");
  expect(items.map((i) => i.source)).toEqual(["A", "C"]);
  const r = await translateMissing(session, items, "th", async (s) => ({ ok: true, text: `th:${s}` }), () => {}, new AbortController().signal);
  expect(r).toEqual({ translated: 2, unsafe: [], failed: [], skipped: 0, cancelled: false });
  expect(session.value(keyId("common", "a"), "th")).toEqual({ kind: "text", text: "th:A" });
  expect(session.meta(keyId("common", "a"), "th")).toMatchObject({ status: "translated", machine: true });
});
it("skips a cell filled while the batch was running", async () => {
  const items = missingItems(session, "th", "all");
  const r = await translateMissing(session, items, "th", async (s) => {
    if (s === "A") session.setText(keyId("common", "c"), "th", "typed by hand");
    return { ok: true, text: `th:${s}` };
  }, () => {}, new AbortController().signal);
  expect(r.skipped).toBe(1);
  expect(session.value(keyId("common", "c"), "th")).toEqual({ kind: "text", text: "typed by hand" });
  expect(session.meta(keyId("common", "c"), "th").machine).toBe(false);
});
it("skips a key deleted while the batch was running", async () => { /* deleteKey(c) inside translate for "A" → skipped 1, no throw */ });
it("collects unsafe and failed results and stops on abort", async () => {
  const ac = new AbortController();
  const r = await translateMissing(session, missingItems(session, "th", "all"), "th", async (s) => {
    ac.abort();
    return { ok: false, reason: "unsafe" };
  }, () => {}, ac.signal);
  expect(r).toMatchObject({ translated: 0, unsafe: [keyId("common", "a")], cancelled: true });
});
it("filters by namespace and skips complex Paraglide messages", ...);
it("reports progress", ...); // calls: [{done:0,total:2,current:null}, {done:1,...}, {done:2,...,current:null}]
```

- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement `src/mt/batch.ts`.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(mt): translate-all-missing logic"
  ```

---

### Task 5: Model downloads (Rust)

**Files:**
- Create: `src-tauri/src/mt/mod.rs`, `src-tauri/src/mt/download.rs`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`

**Interfaces:**
- Produces Tauri commands; their JS argument names are camelCase:
  - `mt_models_dir() -> String`
  - `mt_models_status() -> Vec<ModelFile>`, where `ModelFile { file: String, size: u64, complete: bool }`. It lists `*.gguf` files (complete) and `*.gguf.part` files (`complete: false`, with `file` set to the name without `.part`).
  - `mt_download_start(id, url, file, sha256, size) -> Result<(), String>`. It returns at once and runs in a background task.
  - `mt_download_pause(id)`
  - `mt_download_cancel(id, file)`. It stops the download and deletes the `.part`, even when nothing is running.
  - `mt_model_delete(file)`. It unloads the engine first if the engine holds that file; Task 6 adds that hook.
- Event `mt-download`, with payload `{ id, state: "progress"|"done"|"paused"|"cancelled"|"error", received: u64, total: u64, message?: String }`. Progress events are throttled to at most one per 250 ms.
- Core function, testable without Tauri:
  ```rust
  pub enum Outcome { Done, Paused, Cancelled }
  pub const RUN: u8 = 0; pub const PAUSE: u8 = 1; pub const CANCEL: u8 = 2;
  pub async fn download_file(client: &reqwest::Client, url: &str, dir: &Path, file: &str, sha256: &str, size: u64,
      control: &AtomicU8, on_progress: impl FnMut(u64, u64)) -> Result<Outcome, String>
  ```

**Cargo:**

```toml
reqwest = { version = "0.13", default-features = false, features = ["native-tls", "stream", "http2"] }
sha2 = "0.11"
futures-util = "0.3"
tokio = { version = "1", features = ["fs", "io-util", "rt", "time", "sync", "macros"] }
[dev-dependencies]
tempfile = "3"
```

**`download_file` rules:**
- **Resuming:** writes to `dir/file.part`. If the `.part` exists, hash its bytes first, then request `Range: bytes=<len>-`.
- **Server responses:**
  - 206: append.
  - 200 while resuming: truncate and start from 0.
  - 416: treat the part as complete and go straight to verification.
  - Any other status: `Err("Download failed: HTTP <code>")`.
- **Verification:**
  - Received bytes beyond `size` → delete the part and return `Err("Download corrupted. Try again.")`.
  - On completion, the length must equal `size` and the hex SHA-256 must equal `sha256`. Otherwise delete the part with the same error.
  - On success, rename `.part` to `file`.
- **Control:** checked between chunks. Pause → keep the part and return `Paused`. Cancel → delete the part and return `Cancelled`.

**Command-layer checks:**
- `file` must match `^[A-Za-z0-9._-]+\.gguf$`.
- `url` must start with `https://huggingface.co/`.
- Only one download per `id`; a second start returns `Err("Already downloading")`.
- Models dir: `app.path().app_data_dir()?.join("models")`, created on demand.

- [ ] **Step 1: Write the failing tests.** Inline `#[cfg(test)] mod tests` in `download.rs`. A helper starts a `std::net::TcpListener` on `127.0.0.1:0` in a thread, serving a fixed body. It has a flag for honouring `Range` (206 with `Content-Range`) or ignoring it (200 full body), and can serve 416. Tests use `#[tokio::test]` and `tempfile::tempdir()`.
  - `downloads_and_verifies`: 300 KB body with the correct SHA → `Done`; the final file exists and no `.part` remains.
  - `resumes_from_part`: pre-write the first 100 KB as `x.gguf.part`; the server honours Range; assert the server saw `Range: bytes=102400-`, the result is `Done`, and the bytes are identical.
  - `restarts_when_range_ignored`: pre-write 100 KB of *wrong* bytes; the server returns 200 → `Done` with the correct content.
  - `checksum_mismatch_deletes_part`: wrong `sha256` → `Err("Download corrupted. Try again.")`; neither file exists.
  - `pause_keeps_part_and_cancel_deletes_it`: set `control` to PAUSE in `on_progress` after the first chunk → `Paused` and the `.part` exists. Rerun with CANCEL → `Cancelled` and no `.part`.
  - `complete_part_with_416_is_verified`: full correct bytes in `.part`; the server answers 416 → `Done`.
  - `rejects_bad_names_and_hosts`: a pure fn `validate_request(url, file) -> Result<(), String>` rejects `../x.gguf`, `x.bin` and `http://evil.example/x.gguf`, and accepts `https://huggingface.co/a/b/resolve/c/x.gguf`.
- [ ] **Step 2: Run them and confirm they fail.** Run `cd src-tauri && cargo test mt::download`. Expected: compile failure or FAIL.
- [ ] **Step 3: Implement `download.rs` and the commands, and register them** in `lib.rs` with `.manage(mt::download::Downloads::default())`.
- [ ] **Step 4: Run the tests again.** Run `cargo test`. Expected: all pass, including the existing 4.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(mt): resumable, checksummed model downloads"
  ```

---

### Task 6: Inference engine (Rust, llama.cpp)

**Files:**
- Create: `src-tauri/src/mt/engine.rs`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/src/mt/download.rs` (unload hook in `mt_model_delete`)

**Interfaces:**
- Commands:
  - `mt_generate(reqId: u64, modelPath: String, prompt: String, addBos: bool, maxTokens: u32, stop: Vec<String>) -> Result<String, String>`
  - `mt_cancel(reqId: u64)`
  - `mt_unload()`
- Pure helpers, unit-tested:
  - `truncate_at_stop(text: &str, stop: &[String]) -> Option<String>`. Returns the text before the first stop string, or `None` if there isn't one.
  - `token_budget(prompt_tokens: usize, n_ctx: u32, max_tokens: u32) -> Result<u32, String>`. Returns `Err("Text is too long to translate")` when `prompt_tokens + 16 > n_ctx`, otherwise `min(max_tokens, n_ctx - prompt_tokens)`.
- Produces `Engine::unload_if(path: &Path)`, used by `mt_model_delete`. This matters because Windows can't delete a file that is memory-mapped.

**Cargo:**

```toml
[target.'cfg(target_os = "macos")'.dependencies]
llama-cpp-2 = { version = "0.1.160", default-features = false, features = ["metal"] }
[target.'cfg(not(target_os = "macos"))'.dependencies]
llama-cpp-2 = { version = "0.1.160", default-features = false }
```

- Default features are off to drop OpenMP, which would add a runtime DLL on Windows.
- Add the `sampler` feature only if `LlamaSampler` fails to compile without it.

**Engine rules:**
- **Backend:** `LlamaBackend::init()` runs once, in a `OnceLock`. llama.cpp logging is silenced via `llama_cpp_2::send_logs_to_tracing(LogOptions::default().with_logs_enabled(false))`.
- **Model loading:** the model loads on first `mt_generate`, and reloads when `modelPath` differs.
  - Params: `n_gpu_layers = 999` on macOS and `0` elsewhere.
  - Context: `n_ctx = 4096`.
  - A load failure returns `Err("Couldn't load the model file. Is it a llama.cpp GGUF model?")`.
- **Generation:**
  - Runs inside `tauri::async_runtime::spawn_blocking`, behind a `Mutex` so only one request runs at a time.
  - Tokenize with `AddBos::Always` / `AddBos::Never` according to `addBos`. Special tokens in the prompt (`<start_of_turn>`, `<|im_start|>`) must tokenize as single special tokens.
  - Greedy sampling. Stop on an end-of-generation token, on `truncate_at_stop`, or on budget exhaustion.
  - Decode pieces as UTF-8 incrementally. Thai is multi-byte, so buffer partial bytes.
- **Cancel:** `mt_cancel(id)` stores `id` in an `AtomicU64`. The generation loop checks it every token and returns `Err("cancelled")` when it matches its own `reqId`.
- **Idle unload:** a background thread started in `setup` checks every 30 s and drops the model when it has been idle for more than `IDLE_UNLOAD_SECS = 300`.

- [ ] **Step 0: Check build prerequisites.** Run `cmake --version`.
  - **If it's missing,** stop and ask the user to run `brew install cmake`, because `llama-cpp-sys-2` builds llama.cpp with CMake. Do not install it yourself: the user prefers to install toolchains themselves.
- [ ] **Step 1: Write the failing tests** (inline in `engine.rs`):

```rust
#[test] fn stops_at_first_stop_string() {
    assert_eq!(truncate_at_stop("สวัสดี<end_of_turn>x", &["<end_of_turn>".into()]), Some("สวัสดี".into()));
    assert_eq!(truncate_at_stop("hello", &["<|im_end|>".into()]), None);
}
#[test] fn budget_limits() {
    assert_eq!(token_budget(100, 4096, 1024), Ok(1024));
    assert_eq!(token_budget(4000, 4096, 1024), Ok(96));
    assert_eq!(token_budget(4085, 4096, 1024), Err("Text is too long to translate".into()));
}
/// Needs a real model: PARATRANS_TEST_MODEL=/path/translategemma-4b-it-Q4_K_M.gguf cargo test -- --ignored
#[test] #[ignore] fn translates_english_to_thai_with_real_model() {
    // Build the TranslateGemma prompt for "Welcome back" en→th (same text as the TS test in Task 2),
    // generate with addBos=true and stop ["<end_of_turn>"], then assert the output is non-empty and
    // contains a Thai character (U+0E00..=U+0E7F). Also assert "<start_of_turn>" tokenizes to exactly 1 token.
}
```

- [ ] **Step 2: Run them and confirm they fail.** Run `cargo test mt::engine`.
- [ ] **Step 3: Implement `engine.rs` and register everything:** the commands, `.manage(Arc<Engine>)`, the idle thread in `.setup`, and the unload hook in `mt_model_delete`.
- [ ] **Step 4: Run the tests and check the bundle size.**
  - Run `cargo test`. Expected: all pass, with 1 ignored.
  - Run `pnpm tauri build --bundles app` from the repo root, then `du -sh src-tauri/target/release/bundle/macos/Paratrans.app`. Expected: under 40 MB; write the number into the task report.
  - If the build passes but the `.app` is over 40 MB, report the number and continue. This is a ruling, not a stop.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(mt): embedded llama.cpp engine with cancel and idle unload"
  ```

---

### Task 7: Front-end bridge, settings and MT store

**Files:**
- Create: `src/platform/mt.ts`, `src/ui/mt-store.ts`
- Modify: `src/platform/prefs.ts`, `src/App.tsx`
- Test: `src/ui/mt-store.test.ts`

**Interfaces:**
- **`src/platform/mt.ts`** follows the `invoke`/`listen` style of `src/platform/watch.ts`:
  - `tauriEngine: MtEngine`, calling `mt_generate` and `mt_cancel`. A string rejection becomes an `Error` with that message.
  - `mtNative.modelsDir(): Promise<string>`
  - `mtNative.status(): Promise<ModelFile[]>`
  - `mtNative.startDownload(m: CatalogModel): Promise<void>`
  - `mtNative.pause(id: string)`
  - `mtNative.cancel(id: string, file: string)`
  - `mtNative.deleteModel(file: string)`
  - `mtNative.unload()`
  - `mtNative.onDownload(cb: (e: DownloadEvent) => void): Promise<() => void>`
  - `pickGgufFile(): Promise<string | null>`, using `@tauri-apps/plugin-dialog` `open({ filters: [{ name: "GGUF model", extensions: ["gguf"] }] })`.
- **`src/platform/prefs.ts`** adds:
  - `interface MtSettings { enabled: boolean; modelId: string | null; custom: { path: string; template: PromptTemplate } | null; accepted: string[] }`
  - `getMtSettings(): Promise<MtSettings>`. Missing or invalid prefs give `{ enabled: false, modelId: null, custom: null, accepted: [] }`.
  - `setMtSettings(s: MtSettings): Promise<void>`
- **`src/ui/mt-store.ts`**, `useMt` (zustand):
  - **State:**
    - `settings: MtSettings`
    - `files: Record<string, { size: number; complete: boolean }>`
    - `downloads: Record<string, { received: number; total: number; state: DownloadEvent["state"]; message?: string }>`
    - `customMissing: boolean`
    - `engine: MtEngine` (defaults to `tauriEngine`; tests replace it)
  - **Actions:**
    - `init()`: idempotent. Loads settings and status, subscribes to download events, and checks that the custom file exists via `tauriFs.exists`.
    - `setEnabled(on)`: turning it off also calls `mtNative.unload()`.
    - `selectModel(id)`: `"custom"` selects the custom file. Unloads the engine.
    - `acceptLicense(id)`
    - `download(id)`: refuses with `error` state message `Accept the license first.` when `license.requiresAcceptance` and the license isn't accepted.
    - `pause(id)`, `cancel(id)`
    - `deleteModel(id)`: refreshes status afterwards.
    - `setCustom(path, template)`
    - `refresh()`
  - **Selectors:**
    - `activeModel(s): ActiveModel | null`. Non-null only when enabled and the selected model's file is complete, or when the custom path is set and exists. Catalog paths are `<modelsDir>/<file>`.
    - `spaceUsed(s): number`, the sum of `files[*].size`.
- **`App.tsx`:** call `void useMt.getState().init()` once in an effect at app start.

- [ ] **Step 1: Write the failing tests.** Mock `../platform/mt` and `@tauri-apps/plugin-store` the same way `store.test.ts` mocks the store.
  - `"is off by default and has no active model"`: `activeModel` is null and `settings.enabled` is false.
  - `"active model needs enabled + selected + complete file"`: status `[{file:"translategemma-4b-it-Q4_K_M.gguf", size:2489909312, complete:true}]` with modelsDir `/data/models`, then `setEnabled(true)`, then `selectModel("translategemma-4b")` → `{ path: "/data/models/translategemma-4b-it-Q4_K_M.gguf", template: "translategemma" }`. A `.part`-only file (`complete:false`) gives null.
  - `"Gemma download requires accepting the license"`: `download("translategemma-4b")` without accepting → `startDownload` not called and the state message is `Accept the license first.` After `acceptLicense`, it is called with the catalog entry.
  - `"download events update progress and refresh files when done"`.
  - `"missing custom file is not active"`.
  - `"deleting the selected model refreshes status and clears activeModel"`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement the bridge, prefs, store and the `App.tsx` init.**
- [ ] **Step 4: Run them again.** Run `pnpm test` and `pnpm exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(mt): front-end bridge, settings and store"
  ```

---

### Task 8: Settings → Machine Translation

**Files:**
- Create: `src/ui/MtSettings.tsx`
- Modify: `src/ui/SettingsPage.tsx` (render `<MtSettings session={session} />` below the existing settings, under an `<h2>Machine translation</h2>`)
- Test: `src/ui/MtSettings.test.tsx`

**Interfaces:**
- Consumes: `useMt` (Task 7), `CATALOG`/`formatBytes` (Task 2), `translateText`/`nextReqId` (Task 3), `ProjectSession`.

**Behaviour and copy:**
- **Enable toggle:** a checkbox labelled `Enable machine translation`. While it's off, show only that and the note `Runs on your computer. Nothing is downloaded until you turn this on and pick a model.`
- **Model list** (shown when enabled): one card per catalog model, then a "Use my own GGUF file" card. Each card shows:
  - the name (with a `Recommended` badge where set);
  - `Download: <formatBytes(size)>`, `RAM: <ramGb>`, `Languages: <languages>`;
  - `License: <license.name>` as a link opened with `@tauri-apps/plugin-opener` `openUrl`.
  - All of this shows before any download.
- **Card states and actions:**
  - not downloaded: `Download`
  - part present and not running: `Resume` + `Cancel`
  - downloading: a progress bar (`role="progressbar"`, `aria-valuenow` = percent) + `Pause` + `Cancel`
  - complete: `Use this model` (radio, checked when selected) + `Delete model`
  - error: the message + `Retry`
- **License dialog:** for `requiresAcceptance` models, `Download` opens a dialog. It shows a short summary ("TranslateGemma is made by Google and released under the Gemma Terms of Use. Commercial use is allowed, subject to the Terms and the Prohibited Use Policy."), links to `https://ai.google.dev/gemma/terms` and `https://ai.google.dev/gemma/prohibited_use_policy`, and two buttons, `Accept & download` and `Cancel`.
- **Custom GGUF card:**
  - `Choose file…` calls `pickGgufFile`.
  - A select labelled `Prompt style` offers `Qwen / ChatML` (`qwen3`) and `TranslateGemma` (`translategemma`).
  - Shows the chosen path, or `File not found` when `customMissing` is set.
- **Footer:** `Space used: <formatBytes(spaceUsed)>`.
- **"Test this model" panel** (shown when `activeModel` is non-null):
  - A textarea, prefilled with `Welcome back, {{name}}! You have new messages.` for next-i18next or `Welcome back, {name}! You have new messages.` for Paraglide.
  - A target select of the project's non-base locales, defaulting to `th` if present.
  - A `Translate` button calling `translateText` with the base locale as source.
  - Output shown in a `role="status"` region. Unsafe results show `Couldn't translate safely`; errors show their message.

- [ ] **Step 1: Write the failing tests.** Render with `useMt.setState` seeded and `mtNative` mocked.
  - `"shows only the toggle while disabled"`.
  - `"shows size, RAM, languages and license before download"`: expect text `Download: 2.49 GB`, `RAM: 8–16 GB`, and a `Gemma Terms of Use` link.
  - `"Gemma download goes through Accept & download"`: click `Download` on TranslateGemma 4B → dialog → `Accept & download` → `startDownload` called once.
  - `"Qwen downloads without a license dialog"`.
  - `"shows progress with pause and cancel"`: downloads state `{received: 50, total: 100, state: "progress"}` → progressbar `aria-valuenow="50"`; `Pause` calls `mtNative.pause`.
  - `"complete model can be selected and deleted"`.
  - `"test panel shows the translation or the unsafe message"`: the fake engine returns `สวัสดี [[0]]! คุณมีข้อความใหม่` → status shows `สวัสดี {{name}}! คุณมีข้อความใหม่`. Then the fake returns text without the token → `Couldn't translate safely`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement `MtSettings.tsx`** using the existing `Dialog`, `btnPrimary`, `btnGhost` and `inputCls` from `./Dialog`.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(mt): machine translation settings, downloads and test panel"
  ```

---

### Task 9: Suggestions in the cell editor

**Files:**
- Create: `src/ui/Suggestion.tsx`
- Modify: `src/ui/CellEditor.tsx`, `src/ui/Cell.tsx`, `src/ui/AppShell.tsx`
- Test: `src/ui/Suggestion.test.tsx`

**Interfaces:**
- **`Suggestion.tsx`:**
  - `type SuggestionState = { status: "loading" } | { status: "ready"; text: string } | { status: "unsafe" } | { status: "error"; message: string }`
  - `useSuggestion(session: ProjectSession, id: KeyId, locale: string, active: boolean): SuggestionState | null`
  - `SuggestionBox(p: { state: SuggestionState; onAccept: () => void })`
- **`CellEditor` new props:** `suggestion?: SuggestionState | null; onAcceptSuggestion?: (text: string) => void`.
- **`EditActions` new member:** `commitMachine: (id: KeyId, locale: string, text: string) => void`. AppShell implements it as `s.setText(id, locale, text, { machine: true })` and then closes the editor, the same way `commit` does.

**`useSuggestion` rules:**
- **Returns null unless all of these hold:**
  - `active`;
  - the cell is a target locale and currently untranslated;
  - `useMt` `activeModel` is non-null;
  - `sourceText` is non-null.
- **Caching:** results are cached in a module `Map`, keyed by `${modelPath}|${locale}|${id}|${source}` and capped at 500 entries (drop the oldest).
- **On unmount, or when the inputs change while loading:** call `engine.cancel(reqId)`, and never apply the late result. A `"cancelled"` result is never cached or shown.

**UI:**
- `SuggestionBox` renders below the textarea, with `data-testid="suggestion"`:
  - loading: `Translating…`
  - ready: `Suggestion: <text>`, an `Accept` button and the hint `⌘/Ctrl+Enter`
  - unsafe: `Couldn't translate safely`
  - error: the message
- **In `CellEditor`:**
  - Cmd/Ctrl+Enter while `suggestion.status === "ready"` calls `onAcceptSuggestion(text)`, marks the editor done (no blur or unmount flush afterwards), and calls `onRefocus`.
  - Clicking `Accept` does the same. Use `onMouseDown` + `preventDefault` so the textarea's blur doesn't commit first.
  - The IME guard applies to the shortcut too.

- [ ] **Step 1: Write the failing tests.** Use the existing views/CellEditor test setup and seed `useMt` with an active model and a fake engine.
  - `"shows a suggestion for a missing cell and accepts it with Ctrl+Enter"`: the fake returns `สวัสดี`. Open the missing `th` cell → `Suggestion: สวัสดี`. Press Ctrl+Enter → value `สวัสดี`, `meta.machine === true`, `meta.status === "translated"`, editor closed.
  - `"Accept button commits as machine without a blur commit of the draft"`: type `abc`, then click Accept → value is the suggestion, and `setText` was called once.
  - `"no suggestion for translated cells, the base locale, complex values, or when MT is off"`.
  - `"unsafe output shows the message and Ctrl+Enter does nothing"`.
  - `"leaving the cell cancels the request and the late result never appears"`: the fake engine returns a promise you resolve manually. Open cell A, then Escape → `cancel` called with that reqId. Resolve the promise and open cell B (a different key) → B shows `Translating…` for its own request, not A's text.
  - `"cached suggestion shows instantly on reopen"`: generate is called once across two opens.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement the hook, the box, and the editor and cell wiring.** In `Cell.tsx`, call `useSuggestion(session, id, locale, editing && !isBase)` and pass the result plus `onAcceptSuggestion={(t) => actions.commitMachine(id, locale, t)}` to `CellEditor`.
- [ ] **Step 4: Run them again.** Run `pnpm test`. Expected: PASS, and the existing CellEditor and views tests stay green.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(mt): inline suggestions with one-key accept"
  ```

---

### Task 10: Translate all missing (UI)

**Files:**
- Create: `src/ui/TranslateMissingDialog.tsx`
- Modify: `src/ui/Toolbar.tsx` (optional `onTranslateMissing?: () => void` → button `Translate missing…`, rendered only when set), `src/ui/AppShell.tsx`
- Test: `src/ui/TranslateMissingDialog.test.tsx`

**Interfaces:**
- Consumes: `missingItems`, `translateMissing` (Task 4), `translateText`, `nextReqId` (Task 3), `useMt` (Task 7).
- Produces: `TranslateMissingDialog(p: { session: ProjectSession; onClose: () => void; defaultLocale?: string })`.
- AppShell passes `onTranslateMissing` only when `activeModel` is non-null. `defaultLocale` is the first visible target locale.

**Dialog** (uses the shared `Dialog`, which means Cmd+S is blocked while it's open, as with the other dialogs):
- **Setup:**
  - `Language` select of target locales.
  - `Namespace` select (next-i18next only; `All namespaces` + each namespace).
  - Text `<n> missing`, recomputed from `missingItems`.
  - `Start` (disabled when n = 0) and `Close`.
- **Running:**
  - `role="progressbar"` with `aria-valuenow` = percent of `done/total`.
  - Text `<done> of <total>`.
  - The current key path.
  - `Cancel` aborts the AbortController and calls `engine.cancel(currentReqId)`.
  - The dialog can't be closed any other way while running.
- **Done:**
  - Summary `Translated <translated>.`
  - Plus, when non-zero: `<unsafe.length> couldn't be translated safely.`, `<failed.length> failed.`, `<skipped> skipped (changed while running).`
  - If cancelled: `Stopped.`
  - Lists up to 20 unsafe/failed key paths.
  - Footer note: `Machine translations are marked for review.`
  - A `Close` button.

- [ ] **Step 1: Write the failing tests:**
  - `"counts missing per language and namespace"`.
  - `"runs, shows progress, writes machine translations, and summarises"`: the fake engine echoes `th:<masked>`; after it finishes, the summary is `Translated 2.` and the cells have `machine: true`.
  - `"cancel stops the batch and keeps finished items"`: the fake resolves the first item and holds the second; click Cancel → `engine.cancel` called, summary contains `Stopped.` and `Translated 1.`
  - `"unsafe results are listed"`.
  - `"toolbar shows the button only when a model is active"`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement the dialog and the toolbar/AppShell wiring.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "feat(mt): translate all missing dialog"
  ```

---

### Task 11: End-to-end test, README, model check

**Files:**
- Create: `src/test/e2e-mt.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the end-to-end test.** Use the fixture `src/test/fixtures/next-nested`, copied into MemoryFs, and a fake `MtEngine` that maps the masked English text to a fixed Thai string keeping all tokens. Then:
  1. Open the session.
  2. Run `missingItems` and `translateMissing` for `th`.
  3. Save.
  4. Assert:
     - every originally missing `th` cell with a text base now has a value;
     - `.paratrans/state.json` marks those cells `"m": true` and status `translated`, never `reviewed`;
     - placeholders in the saved `th` JSON equal the base's (`comparePlaceholders` gives no missing or extra);
     - untouched files are byte-identical to the fixture.
- [ ] **Step 2: Run it.** Run `pnpm test src/test/e2e-mt.test.ts`. Expected: PASS. Fix any bugs it finds in earlier tasks' code.
- [ ] **Step 3: Update the README:**
  - **Prerequisites:** `cmake` (`brew install cmake`); on Windows, CMake and the MSVC build tools.
  - **Machine translation:** how to enable it; model sizes; models stored in the app data folder; nothing leaves the computer except the model download from huggingface.co.
  - **Manual checklist, new items:**
    - Enable MT, then accept the Gemma terms and download TranslateGemma 4B. Pause, quit the app, reopen, then resume.
    - "Test this model": en→th with `{{name}}` keeps the placeholder.
    - Open a missing `th` cell → suggestion appears → ⌘+Enter accepts it → the yellow dot shows the machine marker.
    - "Translate missing…" for `th` → cancel midway → finished items stay.
    - Delete the model → space used drops.
    - **Fallback check:** if TranslateGemma 4B fails to load or gives poor Thai↔English output, swap catalog entry 1 for the Qwen3 4B fallback given in this plan's Task 2.
  - **Running the real-model Rust test:** `PARATRANS_TEST_MODEL=<path> cargo test -- --ignored`.
- [ ] **Step 4: Run full verification.**
  - Run `pnpm test`, `pnpm exec tsc --noEmit` and `cd src-tauri && cargo test`. Expected: all pass.
  - Run `pnpm tauri build --bundles app`. Expected: success, and the `.app` stays under 40 MB.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -m "test(mt): end-to-end batch translation; docs for machine translation"
  ```

---

## Rulings in this plan (cost if wrong)

**Models and downloads:**
- **Small tier is Qwen3 1.7B Q8_0 (1.83 GB), not Q4 (~1.1 GB).** The official Qwen repo only ships Q8_0, and that beats an unknown community quantization. *Cost: a 0.7 GB larger download for the small tier.*
- **TranslateGemma comes from `bullerwins`, the original community quantizer.** 42ailab's 4B mirror has the same SHA-256, and bullerwins also has 12B. *Cost: none; the bytes are identical.*
- **Gemma terms are shown as a summary plus links, not the full text.** *Cost: embed the full text later if needed.*
- **A custom GGUF stays where it is** instead of being copied into the app data folder. *Cost: if the user moves the file, it shows "File not found".*

**Engine:**
- **The engine is embedded with `llama-cpp-2`, not a sidecar binary.** That means one binary, Metal on macOS, and nothing extra to ship per platform. *Cost: needs CMake to build; Windows needs MSVC + CMake in CI (Plan 3).*
- **Windows is CPU-only for now.** Vulkan needs the Vulkan SDK at build time and would bloat the installer. *Cost: slower translation on Windows until Plan 3 evaluates Vulkan.*
- **OpenMP is off.** It avoids a runtime DLL on Windows. *Cost: somewhat slower CPU inference.*
- **Greedy decoding, `n_ctx` 4096, a cap of 1024 new tokens.** Translation wants repeatable output, and UI strings are short. *Cost: very long texts give `Text is too long to translate`.*

**Translation:**
- **Placeholder tokens are `[[n]]`, and TranslateGemma gets its official prompt unchanged** (the spec asks for each model's own template). The safety check catches any token the model mangles. *Cost: more `Couldn't translate safely` results if a model rewrites brackets; change `token()` in one place.*
- **Suggestions appear only for untranslated cells,** as the spec says. *Cost: no suggestions for "needs review" cells.*
- **The "Translate missing" dialog is modal,** so the user can't type while it runs. Reload races are still handled. *Cost: the user waits or cancels.*
