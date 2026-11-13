# Changelog

All notable changes to Retrans. Downloads are on the [releases page](https://github.com/oxth/retrans/releases).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### What's new

- **What's New in Retrans.** See what changed in every version, right in the app: open it from the Retrans menu (Help on Windows) or from **Settings → About**. The version you have is marked **Installed**. After an update, a note in the corner says which version you're on, with a link to its notes.

- **Report a Bug.** Help → Report a Bug… (or Settings → About) opens a bug report on GitHub with your version and system filled in, and shows Retrans's log file so you can attach it. **Help → Show Log File** (⌘⇧L / Ctrl+Shift+L) opens the log any time. Ideas go to **Help → Request a Feature…**. The log records warnings, errors and when Retrans started; it has no translation text or API keys, and your home folder is written as `~`.

### Improvements

- **Tabs in the title bar** on macOS, next to the window buttons, so projects get more room. Drag the empty part of the bar to move the window, or double-click it to zoom. The start screen shows as a **New Tab**, and Settings is always the gear at the end of the bar.
- **Search recent projects** on the start screen, by name or folder.
- **Resizable table columns.** Drag the right edge of a column header in the table view to make it wider or narrower, or double-click it to reset. Retrans remembers the widths.
- **About Retrans** on macOS now shows the version and build, a short description, links and the copyright.
- In a narrow table column, the text of a translation now wraps around its warning, **Source changed** and **Review** marks and uses the full width below them.

## [0.5.1] - 2026-11-13

### Fixes

- In the table view, a translation marked **Source changed** no longer squeezes its text into a narrow column one letter per line. The chip and the **Review** button move to their own line when there isn't room ([#1](https://github.com/oxth/retrans/issues/1)).
- The **⋯** menu on a key now opens above the button when there isn't room below it, so it can be read on the last rows of a long list ([#2](https://github.com/oxth/retrans/issues/2)).

## [0.5.0] - 2026-11-06

### What's new

- **One Settings window.** Open it from the gear at the top right (or ⌘, / Ctrl+,). The sidebar lists the open project's settings first, then the app's: General, Appearance, Machine translation, AI instructions and About. A search box finds any setting.
- **Appearance.** Choose a light or dark theme, or follow your system, and make the whole interface smaller or larger. The default List or Table view now changes open projects straight away, and Settings tells you when a project keeps its own view.
- **Source changed.** "Needs review" is now called **Source changed**, and it finally shows up when it should: when the base text changes in your code editor or through a `git pull`, not only when you edit it in Retrans. The first time you open a project, Retrans records what each translation was based on in `.retrans/state.json`. Commit that change once.
- **Rename and delete groups.** The Languages page explains what groups (namespaces) are, lists them with their key counts, and lets you rename or delete them. Groups that come from your TypeScript code say why they can only be changed there.
- **Plural keys made clear.** When adding a key, switch the text to **Plural** to fill in each form your base language needs, such as "1 item" and "5 items", with the numbers each form is used for.

### Improvements

- Machine translation settings apply when you press **Save**, with **Discard** and **Test connection**, so nothing changes halfway through typing an address or a key. Retrans asks before you leave with unsaved changes.
- **Test this model** lets you pick the language you're translating from and to, refuses the same language on both sides, and points out when a model sends your text back unchanged.
- **About** shows the version, update checks and a link to what's new.
- Dropdowns now match the text fields around them in both themes.
- The start screen and About show the real app icon.
- The project sidebar is simpler: close a project with the **×** on its tab or ⌘W / Ctrl+W.

## [0.4.1] - 2026-11-06

### What's new

- **Intel Macs.** Retrans now runs on Intel Macs with macOS 11 Big Sur or newer, as well as Apple Silicon. On Intel Macs the built-in AI model runs on the CPU, so it is slower than on Apple Silicon; cloud AI providers are unaffected.

## [0.4.0] - 2026-11-05

### What's new

- **Linux.** Retrans now runs on Linux, as an AppImage (which updates itself) or a .deb package for Debian and Ubuntu. API keys are kept in your system keyring (GNOME Keyring or KWallet). The built-in AI model runs on the CPU in a version that works on any 64-bit PC, so it is slower than on macOS and Windows; cloud AI providers are unaffected.

### Improvements

- **New app icon.** A grid of translations with one missing cell flagged in red, the same way Retrans marks missing translations. It stays clear at small sizes in the Dock, taskbar and file lists.

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

[0.5.1]: https://github.com/oxth/retrans/releases/tag/v0.5.1
[0.5.0]: https://github.com/oxth/retrans/releases/tag/v0.5.0
[0.4.1]: https://github.com/oxth/retrans/releases/tag/v0.4.1
[0.4.0]: https://github.com/oxth/retrans/releases/tag/v0.4.0
[0.3.0]: https://github.com/oxth/retrans/releases/tag/v0.3.0
[0.2.0]: https://github.com/oxth/retrans/releases/tag/v0.2.0
[0.1.1]: https://github.com/oxth/retrans/releases/tag/v0.1.1
[0.1.0]: https://github.com/oxth/retrans/releases/tag/v0.1.0
