import { getVersion } from "@tauri-apps/api/app";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ProjectSession } from "../core/session";
import { findModel } from "../mt/catalog";
import {
  type Appearance,
  clearViewMode,
  DEFAULT_APPEARANCE,
  getAppearance,
  getDefaultViewMode,
  getOwnViewMode,
  setAppearance,
  setDefaultViewMode,
  type Theme,
} from "../platform/prefs";
import { applyAppearance } from "./appearance";
import { reportBug, showLogFile } from "./bug-report";
import { btnDanger, btnGhost, btnPrimary, Dialog, inputCls, sectionLabel } from "./Dialog";
import { FigmaSettings } from "./FigmaSettings";
import { AppIcon } from "./AppIcon";
import { Icon, type IconName } from "./Icon";
import { MtSettings } from "./MtSettings";
import { useMt } from "./mt-store";
import { ProjectMtSettings } from "./ProjectMtSettings";
import { btnRow, fieldBase, Group, Row, Segmented, UnsavedContext } from "./settings-ui";
import { StartupSettings } from "./StartupSettings";
import { type SettingsSection, useApp } from "./store";
import { UpdateSettings } from "./UpdateBanner";

interface SectionDef {
  id: SettingsSection;
  label: string;
  hint: string;
  icon: IconName;
  /** Extra words the search box matches. */
  keywords: string;
  project?: boolean;
}

const SECTIONS: SectionDef[] = [
  { id: "project", label: "Files", hint: "Where this project's translation files live", icon: "folder", keywords: "locales path folder files", project: true },
  { id: "translation", label: "Translation", hint: "This project's provider and instructions", icon: "languages", keywords: "provider instructions prompt language", project: true },
  { id: "figma", label: "Figma", hint: "Figma folder, modes and import", icon: "layers", keywords: "figma modes import variables", project: true },
  { id: "general", label: "General", hint: "What happens when Retrans starts", icon: "sliders", keywords: "startup open reopen launch start screen" },
  { id: "appearance", label: "Appearance", hint: "Theme, interface size and layout", icon: "monitor", keywords: "theme dark light mode system size zoom font text scale default view list table" },
  { id: "mt", label: "Machine translation", hint: "Who translates: a built-in model, a cloud API or an AI agent", icon: "sparkles", keywords: "model provider api key openai anthropic claude agent gguf download" },
  { id: "instructions", label: "AI instructions", hint: "Rules sent with every translation, for all projects", icon: "message", keywords: "prompt instructions tone style" },
  { id: "about", label: "About", hint: "Version and software updates", icon: "info", keywords: "about version update install release what's new changelog bug report problem log issue" },
];

/** Which sections apply: project ones only with a project open, Figma only for workspaces. */
function available(session: ProjectSession | null): SectionDef[] {
  return SECTIONS.filter((s) => {
    if (!s.project) return true;
    if (!session) return false;
    if (s.id === "project") return !session.workspace;
    if (s.id === "figma") return !!session.workspace;
    return true;
  });
}

/**
 * The Settings window: a sidebar of sections (this project's, then the app's) and the chosen
 * section on the right. Opened from the app menu (⌘,), the start screen and the project sidebar.
 */
