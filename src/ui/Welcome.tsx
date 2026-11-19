import { useEffect, useRef, useState, type ReactNode } from "react";
import { AppIcon } from "./AppIcon";
import { btnGhost, btnPrimary, trapTab } from "./Dialog";
import { Icon, type IconName } from "./Icon";
import { useApp } from "./store";

/** One line of a step: an icon, a bold lead-in, then the explanation. */
function Point({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3 py-2.5 text-sm leading-relaxed text-fg-2">
      <Icon name={icon} size={16} className="mt-[3px] shrink-0 text-brand" />
      <span>
        <strong className="font-semibold text-fg">{title}</strong> {children}
      </span>
    </li>
  );
}

interface Step {
  title: string;
  lead: string;
  body: ReactNode;
}

const STEPS: Step[] = [
  {
    title: "Welcome to Retrans",
    lead: "Edit every translation of your app in one place. Two quick screens, then we'll show you around.",
    body: (
      <ul className="divide-y divide-line">
        <Point icon="folder" title="Open">your project's translation files.</Point>
        <Point icon="search" title="Find">what's missing in each language.</Point>
        <Point icon="sparkles" title="Fill">the gaps yourself, or let AI draft them.</Point>
        <Point icon="check" title="Review and save.">Only the values you changed are written, so git diffs stay small.</Point>
      </ul>
    ),
  },
  {
    title: "Bring your translations",
    lead: "The start screen has three ways in.",
    body: (
      <ul className="divide-y divide-line">
        <Point icon="folder" title="Open project:">
          pick the folder that holds your translations. Retrans finds next-i18next, Paraglide, TypeScript locale modules and Figma
          Variables (<code className="rounded bg-sunken px-1 font-mono text-[0.9em]">.tokens.json</code>) by itself.
        </Point>
        <Point icon="folderPlus" title="New project:">start from scratch, add languages and keys, and choose a file format later.</Point>
        <Point icon="package" title="Open translator package:">a .zip a developer sent you to translate.</Point>
      </ul>
    ),
  },
  {
    title: "Learn by doing",
    lead: "The quickest way to learn is a project with a few gaps in it. Pick where to start:",
    body: null,
  },
];

/** The last step's choices: each closes the tour and goes there. */
function Choices({ onSample, onOpen, onAi }: { onSample(): void; onOpen(): void; onAi(): void }) {
  const choice = "flex w-full items-start gap-3 rounded-lg border p-3 text-left";
  return (
    <div className="space-y-2">
      <button type="button" onClick={onSample} className={`${choice} border-brand bg-brand-soft hover:border-brand-hover`}>
        <Icon name="sparkles" size={18} className="mt-0.5 shrink-0 text-brand" />
        <span>
          <span className="block text-sm font-semibold text-brand-ink">Try the sample project</span>
          <span className="block text-xs text-fg-2">A small app in English, French and Japanese. We'll point out each part of the screen as you go.</span>
        </span>
      </button>
      <button type="button" onClick={onOpen} className={`${choice} border-line hover:border-line-strong hover:bg-hover`}>
        <Icon name="folder" size={18} className="mt-0.5 shrink-0 text-brand" />
        <span>
          <span className="block text-sm font-semibold">Open my own project</span>
          <span className="block text-xs text-muted">Help → Tour of This Screen shows you around once it's open.</span>
        </span>
      </button>
      <button type="button" onClick={onAi} className={`${choice} border-line hover:border-line-strong hover:bg-hover`}>
        <Icon name="lock" size={18} className="mt-0.5 shrink-0 text-brand" />
        <span>
          <span className="block text-sm font-semibold">Set up AI translation</span>
          <span className="block text-xs text-muted">Optional. A built-in model keeps your text on your computer; cloud AI and agents work too.</span>
        </span>
      </button>
    </div>
  );
}

