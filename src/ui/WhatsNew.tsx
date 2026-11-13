import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { AppIcon } from "./AppIcon";
import { RELEASES, type Release } from "./changelog";
import { Icon, type IconName } from "./Icon";
import { useApp } from "./store";

/** The website's changelog: every release, the same text as here. */
export const CHANGELOG_URL = "https://oxth.github.io/retrans/#changelog";

const open = (url: string) => void Promise.resolve(openUrl(url)).catch(() => {});

/** "2026-11-13" as a local date (not UTC midnight, which can be the day before). */
const day = (iso: string) => new Date(`${iso}T00:00:00`);
const shortDate = (iso: string) => day(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const longDate = (iso: string) => day(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

/** The changelog's inline Markdown: **bold**, `code` and [text](url). */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = out.length;
    if (m[1] !== undefined) out.push(<strong key={k} className="font-semibold text-fg">{inline(m[1])}</strong>);
    else if (m[2] !== undefined) out.push(<code key={k} className="rounded bg-sunken px-1 font-mono text-[0.9em]">{m[2]}</code>);
    else {
      const url = m[4];
      out.push(
        <a key={k} href={url} className="text-brand-ink underline decoration-brand-line underline-offset-2 hover:decoration-current"
          onClick={(e) => { e.preventDefault(); open(url); }}>
          {m[3]}
        </a>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const SECTION_ICON: Record<string, IconName> = { "What's new": "sparkles", Improvements: "plus", "Bug fixes": "check", Fixes: "check" };

/** A band of translation cells, one still missing: the app icon's grid, stretched into a banner. Decorative. */
function Banner({ version }: { version: string }) {
  const cols = 14;
  const rows = 3;
  // Same cell flagged as missing for a given version, a different one for the next.
  const seed = version.split(".").reduce((n, p) => n * 31 + Number(p || 0), 7);
  const missing = 3 + (seed % (cols - 6));
  return (
    <div className="relative h-28 shrink-0 overflow-hidden bg-gradient-to-br from-[#4f46e5] to-[#0d9488]">
      <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${cols * 40} ${rows * 34 + 10}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        {Array.from({ length: rows }, (_, r) =>
          Array.from({ length: cols }, (_, c) => {
            const key = c % 3 === 0;
            const isMissing = r === 1 && c === missing;
            return (
              <rect key={`${r}-${c}`} x={c * 40 + 6} y={r * 34 + 10} width={key ? 22 : 30} height={20} rx={6}
                fill={isMissing ? "none" : "#fff"} opacity={isMissing ? 1 : key ? 0.14 : 0.26}
                stroke={isMissing ? "#fca5a5" : undefined} strokeWidth={isMissing ? 2.5 : undefined} strokeDasharray={isMissing ? "5 4" : undefined} />
            );
          }),
        )}
      </svg>
      {/* Keeps the name readable over the cells. */}
      <div className="absolute inset-0 bg-gradient-to-r from-black/35 via-black/10 to-transparent" />
      <div className="absolute bottom-4 left-8 flex items-center gap-3">
        <AppIcon size={44} className="rounded-[10px] shadow-lg ring-2 ring-white/40" />
        <div className="text-white drop-shadow">
          <div className="text-lg font-semibold leading-tight">Retrans</div>
          <div className="font-mono text-sm opacity-90">{version}</div>
        </div>
      </div>
    </div>
  );
}

function Notes({ release }: { release: Release }) {
  return (
    <div className="px-8 pb-8 pt-6">
      <h2 className="text-2xl font-semibold tracking-tight">What's new in Retrans {release.version}</h2>
      <p className="mt-1 text-sm text-muted">{longDate(release.date)}</p>
      {release.intro.map((p, i) => <p key={i} className="mt-4 text-sm text-fg-2">{inline(p)}</p>)}
      {release.sections.map((s) => (
        <section key={s.title} className="mt-7">
          <h3 className="mb-2 text-base font-semibold">{s.title}</h3>
          {s.items.length > 0 && (
            <ul className="divide-y divide-line">
              {s.items.map((item, i) => (
                <li key={i} className="flex gap-3 py-2.5 text-sm leading-relaxed text-fg-2">
                  <Icon name={SECTION_ICON[s.title] ?? "check"} size={15} className="mt-[3px] shrink-0 text-brand" />
                  <span>{inline(item)}</span>
                </li>
              ))}
            </ul>
          )}
          {s.paragraphs.map((p, i) => <p key={i} className="mt-2 text-sm leading-relaxed text-fg-2">{inline(p)}</p>)}
        </section>
      ))}
    </div>
  );
}

/** What's new: every release's notes, with the installed version marked and shown first. */
export function WhatsNew() {
  const close = useApp((s) => s.closeWhatsNew);
  const asked = useApp((s) => s.whatsNewVersion);
  /** null while reading it; "" when it can't be read. */
  const [installed, setInstalled] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(() => (RELEASES.some((r) => r.version === asked) ? asked : null));
  const panel = useRef<HTMLDivElement>(null);
  const notes = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(getVersion)
      .then((v) => live && setInstalled(v), () => live && setInstalled(""));
    return () => { live = false; };
  }, []);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { if (before?.isConnected) before.focus(); };
  }, []);
  useEffect(() => {
    notes.current?.scrollTo?.({ top: 0 });
  }, [selected]);

  // Waits for the installed version, so the window doesn't open on the newest notes and then jump.
  const current = selected ?? (installed === null ? null : RELEASES.some((r) => r.version === installed) ? installed : RELEASES[0]?.version);
  const release = RELEASES.find((r) => r.version === current);

  return (
    <div role="dialog" aria-label="What's new" aria-modal="true" className="fixed inset-0 z-40 flex items-center justify-center bg-scrim p-4"
      onKeyDown={(e) => e.key === "Escape" && close()}
      onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={panel} tabIndex={-1}
        className="flex h-[min(42rem,88vh)] w-full max-w-[56rem] overflow-hidden rounded-xl border border-line bg-surface text-fg shadow-pop outline-none">
        <nav aria-label="Versions" className="flex w-52 shrink-0 flex-col border-r border-line bg-panel">
          <div className="px-4 pb-2 pt-4 text-sm font-semibold">What's new</div>
          <ul className="min-h-0 flex-1 overflow-y-auto px-2">
            {RELEASES.map((r) => {
              const active = r.version === current;
              return (
                <li key={r.version}>
                  <button type="button" aria-current={active ? "true" : undefined} onClick={() => setSelected(r.version)}
                    className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ${active ? "bg-hover font-medium text-fg" : "text-fg-2 hover:bg-hover"}`}>
                    <span className="font-mono">{r.version}</span>
                    {r.version === installed ? (
                      <span className="rounded border border-line-strong px-1.5 text-[11px] leading-4 text-fg-2">Installed</span>
                    ) : (
                      <span className="text-xs text-muted">{shortDate(r.date)}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <button type="button" onClick={() => open(CHANGELOG_URL)}
            className="flex items-center gap-1 border-t border-line px-4 py-3 text-left text-xs text-muted hover:text-fg">
            Changelog on the web <span aria-hidden="true">↗</span>
          </button>
        </nav>
        <div className="relative flex min-w-0 flex-1 flex-col">
          <button type="button" aria-label="Close" onClick={close}
            className="absolute right-3 top-3 z-10 rounded-md p-1 text-white/80 hover:bg-white/15 hover:text-white">
            <Icon name="x" size={16} />
          </button>
          <div ref={notes} className="min-h-0 flex-1 overflow-y-auto">
            {release ? (
              <Fragment key={release.version}>
                <Banner version={release.version} />
                <Notes release={release} />
              </Fragment>
            ) : (
              current !== null && <p className="p-8 text-sm text-muted">No release notes yet.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
