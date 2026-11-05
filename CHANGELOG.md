# Changelog

All notable changes to Retrans. Downloads are on the [releases page](https://github.com/oxth/retrans/releases).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-11-05

### What's new

- **A fresh look, with dark mode.** Retrans follows your system's light or dark setting. Colors are calmer and consistent, icons replace text symbols, and the header shows at a glance whether everything is saved.
- **One-click review.** Every translation that isn't reviewed yet has a **✓ Review** button. When the base text changes after a translation was written, the cell says **Needs review**, so you know to check it.
  - A status key in the sidebar explains what each dot means.
  - The cell editor lists its shortcuts: Enter to save, ⌘⇧R / Ctrl+Shift+R to save and mark reviewed, Tab for the next missing cell, Esc to cancel.
- **Tidy recent projects.** Remove a project from the start screen's recent list with **×**. A project whose folder was moved or deleted is marked **Folder not found**, and opening it offers to take it off the list. Your files are never touched.

### Improvements

- The start screen explains each way to begin: open a project, create one, or open a translator package.
- The toolbar groups search, filters and actions. The Missing count is a badge, the Languages menu shows how many languages are visible, and **+ Key** is now **Add key**.
- Missing translations are outlined instead of filled red, so large projects are easier to read.
- Keyboard focus is visible everywhere, and text meets WCAG AA contrast in both light and dark mode.
- The Settings and Import / Export pages scroll when they're taller than the window.
- The Open project and New project dialogs match the rest of the app, and the new-project wizard shows its steps.
- Retrans is now open source under the MIT License.

### Bug fixes

- Escape closes dialogs straight away. Before, it only worked after clicking inside the dialog, and never in Open project or New project.
- Closing a dialog puts keyboard focus back where it was.
- The toolbar's Languages menu closes when you click elsewhere or press Escape.

## [0.2.0] - 2026-11-05

### What's new

- **AI translation providers.** Translate with OpenAI (ChatGPT), Claude (Anthropic) or any OpenAI-compatible API (OpenRouter, Groq, DeepSeek, Ollama, LM Studio…), as well as the built-in local model. You can also use an AI agent you already have through ACP (Claude Code, Codex, Gemini CLI) with your existing subscription.
  - API keys are kept in the macOS Keychain / Windows Credential Manager, never in files.
  - The first time you choose a provider, Retrans asks before any text is sent, and names where it goes.
  - **Test this model** shows exactly what is sent.
  - Each project can use its own provider.
  - Replies stream in, so translations appear as they arrive.
- **Translate missing in several languages at once.** Tick the languages you want, or **All languages**. Progress is shown per language.
- **Custom instructions for the AI.** Set them for all projects (Preferences), for one project, and per language (project Settings, stored in `.retrans/state.json` and shared through git).
- **Figma Variables.** Open a folder of Figma `.tokens.json` exports directly, or import them into a workspace.
  - Translate the strings, then give each one a code key or link it to an existing key.
  - When Figma and your code disagree, you resolve it in a git-style conflict view (*From code / From Figma / Original*), or edit a final version.
  - Export back to Figma changes only the text values, so re-importing updates your variables instead of duplicating them.
- **Workspace tabs.** Keep several projects open and switch instantly. Each tab keeps its own edits, filters and file watching, and work in a background tab keeps running. Your tabs reopen on the next launch; to start on the start screen instead, use Preferences → Startup.
- **Auto-save.** Edits are written to your files about a second after you stop typing. Unsaved work left by a crash is put back on the next launch without asking.
- **Undo and redo** for edits, review marks, key changes, conflict picks and whole Translate-missing runs (⌘Z / ⇧⌘Z, Ctrl+Z / Ctrl+Y).
- **Preferences page and app menus.** App-wide settings have their own Preferences page (⌘, / Ctrl+,). There are full menus with the usual shortcuts: New ⌘N, Open ⌘O, Close Tab ⌘W, Save ⌘S, Export ⌘E, Find ⌘F, and Ctrl+Tab to switch tabs.

### Improvements

- Settings survive updates and reinstalls. Older settings files are upgraded, never reset.
- The window reopens at the size and position you left it, maximized or not.
- Quitting with unsaved changes asks once, listing the projects. This now includes Cmd+Q.
- Cell suggestions use whichever AI provider is active.
- The local Qwen models follow your custom instructions too. TranslateGemma keeps its fixed prompt, and Settings says so.

### Bug fixes

- Cmd+Q no longer quits without saving or asking.
- The row ⋯ menu no longer opens behind the next row, and it now closes when you click elsewhere, press Escape or scroll.

### Note on AI agents

Retrans gives an agent no file or terminal access of its own and refuses every permission it asks for. An agent's own built-in tools can still read files on your computer, so use agents you trust, and prefer an API provider for text from people you don't know.

## [0.1.1] - 2026-11-04

### Bug fixes

- Quitting the app no longer shows a "Retrans quit unexpectedly" report on macOS after the built-in translation model has been used.

## [0.1.0] - 2026-11-04

First release.

### What's new

- **One grid for every key and language** in next-i18next and Paraglide (inlang) projects, in a list or table view. Missing translations stand out, and each cell tracks its review status.
- **Minimal, git-friendly saves.** Only the values you changed are rewritten; formatting, key order and comments stay as they were.
- **Built-in machine translation** with a local model (TranslateGemma or Qwen), running entirely on your computer. Get suggestions while editing, or fill every missing cell with **Translate missing**.
- **Translator packages.** Export a `.zip` for a translator, who opens it in Retrans and sends it back. You import the result with a clear view of what changed and any conflicts.
- **TypeScript translations through workspaces.** Import TypeScript locale modules, edit them safely, sync automatically when the code changes, and write back a minimal diff. You can also export to i18next JSON or Paraglide.
- **Crash recovery.** Unsaved edits are kept and offered back after a crash.
- **Automatic updates** on macOS (Apple Silicon) and Windows.

[0.3.0]: https://github.com/oxth/retrans/releases/tag/v0.3.0
[0.2.0]: https://github.com/oxth/retrans/releases/tag/v0.2.0
[0.1.1]: https://github.com/oxth/retrans/releases/tag/v0.1.1
[0.1.0]: https://github.com/oxth/retrans/releases/tag/v0.1.0
