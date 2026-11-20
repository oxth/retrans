import { createContext, useCallback, useContext, useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { isValidLocale } from "../core/session-helpers";
import { sectionLabel } from "./Dialog";
import { Icon } from "./Icon";
import { COMMON_LOCALES, localeLabel } from "./locales";

/**
 * Building blocks for the Settings window: a labelled group is a bordered card of rows, and each
 * row is "label and hint on the left, control on the right" (or the control below, when stacked).
 */

export function Group({ label, children, footer }: { label?: string; children: ReactNode; footer?: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={label ? id : undefined} className="space-y-2">
      {label && (
        <h3 id={id} className={`${sectionLabel} px-1`}>
          {label}
        </h3>
      )}
      <div className="divide-y divide-line rounded-lg border border-line bg-panel">{children}</div>
      {footer && <div className="px-1 text-xs leading-5 text-muted">{footer}</div>}
    </section>
  );
}

export function Row({
  label,
  hint,
  children,
  stacked,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  /** Put the control under the label, full width (text areas, lists, long fields). */
  stacked?: boolean;
  /** The control's id, so clicking the label focuses it. */
  htmlFor?: string;
}) {
  const head = (
    <div className="min-w-0">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="block text-sm font-medium text-fg">
          {label}
        </label>
      ) : (
        <div className="text-sm font-medium text-fg">{label}</div>
      )}
      {hint && <div className="mt-0.5 text-xs leading-5 text-muted">{hint}</div>}
    </div>
  );
  if (stacked)
    return (
      <div className="space-y-2.5 px-4 py-3.5">
        {head}
        {children}
      </div>
    );
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
      {head}
      {children !== undefined && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** A checkbox drawn as an on/off switch. Still a checkbox to assistive tech and tests. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <span className="relative inline-flex h-5 w-9 shrink-0 items-center">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="peer h-5 w-9 cursor-pointer appearance-none rounded-full bg-faint transition-colors duration-150 checked:bg-brand disabled:cursor-not-allowed disabled:opacity-50"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150 peer-checked:translate-x-4 motion-reduce:transition-none"
      />
    </span>
  );
}

/**
 * Arrow keys for a radiogroup of buttons: ←/↑ and →/↓ move and select (wrapping), Home/End go to the
 * ends. Pair it with tabIndex 0 on the checked radio only, so the group is one Tab stop.
 */
export function radioKeys<T>(e: KeyboardEvent<HTMLElement>, values: T[], value: T, onChange: (v: T) => void) {
  const i = values.indexOf(value);
  const n = values.length;
  const to =
    e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % n
    : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + n) % n
    : e.key === "Home" ? 0
    : e.key === "End" ? n - 1
    : -1;
  if (to < 0) return;
  e.preventDefault();
  onChange(values[to]);
  e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[to]?.focus();
}

/** A small set of mutually exclusive choices shown as joined buttons. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-md border border-line-strong bg-surface p-0.5"
      onKeyDown={(e) => radioKeys(e, options.map((o) => o.value), value, onChange)}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`rounded px-3 py-1 text-xs font-medium transition-colors duration-150 ${on ? "bg-brand text-on-brand" : "text-fg-2 hover:bg-hover hover:text-fg"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Inputs and selects that sit on the right of a row. */
export const fieldBase =
  "rounded-md border border-field-line bg-surface px-2.5 py-1.5 text-sm text-fg hover:border-muted focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand disabled:opacity-50";
export const fieldCls = `${fieldBase} w-60`;
/** Compact buttons that sit beside a field in a row. */
export const btnRow =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-field-line bg-surface px-2.5 py-1.5 text-sm font-medium text-fg hover:bg-hover disabled:opacity-50";

/**
 * Lets a section with a Save button tell the Settings window it has unsaved edits, so leaving the
 * section or closing Settings asks first. Outside the window (tests) it does nothing.
 */
export const UnsavedContext = createContext<(dirty: boolean) => void>(() => {});

export function useReportUnsaved(dirty: boolean) {
  const report = useContext(UnsavedContext);
  useEffect(() => {
    report(dirty);
  }, [dirty, report]);
  useEffect(() => () => report(false), [report]);
}

/**
 * What a group's footer says after a setting changes: "Saved" for app settings (written at once,
 * cleared after a moment), a sticky note for project settings (written on the project's next save),
 * or the error when writing failed. Nothing changes silently.
 */
