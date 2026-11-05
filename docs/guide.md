# Retrans guide

How to use Retrans beyond opening a project. For download and install, see the [README](../README.md).

- [AI translation](#ai-translation)
- [Working with a translator](#working-with-a-translator)
- [TypeScript translations and workspaces](#typescript-translations-and-workspaces)
- [Figma Variables](#figma-variables)
- [Keyboard shortcuts](#keyboard-shortcuts)

## AI translation

Retrans can suggest a translation while you edit a cell, or fill every missing cell with **Translate missing**. It is off until you enable it.

### Providers

- **Built-in model.** Runs entirely on your computer. Pick a model in Settings; sizes start at about 1.8 GB, and the settings list the exact download size of each. Models live in the app data folder; a custom GGUF file you add stays where it is.
  - TranslateGemma is under the Gemma terms of use. The app shows a summary and links, and asks you to accept before downloading.
  - The Qwen models follow your custom instructions. TranslateGemma uses a fixed prompt, and Settings says so.
- **Cloud APIs.** OpenAI (ChatGPT), Claude (Anthropic), or any OpenAI-compatible API such as OpenRouter, Groq, DeepSeek, Ollama or LM Studio. API keys are stored in the macOS Keychain or Windows Credential Manager, never in files.
- **AI agents (ACP).** Use an agent you already have, such as Claude Code, Codex or Gemini CLI, with your existing subscription.

The first time you choose a provider that sends text off your computer, Retrans asks before sending anything and names where it goes. **Test this model** shows exactly what is sent. Each project can use its own provider, and replies stream in as they arrive.

> **About agents:** Retrans gives an agent no file or terminal access of its own and refuses every permission it asks for. An agent's own built-in tools can still read files on your computer, so use agents you trust, and prefer an API provider for text from people you don't know.

### Translating many languages at once

In **Translate missing**, tick the languages you want, or **All languages**. Progress is shown per language. Cancelling keeps the translations already finished, and the whole run can be undone.

Machine translations are marked in the grid until someone reviews them.

### Custom instructions

Tell the AI about tone, terms or audience at three levels:

- **All projects:** Preferences.
- **One project:** project Settings.
- **One language in a project:** project Settings. Project and language instructions are stored in `.retrans/state.json` and shared through git.

## Working with a translator

A translator package is a `.zip` that is a complete, openable project: the locale files, `.retrans/state.json`, the project settings, and a manifest (`.retrans/package.json`) that remembers what the project looked like when it was exported.

1. **Export (developer).** Save your project, then open the **Import / Export** page, and under **Export for translator** pick the languages and click **Export…**. Save the zip. Export refuses while there are unsaved edits.
2. **Send the zip.** Any channel works.
3. **Open (translator).** On the start screen choose **Open translator package…**, pick the zip, and choose where to put it: Retrans extracts it into a new folder named after the zip. Opening the same zip again offers the folder it already made and never overwrites your work. Retrans never edits files inside the zip.
4. **Translate.** Edit and mark cells Reviewed as usual, then Save.
5. **Send back (translator).** On the Import / Export page, under **Send back to the developer**, click **Export…**. The original baseline is kept, so the developer can tell what changed.
6. **Import (developer).** On the Import / Export page choose **Import package (.zip)…** (or **Import folder…**). Cells the translator filled are added, status changes are applied, and cells both of you changed differently are listed as conflicts to resolve. Your own edits elsewhere are untouched, and the base language is never changed.
7. **Review and save.** Check the imported cells, then Save.

## TypeScript translations and workspaces

Some projects keep their translations in TypeScript modules instead of JSON, for example `const common = { email: { th: 'อีเมล', en: 'Email' } }` passed through `mapLocale`, or one object per language (`buttonTH`, `buttonEN`). Retrans edits these through a **workspace**.

- **Import.** Choose **Open project** and pick the project folder (or its locales folder). When Retrans finds TypeScript locale modules but no JSON project, it shows **Import TypeScript translations**. It looks in `src/assets/locales`, `src/locales`, `src/i18n` and `locales`, ignores `mapLocale.ts`, `__tests__/` and `*.test.*` / `*.spec.*` files, and never edits `src/utils/i18n.ts` or any other code. The base language defaults to `th` when the project has it. Each file becomes a **Group**. Values computed in code (a template literal, a variable) are shown read-only.
- **Where it lives.** The workspace is stored in `<project>/.retrans/`: the translations as JSON under `.retrans/workspace/`, the workspace settings in `.retrans/workspace.json`, review status in `.retrans/state.json`, and what the TypeScript files held at the last import, sync or export in `.retrans/source-baseline.json`. Commit `.retrans/` with the project if you want to share review status.
- **Save vs Export.** **Save** writes only the workspace in `.retrans/`; it never touches your TypeScript files. **Export…** is the only thing that writes outside the workspace.
- **Export kinds.**
  1. **TypeScript:** **Write back to the original files** (a minimal diff: only the changed string literals change, and quotes, indentation, line breaks and comments stay as they were), **Write TypeScript files to another folder**, or **TypeScript modules (table style)** for new code.
  2. **i18next JSON:** one file per group (`<locale>/<group>.json`) or one `translation.json` per language.
  3. **Paraglide:** `messages/<locale>.json` plus `project.inlang/settings.json`. `{{x}}` placeholders become `{x}`; i18next format modifiers are dropped, with a warning.

  Untranslated keys are left out of JSON and Paraglide exports (never written as `""`). A language added in Retrans is not written into existing TypeScript files: write-back lists it as left out and shows a snippet to add it by hand.
- **Auto-sync.** When a workspace opens, and whenever the TypeScript files change on disk (a `git pull`, an edit in your code editor), Retrans merges the change into the workspace, cell by cell: a value changed only in the code is taken, a value changed only in Retrans is kept, and a value changed differently on both sides is a conflict to resolve. Keys removed from the code are marked **Removed in source** (Keep or Delete them); they are never deleted silently. Write-back syncs first and refuses while a conflict is open. If the source folder is missing (for example in a translator package), the app shows "Source files not found — showing the saved workspace." and changes nothing.
- **The " (EN)" rule.** A value in language `xx` that ends with ` (XX)`, such as `'Reset password (EN)'` in `en`, is an untranslated marker and counts as **missing**. If the text before the marker isn't just the base-language value, Retrans offers it as a **Draft**; accepting it makes it a normal translation. On write-back, a cell that is still missing keeps its original marker text, so the code still shows the fallback.
- **Duplicate keys.** The same key in two groups gives two rows, each marked **Duplicate key**. Export to single-file i18next JSON and to Paraglide is blocked until they are renamed; per-group JSON and the TypeScript exports still work.
- **Renames.** Renaming a key in Retrans survives syncs. Write-back carries it to the code: the old key is removed from the TypeScript object and the new key written in its place.
- **Format-free new projects.** **New project** creates an empty workspace (default location `~/Documents/Retrans/<name>/`, or any empty folder you choose) that isn't tied to a file format. Add groups, keys and languages, then pick the format at **Export…** time.
- **Translator packages** work for workspaces too. The package holds the workspace (without the TypeScript files and the source baseline), so the translator works on it like any project; importing it back works as described above. Write back to the code afterwards with **Export…**.

## Figma Variables

Retrans reads the `.tokens.json` files Figma exports for Variables.

- **Open or import.** Open a folder of `.tokens.json` exports directly, or import them into a workspace alongside your code's translations.
- **Translate and link.** Translate the strings, then give each one a code key or link it to an existing key.
- **Resolve differences.** When Figma and your code disagree, you resolve it in a git-style conflict view (*From code / From Figma / Original*), or edit a final version.
- **Export back.** Export to Figma changes only the text values, so re-importing updates your variables instead of duplicating them.

## Keyboard shortcuts

macOS shortcuts are shown; on Windows use Ctrl in place of ⌘.

| Action | Shortcut |
| --- | --- |
| Save a cell | Enter |
| Save a cell and mark it reviewed | ⌘⇧R |
| Next missing cell | Tab |
| Cancel editing | Esc |
| Accept an AI suggestion | ⌘Enter |
| Undo / redo | ⌘Z / ⇧⌘Z (Ctrl+Z / Ctrl+Y) |
| New project / Open project | ⌘N / ⌘O |
| Save / Export | ⌘S / ⌘E |
| Find | ⌘F |
| Close tab / switch tabs | ⌘W / Ctrl+Tab |
| Preferences | ⌘, |