/** The app icon's grid with one cell missing, as a band. Decorative. */
function Banner({ step }: { step: number }) {
  const cols = 14;
  return (
    <div className="relative h-24 shrink-0 overflow-hidden bg-gradient-to-br from-[#4f46e5] to-[#0d9488]">
      <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${cols * 40} 112`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        {Array.from({ length: 3 }, (_, r) =>
          Array.from({ length: cols }, (_, c) => {
            const key = c % 3 === 0;
            // Moves one cell per step, starting clear of the label on the left.
            const missing = r === 1 && c === 7 + step;
            return (
              <rect key={`${r}-${c}`} x={c * 40 + 6} y={r * 34 + 10} width={key ? 22 : 30} height={20} rx={6}
                fill={missing ? "none" : "#fff"} opacity={missing ? 1 : key ? 0.14 : 0.26}
                stroke={missing ? "#fca5a5" : undefined} strokeWidth={missing ? 2.5 : undefined} strokeDasharray={missing ? "5 4" : undefined} />
            );
          }),
        )}
      </svg>
      <div className="absolute inset-0 bg-gradient-to-r from-black/35 via-black/10 to-transparent" />
      <div className="absolute bottom-4 left-8 flex items-center gap-3">
        <AppIcon size={40} className="rounded-[10px] shadow-lg ring-2 ring-white/40" />
        <div className="text-sm font-medium text-white drop-shadow">Getting started</div>
      </div>
    </div>
  );
}

/**
 * Getting started: a few steps on how Retrans works. Opens by itself on the very first launch;
 * Help → Getting Started and the start screen open it again.
 */
export function Welcome() {
  const close = useApp((s) => s.closeWelcome);
  const [step, setStep] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const last = step === STEPS.length - 1;
  const { title, lead, body } = STEPS[step];

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { if (before?.isConnected) before.focus(); };
  }, []);

  /** Closes the tour, then does what the last step's button says. */
  const then = (fn: () => void) => () => {
    close();
    fn();
  };
  const openProject = then(() => {
    useApp.getState().showStart();
    useApp.getState().requestUi("open-project");
  });
  const openSample = then(() => {
    useApp.getState().showStart();
    useApp.getState().requestUi("open-sample");
  });
  const setUpAi = then(() => useApp.getState().openPrefs("mt"));

  return (
    <div role="dialog" aria-label="Getting started" aria-modal="true" className="fixed inset-0 z-40 flex items-center justify-center bg-scrim p-4"
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
        else if (e.key === "ArrowRight" && !last) setStep(step + 1);
        else if (e.key === "ArrowLeft" && step > 0) setStep(step - 1);
        trapTab(e, e.currentTarget);
      }}
      onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={panel} tabIndex={-1}
        className="relative flex max-h-[88vh] w-full max-w-[36rem] flex-col overflow-hidden rounded-xl border border-line bg-surface text-fg shadow-pop outline-none">
        <button type="button" aria-label="Close" onClick={close}
          className="absolute right-3 top-3 z-10 rounded-md p-1 text-white/80 hover:bg-white/15 hover:text-white">
          <Icon name="x" size={16} />
        </button>
        <Banner step={step} />
        <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-6 pt-6">
          <p className="text-xs font-medium text-muted">Step {step + 1} of {STEPS.length}</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">{title}</h2>
          <p className="mt-2 text-sm text-fg-2">{lead}</p>
          <div className="mt-4">{last ? <Choices onSample={openSample} onOpen={openProject} onAi={setUpAi} /> : body}</div>
        </div>
        <div className="flex items-center gap-3 border-t border-line px-8 py-4">
          <div className="flex gap-1.5" aria-hidden="true">
            {STEPS.map((s, i) => (
              <button key={s.title} type="button" tabIndex={-1} onClick={() => setStep(i)}
                className={`h-1.5 rounded-full ${i === step ? "w-5 bg-brand" : "w-1.5 bg-line-strong hover:bg-muted"}`} />
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            {step > 0 ? (
              <button type="button" className={btnGhost} onClick={() => setStep(step - 1)}>Back</button>
            ) : (
              <button type="button" className={btnGhost} onClick={close}>Skip</button>
            )}
            {last ? (
              <button type="button" className={btnGhost} onClick={close}>Maybe later</button>
            ) : (
              <button type="button" className={btnPrimary} onClick={() => setStep(step + 1)}>Next</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
