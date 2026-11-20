import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { btnGhost, btnPrimary, trapTab } from "./Dialog";
import { useApp } from "./store";

const mod = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl+";

/** One stop: what it points at (the first match on screen) and what it says. */
export interface TourStop {
  /** CSS selectors, tried in order; the stop is skipped when none is on screen. */
  targets: string[];
  title: string;
  body: ReactNode;
  /** Said instead when it points at a later target (the first one isn't there). */
  fallback?: { title: string; body: ReactNode };
}

/** The stops on a project's Translations page. Each target is checked by ProjectTour.test.tsx. */
export const STOPS: TourStop[] = [
  {
    targets: ['[data-cell="missing"]'],
    title: "Fill in what's missing",
    body: <>A red dot means there's no translation yet. Click the cell to type one, and press Tab to jump to the next missing cell.</>,
  },
  {
    // The pinned Review (Source changed) is always visible; elsewhere it shows on hover, so point at the cell.
    targets: ['[data-cell="value"] [data-review="pinned"]', '[data-cell="value"][data-reviewable]'],
    title: "Mark translations reviewed",
    body: (
      <>
        When a translation looks right, click <strong>Review</strong> (or select it and press {mod}⇧R). It shows when you hover or select a
        translation, and stays in view where the source changed. The ring fills in, and the status is shared through git.
      </>
    ),
  },
  {
    targets: ['[role="group"][aria-label="Filters"]'],
    title: "Show only what needs work",
    body: <>Filter to missing cells, translations whose base text changed, or ones written by AI.</>,
  },
  {
    targets: ['[data-tour="translate"]', '[data-tour="settings"]'],
    title: "Let AI fill the gaps",
    body: <><strong>Translate missing…</strong> fills every empty cell, in all languages at once. AI drafts are tagged until someone reviews them.</>,
    fallback: {
      title: "Turn on AI translation",
      body: (
        <>
          In Settings → Machine translation, pick a built-in model (your text stays on your computer), a cloud API or an AI agent. Then{" "}
          <strong>Translate missing…</strong> appears in the toolbar to fill every empty cell at once.
        </>
      ),
    },
  },
  {
    targets: ['[data-tour="pages"]'],
    title: "Languages, translators and files",
    body: <>Add or remove languages on <strong>Languages</strong>. <strong>Import / Export</strong> sends a package to a translator and brings their work back.</>,
  },
  {
    targets: ['[data-tour="save"]'],
    title: "Saved for you",
    body: <>Edits are saved a moment after you stop typing, or right away with {mod}S. {mod}Z undoes anything, even a whole AI run.</>,
  },
];

const PAD = 6;
const GAP = 12;
const CARD_W = 320;

/** The first target of `stop` on screen (and whether it's the first in the list), or null. */
function locate(stop: TourStop): { el: HTMLElement; first: boolean } | null {
  // Rows and controls that aren't shown aren't rendered, so being in the page is enough.
  for (const [i, sel] of stop.targets.entries()) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return { el, first: i === 0 };
  }
  return null;
}
const find = (stop: TourStop) => locate(stop)?.el ?? null;

/** Below the target when it fits, else above; kept inside the window. */
function place(r: DOMRect, cardH: number): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const below = r.bottom + PAD + GAP;
  const top = below + cardH <= vh - 8 ? below : Math.max(8, r.top - PAD - GAP - cardH);
  const left = Math.min(Math.max(8, r.left + r.width / 2 - CARD_W / 2), vw - CARD_W - 8);
  return { top, left };
}

/**
 * The step-by-step tour of a project: dims the window, outlines one control at a time and says
 * what it does. Opens by itself the first time the sample project opens, and from Help → Tour
 * of This Screen.
 */
export function ProjectTour() {
  const close = useApp((s) => s.closeProjectTour);
  const [stops, setStops] = useState<TourStop[] | null>(null);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [cardH, setCardH] = useState(180);
  const card = useRef<HTMLDivElement>(null);

  // The tour is about the Translations page, with nothing filtered away.
  useEffect(() => {
    const { ui, setUi } = useApp.getState();
    if (ui.page !== "translations") setUi({ page: "translations" });
  }, []);
  // The stops whose control is on screen, once the page has drawn.
  useEffect(() => {
    const id = requestAnimationFrame(() => setStops(STOPS.filter((s) => find(s))));
    return () => cancelAnimationFrame(id);
  }, []);

  const stop = stops?.[i];
  const measure = useCallback(() => {
    const el = stop && find(stop);
    setRect(el ? el.getBoundingClientRect() : null);
  }, [stop]);

  useLayoutEffect(() => {
    if (!stop) return;
    find(stop)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    measure();
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
    };
  }, [stop, measure]);
  useLayoutEffect(() => {
    if (card.current) setCardH(card.current.offsetHeight);
    card.current?.focus();
  }, [i, stops]);
  useEffect(() => {
    if (stops && stops.length === 0) close();
  }, [stops, close]);

  if (!stops || !stop) return null;
  const last = i === stops.length - 1;
  const { title, body } = stop.fallback && locate(stop)?.first === false ? stop.fallback : stop;
  const pos = rect ? place(rect, cardH) : { top: window.innerHeight / 2 - cardH / 2, left: window.innerWidth / 2 - CARD_W / 2 };

  return (
    <div role="dialog" aria-label="Tour" aria-modal="true" className="fixed inset-0 z-40"
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
        else if (e.key === "ArrowRight" && !last) setI(i + 1);
        else if (e.key === "ArrowLeft" && i > 0) setI(i - 1);
        trapTab(e, e.currentTarget);
      }}>
      {/* Clicks anywhere but the card are held back, so the tour isn't left behind a changed screen. */}
      <div className="absolute inset-0" />
      {rect && (
        <div aria-hidden="true" className="pointer-events-none absolute rounded-lg ring-2 ring-brand transition-all duration-200"
          style={{
            top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2,
            boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.45)",
          }} />
      )}
      <div ref={card} tabIndex={-1} aria-live="polite"
        className="absolute rounded-xl border border-line bg-surface p-4 text-fg shadow-pop outline-none transition-[top,left] duration-200"
        style={{ top: pos.top, left: pos.left, width: CARD_W }}>
        <p className="text-xs font-medium text-muted">{i + 1} of {stops.length}</p>
        <h2 className="mt-0.5 text-base font-semibold">{title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-fg-2">{body}</p>
        <div className="mt-4 flex items-center gap-2">
          <button type="button" className={`${btnGhost} -ml-2`} onClick={close}>{last ? "Close" : "Skip"}</button>
          <div className="ml-auto flex gap-2">
            {i > 0 && <button type="button" className={btnGhost} onClick={() => setI(i - 1)}>Back</button>}
            <button type="button" className={btnPrimary} onClick={last ? close : () => setI(i + 1)}>{last ? "Done" : "Next"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