export function SettingsDialog() {
  const close = useApp((s) => s.closePrefs);
  const session = useApp((s) => s.session);
  const asked = useApp((s) => s.prefsSection);
  const sections = available(session);
  const [current, setCurrent] = useState<SettingsSection>(() => (sections.some((s) => s.id === asked) ? asked! : sections[0].id));
  const [query, setQuery] = useState("");
  const [version, setVersion] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // A section with unsaved edits (Machine translation): leaving it asks first.
  const [unsaved, setUnsaved] = useState(false);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const unsavedRef = useRef(unsaved);
  unsavedRef.current = unsaved;
  const guard = useCallback((go: () => void) => (unsavedRef.current ? setLeaving(() => go) : go()), []);

  // Follow a later request (e.g. Import Figma Files… while Settings is already open).
  useEffect(() => {
    if (asked && sections.some((s) => s.id === asked)) setCurrent(asked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);
  // The project can close under us (⌘W): fall back to a section that still applies.
  const active = sections.find((s) => s.id === current) ?? sections.find((s) => !s.project)!;

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(getVersion)
      .then(
        (v) => live && setVersion(v),
        () => {},
      );
    return () => {
      live = false;
    };
  }, []);

  // Focus in, Escape out (unless a dialog opened from here is on top), focus back on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    root.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== root.current?.parentElement) return;
      e.preventDefault();
      guard(close);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (before?.isConnected) before.focus();
    };
  }, [close, guard]);

  const q = query.trim().toLowerCase();
  const shown = q ? sections.filter((s) => `${s.label} ${s.hint} ${s.keywords}`.toLowerCase().includes(q)) : sections;

  const navItem = (s: SectionDef) => {
    const on = s.id === active.id;
    return (
      <button
        key={s.id}
        type="button"
        aria-current={on ? "page" : undefined}
        onClick={() => s.id !== active.id && guard(() => setCurrent(s.id))}
        className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-150 ${
          on ? "bg-brand-soft font-medium text-brand-ink" : "text-fg-2 hover:bg-hover hover:text-fg"
        }`}
      >
        <Icon name={s.icon} size={15} className={on ? "text-brand" : "text-muted"} />
        <span className="truncate">{s.label}</span>
      </button>
    );
  };
  const projectItems = shown.filter((s) => s.project);
  const globalItems = shown.filter((s) => !s.project);

  return (
    <div role="dialog" aria-modal="true" aria-label="Settings" className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 sm:p-8">
      <div
        ref={root}
        tabIndex={-1}
        className="flex h-[min(44rem,100%)] w-full max-w-[60rem] overflow-hidden rounded-xl border border-line bg-surface text-sm text-fg shadow-pop outline-none"
      >
        <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-panel">
          <div className="space-y-3 p-3 pb-2">
            <h1 className="px-1 pt-1 text-sm font-semibold">Settings</h1>
            <label className="relative block">
              <span className="sr-only">Search settings</span>
              <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <input
                type="search"
                className="w-full rounded-md border border-line bg-surface py-1.5 pl-8 pr-2.5 text-sm text-fg placeholder:text-muted focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand-line"
                placeholder="Search…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && shown[0] && shown[0].id !== active.id) guard(() => setCurrent(shown[0].id));
                }}
              />
            </label>
          </div>
          <nav aria-label="Settings sections" className="min-h-0 flex-1 space-y-4 overflow-auto px-2 pb-3 pt-1">
            {projectItems.length > 0 && (
              <div className="space-y-0.5">
                <div className={`${sectionLabel} px-2.5 pb-1`} title={session?.data.root}>
                  Project
                </div>
                {projectItems.map(navItem)}
              </div>
            )}
            {globalItems.length > 0 && (
              <div className="space-y-0.5">
                <div className={`${sectionLabel} px-2.5 pb-1`}>App</div>
                {globalItems.map(navItem)}
              </div>
            )}
            {shown.length === 0 && <p className="px-2.5 text-xs text-muted">No settings match "{query.trim()}".</p>}
          </nav>
          {version && <div className="border-t border-line px-4 py-2.5 font-mono text-xs text-muted">Retrans v{version}</div>}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-7 py-5">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <Icon name={active.icon} size={17} className="text-brand" />
                {active.label}
              </h2>
              <p className="mt-0.5 text-xs text-muted">{active.hint}</p>
            </div>
            <button type="button" aria-label="Close settings" onClick={() => guard(close)} className="-mr-2 rounded-md p-1.5 text-muted transition-colors duration-150 hover:bg-hover hover:text-fg">
              <Icon name="x" size={16} />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-auto">
            <div key={active.id} className="mx-auto flex min-h-full max-w-[44rem] flex-col gap-7 px-7 py-6">
              <UnsavedContext.Provider value={setUnsaved}>
                <SectionBody id={active.id} session={session} version={version} />
              </UnsavedContext.Provider>
            </div>
          </div>
        </main>
      </div>
      {leaving && (
        <Dialog title="Discard unsaved changes?" onClose={() => setLeaving(null)}>
          <p className="text-sm">Your changes to {active.label} haven't been saved. Leave without saving?</p>
          <div className="mt-5 flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setLeaving(null)}>Keep editing</button>
            <button
              className={btnDanger}
              onClick={() => {
                const go = leaving;
                setLeaving(null);
                setUnsaved(false);
                go();
              }}
            >
              Discard changes
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function SectionBody({ id, session, version }: { id: SettingsSection; session: ProjectSession | null; version: string | null }): ReactNode {
  switch (id) {
    case "project":
      return session && <ProjectGeneral session={session} />;
    case "translation":
      return session && <ProjectMtSettings session={session} />;
    case "figma":
      return session && <FigmaSettings session={session} />;
    case "appearance":
      return <AppearanceSettings />;
    case "general":
      return (
        <Group label="Startup">
          <StartupSettings />
        </Group>
      );
    case "mt":
      return <MtSettings session={session} />;
    case "instructions":
      return <GlobalInstructions />;
    case "about":
      return <About version={version} />;
  }
}

/** Project → General: the folder and the locales path override (single projects only). */
function ProjectGeneral({ session }: { session: ProjectSession }) {
  const detectedPath = useApp((s) => s.detected?.localesPath) ?? session.opts.localesPath;
  const override = session.state.project.localesPath;
  const [path, setPath] = useState(override ?? session.opts.localesPath ?? "");
  const [note, setNote] = useState<string | null>(null);
  const save = () => {
    const p = path.trim();
    // Only a path that differs from the detected one is an override.
    const next = p && p !== detectedPath ? p : undefined;
    session.setProjectSetting({ localesPath: next });
    if (!next) setPath(detectedPath);
    setNote(next || override ? "Saved. Written to .retrans/state.json on the next save." : "Using the detected path.");
  };
  return (
    <>
      <Group label="Location">
        <Row label="Project folder" hint="Where Retrans opened this project from.">
          <span className="max-w-72 truncate font-mono text-xs text-fg-2" title={session.data.root}>{session.data.root}</span>
        </Row>
      </Group>
      <Group label="Files" footer={note ? <span role="status">{note}</span> : "Takes effect when you reopen the project."}>
        <Row label="Locales path" hint={`Detected: ${detectedPath || "none"}. Change it only if detection picked the wrong folder.`} htmlFor="locales-path">
          <input
            id="locales-path"
            aria-label="Locales path"
            className={`${fieldBase} w-52 font-mono`}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            placeholder="public/locales"
          />
          <button type="button" className={btnPrimary} onClick={save}>Save path</button>
        </Row>
        {override !== undefined && (
          <Row label="Reset" hint="Go back to the folder Retrans detected.">
            <button
              type="button"
              className={btnRow}
              onClick={() => {
                session.setProjectSetting({ localesPath: undefined });
                setPath(detectedPath);
                setNote(`Reset to the detected path (${detectedPath}).`);
              }}
            >
              Reset to detected
            </button>
          </Row>
        )}
      </Group>
    </>
  );
}

/** App → Appearance: theme, interface size, and the default view. */
function AppearanceSettings() {
  const [look, setLook] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getAppearance().then(
      (a) => live && setLook(a),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  const change = (patch: Partial<Appearance>) => {
    const next = { ...look, ...patch };
    setLook(next);
    setNote(null);
    applyAppearance(next); // on screen at once
    setAppearance(next).catch(() => setNote("Could not save the appearance. It applies until Retrans restarts."));
  };
  return (
    <>
      <Group label="Interface" footer={note && <span role="status" className="text-danger">{note}</span>}>
        <Row stacked label="Theme" hint="Color theme for the whole app. System follows your computer's light or dark mode.">
          <ThemePicker value={look.theme} onChange={(theme) => change({ theme })} />
        </Row>
        <Row label="Interface size" hint="Scales text and controls everywhere in Retrans.">
          <Segmented
            label="Interface size"
            value={look.size}
            options={[
              { value: "small", label: "Small" },
              { value: "default", label: "Default" },
              { value: "large", label: "Large" },
              { value: "larger", label: "Larger" },
            ]}
            onChange={(size) => change({ size })}
          />
        </Row>
      </Group>
      <DefaultViewSettings />
    </>
  );
}

const THEMES: Array<{ value: Theme; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/** Three preview cards. The previews show each theme's own colors, whatever theme is on now. */
function ThemePicker({ value, onChange }: { value: Theme; onChange: (t: Theme) => void }) {
  const preview = (bg: string, line: string, accent: string) => (
    <span className="flex h-full flex-col justify-center gap-1.5 px-3" style={{ background: bg }}>
      <span className="h-1 w-3/5 rounded-full" style={{ background: accent }} />
      <span className="h-1 w-4/5 rounded-full" style={{ background: line }} />
      <span className="h-1 w-1/2 rounded-full" style={{ background: line }} />
    </span>
  );
  const LIGHT = preview("#ffffff", "#cfd3df", "#4f46e5");
  const DARK = preview("#0f1117", "#363c50", "#8b85ff");
  return (
    <div role="radiogroup" aria-label="Theme" className="flex flex-wrap gap-3">
      {THEMES.map((t) => {
        const on = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(t.value)}
            className="group flex flex-col items-center gap-1.5"
          >
            <span
              className={`relative block h-14 w-24 overflow-hidden rounded-lg border-2 transition-colors duration-150 ${
                on ? "border-brand" : "border-line group-hover:border-line-strong"
              }`}
            >
              {t.value === "light" ? LIGHT : t.value === "dark" ? DARK : (
                <>
                  <span className="absolute inset-0">{LIGHT}</span>
                  <span className="absolute inset-0" style={{ clipPath: "polygon(60% 0, 100% 0, 100% 100%, 40% 100%)" }}>{DARK}</span>
                </>
              )}
            </span>
            <span className={`text-xs ${on ? "font-medium text-fg" : "text-muted group-hover:text-fg-2"}`}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Appearance → Layout: the default view, and the open project's own view if it has one. */
function DefaultViewSettings() {
  const root = useApp((s) => s.session?.data.root ?? null);
  const projectName = root ? (root.split("/").filter(Boolean).pop() ?? root) : null;
  const changed = useApp((s) => s.viewPrefsChanged);
  const [mode, setMode] = useState<"list" | "table">("list");
  /** The open project's own view, when it has one (set with the toolbar's List / Table switch). */
  const [own, setOwn] = useState<"list" | "table" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getDefaultViewMode().then(
      (m) => live && setMode(m),
      () => {},
    );
    if (root)
      getOwnViewMode(root).then(
        (m) => live && setOwn(m),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [root]);
  const label = (m: "list" | "table") => (m === "list" ? "List" : "Table");
  return (
    <Group label="Layout" footer={note && <span role="status" className="text-danger">{note}</span>}>
      <Row label="Default view" hint="For projects that haven't picked their own with the List / Table switch.">
        <Segmented
          label="Default view"
          value={mode}
          options={[
            { value: "list", label: "List" },
            { value: "table", label: "Table" },
          ]}
          onChange={(m) => {
            setMode(m);
            setNote(null);
            setDefaultViewMode(m).then(changed, () => setNote("Could not save the default view."));
          }}
        />
      </Row>
      {root && own && (
        <Row
          label={<>This project: {projectName}</>}
          hint={`Uses its own view (${label(own)}), picked with the List / Table switch, so the default doesn't apply to it.`}
        >
          <button
            type="button"
            className={btnRow}
            onClick={() => {
              clearViewMode(root).then(
                () => {
                  setOwn(null);
                  changed();
                },
                () => setNote("Could not reset this project's view."),
              );
            }}
          >
            Use the default ({label(mode)})
          </button>
        </Row>
      )}
    </Group>
  );
}

