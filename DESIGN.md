# Design System: Retrans

Character: a proofing desk for strings, quiet and dense, so the translations are the loudest thing on screen.
(Extracted from `src/index.css`; the Character line and the usage rules below are assumed, confirm before shipping.)

## World
Translators and developers working through string tables: keys, language pairs, proof marks (missing, checked, changed).
Long sessions at a desk, mostly keyboard, on macOS first.

## Typography
- Family: the system stack (`system-ui, -apple-system, "Segoe UI", sans-serif`, set on `body` in `src/index.css`). Chosen on purpose: Retrans is a native desktop app (Tauri), and SF Pro / Segoe match the OS menus and dialogs around it. Nothing to load, works offline.
- Mono: `ui-monospace, SFMono-Regular, Menlo, monospace` (Tailwind `font-mono`), only for translation keys and code, which people copy and compare character by character. Never for counts or percentages (those use `tabular-nums`).
- Scale: 12 / 14 / 15 px. Deliberately low contrast: an expert tool where density matters more than drama. The page title (15 px semibold) is the only step up from body (14 px).
- Floor: 12 px (`text-xs`) for metadata, badges and key hints. Nothing smaller.
- Weights: 400 body, 500 labels and buttons, 600 titles and the current item.
- Case: sentence case everywhere, including section labels and table headers. No uppercase-with-tracking labels.

## Color
Tokens are `--c-*` in `src/index.css` (light in `:root`, dark under `prefers-color-scheme` and `[data-theme="dark"]`), exposed to Tailwind as `--color-*`.
- Neutrals, cool blue-grey: `--c-surface` #ffffff / `--c-panel` #f6f7fb / `--c-sunken` #eceef4 / `--c-line` #e3e5ee / `--c-line-strong` #cfd3df (dark: #0f1117 / #151824 / #1b1f2d / #262a39 / #363c50). Cool, so the text and the status colours carry the warmth.
- Text: `--c-fg` #14161f, `--c-fg-2` #3d4250, `--c-muted` #5b6070 (5.85:1 on panel); dark #e8eaf2 / #c4c8d4 / #a0a6b8 (7.27:1 on panel). `--c-faint` #8a8f9e is for icons only, never text.
- Signature accent `--c-brand` #4f46e5 (dark #8b85ff), the indigo of the app icon and the download site. White on it 6.29:1; it on white 6.29:1. Used ONLY for: the primary button, the current page in the sidebar, an active filter, the hidden-languages count, and the focus ring. Not for decorative icons or informational badges.
- Danger `--c-danger` #b91c1c / solid #dc2626 (hue ≈ 0°), 243° away from the indigo signature. Destructive actions and errors only.
- Warn `--c-warn` #92400e / solid #f59e0b; ok `--c-ok` #0f766e / solid #14b8a6. Semantic only.
- Translation status (the proof marks, ≥ 3:1 as UI marks): missing `--c-st-missing` #ef4444 (filled dot), not reviewed `--c-st-translated` #c26a05 (hollow ring), reviewed `--c-st-reviewed` #0d9488 (filled dot). Shape differs as well as colour.

## Radii
- 6 px (`rounded-md`): buttons, fields, filter chips, badges' container controls, cells.
- 4 px (`rounded`): small inline badges (AI, Too long, Source changed, kbd).
- 8 px (`rounded-lg`): floating layers: menus, popovers, dialogs, toasts.
- Full: only status dots, progress bars and the tab-bar update dot. No pill-shaped controls.

## Spacing
- Base 4 px; scale 4 / 6 / 8 / 12 / 16 / 24.
- Dense: 4–8 px inside a group (a cell's dot and text, a chip's label and count, a key and its metadata), 16 px between regions (header, toolbar, table, sidebar sections), 24 px between sidebar sections.
- A row is as tall as its content: key metadata (group, badges) sits on one line under the key.

## Separation
- Borders, 1 px `--c-line`, are the one separation language for anything in the page: panes, rows, columns, controls.
- Shadows (`--shadow-pop`) only on layers that float above the page: menus, popovers, dialogs, toasts. No `shadow-sm` on in-page controls; a selected segment or tab gets a 1 px ring in `--c-line` instead.

## States
- Hover: `--c-hover` behind neutral controls; the brand button darkens to `--c-brand-hover`.
- Focus: the global `:focus-visible` rule, 2 px solid `--c-brand`, offset 2 px (0 on fields).
- Selected: `--c-brand-soft` fill with `--c-brand-ink` text (6.98:1) and a `--c-brand-line` border.
- Disabled: 50 % opacity plus `cursor: not-allowed`.

## Status and badges
- Warn tag (Too long, Source changed, Unsaved): `--c-warn` #92400e on `--c-warn-soft` #fffbeb, 6.84:1; dark #fcd34d on #2a2112, 10.99:1.
- Danger banner: `--c-danger` #b91c1c on `--c-danger-soft` #fef2f2, 5.91:1; dark #fca5a5 on #2a1517, 9.08:1.
- Ok text: `--c-ok` #0f766e on `--c-ok-soft` #f0fdfa, 5.25:1; dark #5eead4 on #0f2624, 10.73:1.
- Neutral tag (AI, No code key yet, plural, complex): `--c-fg-2` #3d4250 on `--c-sunken` #eceef4, 8.65:1; dark #c4c8d4 on #1b1f2d, 9.81:1.
- Selected chip: `--c-brand-ink` #4338ca on `--c-brand-soft` #eef0ff, 6.98:1; dark #c7c4ff on #1d1f33, 9.85:1.

## Components
- Buttons (`src/ui/Dialog.tsx`): `btnPrimary` brand fill, one per screen; `btnSecondary` 1 px `--c-field-line` border; `btnGhost` text only; `btnDanger` only as the confirming button inside a dialog.
- Filter chip (`Toolbar.tsx`): 6 px radius, border `--c-line-strong`, selected per States.
- Section label (`sectionLabel`): 12 px semibold `--c-muted`, sentence case.

## Voice
- Plain words over jargon ("Not reviewed", "Source changed"), sentence case, verbs on buttons, an ellipsis when a button opens a dialog.

## Figma plugin (Retrans Preview)
The plugin lives inside Figma, so it follows Figma's design, not the app tokens above: it should look native next to Figma's own panels, in light and dark.
- Colour: only Figma's theme variables (`--figma-color-*`, with `themeColors: true` in `showUI`). The one Retrans touch is the 16 px mark in the header, drawn in `--figma-color-bg-brand`.
- Type: 11/16 px for the panel's own text, 12/18 px for the translations being checked (they are the content).
- Controls: 24 px high, 5 px corners; Fits / Too long is one joined control with the note beside it. Pressed Fits uses `--figma-color-bg-selected`, pressed Too long `--figma-color-bg-warning-tertiary`.
- Steps: tabs underlined in `--figma-color-border-selected`; focus: a 2 px ring in the same colour.
- Source: `figma-plugin/src/ui.html` (styles) and `ui.ts` (markup).