export const PROJECT_PENDING = "Changed. Written to .retrans/state.json when you save the project.";
export function useSaveNote() {
  const [note, setNote] = useState<{ ok: boolean; text: string; sticky?: boolean } | null>(null);
  useEffect(() => {
    if (!note?.ok || note.sticky) return;
    const t = setTimeout(() => setNote(null), 2000);
    return () => clearTimeout(t);
  }, [note]);
  /** Runs a save; shows "Saved" (or `ok`) when it resolves, the error when it fails. `quiet`: errors only. */
  const track = useCallback((save: () => Promise<unknown> | unknown, opts: { ok?: string; sticky?: boolean; quiet?: boolean } = {}) => {
    void Promise.resolve()
      .then(save)
      .then(
        () => !opts.quiet && setNote({ ok: true, text: opts.ok ?? "Saved", sticky: opts.sticky }),
        (e) => setNote({ ok: false, text: `Couldn't save: ${e instanceof Error ? e.message : String(e)}` }),
      );
  }, []);
  /** For project settings: staged in the session, written when the project is saved. */
  const trackProject = useCallback((save: () => unknown) => track(save, { ok: PROJECT_PENDING, sticky: true }), [track]);
  const footer = note && (
    <span role="status" className={note.ok ? (note.sticky ? "text-fg-2" : "text-ok") : "text-danger"}>
      {note.ok && !note.sticky ? `${note.text} ✓` : note.text}
    </span>
  );
  return { track, trackProject, footer };
}

/** Switches Settings to another section (through the unsaved-changes guard). Outside Settings it does nothing. */
export const GoToSectionContext = createContext<(id: string) => void>(() => {});

/** A section name in running text that opens that section. */
export function SectionLink({ to, children }: { to: string; children: string }) {
  const go = useContext(GoToSectionContext);
  return (
    <button type="button" className="font-medium text-fg-2 underline decoration-line-strong underline-offset-2 hover:text-fg" onClick={() => go(to)}>
      {children}
    </button>
  );
}

/** The bar at the bottom of a form section: status on the left, actions on the right. */
export function SaveBar({ status, children }: { status?: ReactNode; children: ReactNode }) {
  return (
    <div className="sticky bottom-0 -mx-7 -mb-6 mt-auto flex items-center justify-between gap-4 border-t border-line bg-surface px-7 py-3">
      <div className="min-w-0 text-xs text-muted">{status}</div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** Language suggestions: the project's own languages first, then common ones. */
export function languageOptions(projectLocales: string[] = []): string[] {
  return [...new Set([...projectLocales, ...COMMON_LOCALES])];
}

/** Why a test can't run with these languages, or null. */
export function languagePairError(from: string, to: string): string | null {
  if (!from || !to) return "Choose both languages.";
  if (!isValidLocale(from)) return `"${from}" isn't a language code.`;
  if (!isValidLocale(to)) return `"${to}" isn't a language code.`;
  if (from.toLowerCase() === to.toLowerCase()) return "Pick two different languages: the text would come back unchanged.";
  return null;
}

/**
 * From ⇄ To for the "Try it" panels: each is a language code typed or picked from the list, with
 * the language's name shown underneath so it's clear what will be asked.
 */
export function LanguagePair({
  from,
  to,
  onFrom,
  onTo,
  options,
}: {
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  options: string[];
}) {
  const listId = useId();
  const field = (label: string, value: string, set: (v: string) => void) => (
    <label className="block min-w-0">
      <span className="mb-1 block text-xs font-medium text-fg-2">{label}</span>
      <input
        aria-label={`${label === "From" ? "Source" : "Target"} language`}
        list={listId}
        autoComplete="off"
        spellCheck={false}
        className={`${fieldBase} w-32 font-mono`}
        value={value}
        onChange={(e) => set(e.target.value.trim())}
      />
      <span className="mt-1 block h-4 truncate text-xs text-muted">{value && isValidLocale(value) ? localeLabel(value) : ""}</span>
    </label>
  );
  return (
    <div className="flex items-start gap-2">
      {field("From", from, onFrom)}
      <button
        type="button"
        aria-label="Swap languages"
        title="Swap languages"
        className="mt-6 rounded-md p-1.5 text-muted transition-colors duration-150 hover:bg-hover hover:text-fg"
        onClick={() => {
          onFrom(to);
          onTo(from);
        }}
      >
        <Icon name="swap" size={15} />
      </button>
      {field("To", to, onTo)}
      <datalist id={listId}>
        {options.map((l) => (
          <option key={l} value={l} label={localeLabel(l)} />
        ))}
      </datalist>
    </div>
  );
}

/** Starting languages for a test: the project's base → its first other language (Thai if it has it). */
export function defaultPair(base: string | undefined, locales: string[] = []): { from: string; to: string } {
  const from = base ?? "en";
  const others = locales.filter((l) => l !== from);
  const to = others.includes("th") ? "th" : (others[0] ?? (from === "th" ? "en" : "th"));
  return { from, to };
}

/** A reply that is just the input again usually means the languages were wrong, or the model ignored the task. */
export const sameAsInput = (input: string, output: string) => input.trim() === output.trim();
export const UNCHANGED_NOTE = "The model returned the text unchanged. Check that From is the language of your text, or try another model.";