/** App → About: what this is, its version, and updates. */
function About({ version }: { version: string | null }) {
  return (
    <>
      <div className="flex items-center gap-4 rounded-lg border border-line bg-panel px-4 py-4">
        <AppIcon size={44} />
        <div className="min-w-0">
          <div className="text-sm font-semibold">Retrans</div>
          <div className="font-mono text-xs text-muted">{version ? `Version ${version}` : "Version unknown"}</div>
        </div>
      </div>
      <UpdateSettings />
      <Group label="Problems" footer="The log has no translation text or API keys. Your home folder is written as ~.">
        <Row label="Report a bug" hint="Opens a bug report on GitHub with your version filled in, and shows the log file to attach.">
          <button type="button" className={btnRow} onClick={() => void reportBug().catch((e) => console.warn("Report a bug failed", e))}>
            <Icon name="alert" size={14} />
            Report a bug…
          </button>
        </Row>
        <Row label="Log file" hint={`What Retrans recorded: warnings, errors and when it started. Shortcut: ${navigator.userAgent.includes("Mac") ? "⌘⇧L" : "Ctrl+Shift+L"}.`}>
          <button type="button" className={btnRow} onClick={() => void showLogFile().catch((e) => console.warn("Showing the log failed", e))}>
            <Icon name="folder" size={14} />
            Show log file
          </button>
        </Row>
      </Group>
    </>
  );
}

/** App → AI instructions: combined with each project's and language's own. */
function GlobalInstructions() {
  const instructions = useMt((s) => s.settings.instructions);
  const fixedPrompt = useMt((s) => {
    const { provider, modelId, custom } = s.settings;
    if ((provider ?? "local") !== "local") return false;
    const template = modelId === "custom" ? custom?.template : modelId ? findModel(modelId)?.template : undefined;
    return template === "translategemma";
  });
  return (
    <Group label="All projects" footer="Each project can add its own in its Translation settings; those come after these.">
      <Row
        stacked
        htmlFor="global-instructions"
        label="Instructions for all projects"
        hint="Sent with every translation by cloud providers, AI agents and Qwen models."
      >
        <textarea
          id="global-instructions"
          aria-label="Instructions for all projects"
          className={`${inputCls} resize-y`}
          rows={4}
          placeholder="e.g. Keep translations short: this is UI text."
          defaultValue={instructions}
          onBlur={(e) => void useMt.getState().setInstructions(e.target.value.trim())}
        />
        {fixedPrompt && <p className="text-xs text-warn">TranslateGemma uses a fixed prompt and ignores custom instructions.</p>}
      </Row>
    </Group>
  );
}
