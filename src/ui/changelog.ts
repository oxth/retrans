/** Release notes for What's new, parsed from CHANGELOG.md (bundled at build time, so they work offline). */
import changelogMd from "../../CHANGELOG.md?raw";

export interface ReleaseSection {
  /** "What's new", "Improvements", "Fixes"… */
  title: string;
  /** Markdown bullets: **bold**, `code` and [links](url) are rendered. */
  items: string[];
  /** Plain paragraphs in the section (e.g. "Note on AI agents"). */
  paragraphs: string[];
}

export interface Release {
  version: string;
  /** ISO date, e.g. "2026-11-13". */
  date: string;
  sections: ReleaseSection[];
  /** Plain paragraphs before the first section (e.g. "First release."). */
  intro: string[];
}

/** Released versions, newest first. `## [Unreleased]` and the link list at the bottom are skipped. */
export function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let section: ReleaseSection | null = null;
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const head = /^## \[(\d+\.\d+\.\d+[^\]]*)\] - (\d{4}-\d{2}-\d{2})/.exec(line);
    if (head) {
      release = { version: head[1], date: head[2], sections: [], intro: [] };
      section = null;
      releases.push(release);
    } else if (line.startsWith("## ")) {
      release = null; // [Unreleased]
    } else if (!release) {
      continue;
    } else if (line.startsWith("### ")) {
      section = { title: line.slice(4).trim(), items: [], paragraphs: [] };
      release.sections.push(section);
    } else if (/^[-*] /.test(line)) {
      if (!section) {
        section = { title: "What's new", items: [], paragraphs: [] };
        release.sections.push(section);
      }
      section.items.push(line.slice(2).trim());
    } else if (/^\s+\S/.test(line) && section?.items.length) {
      section.items[section.items.length - 1] += ` ${line.trim()}`; // wrapped bullet
    } else if (line && !line.startsWith("[")) {
      (section ? section.paragraphs : release.intro).push(line);
    }
  }
  return releases;
}

export const RELEASES: Release[] = parseChangelog(changelogMd);

/** Compares "1.2.10" and "1.3.0" numerically: negative when a is older. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Whether to say "Updated to `current`": the previous launch ran an older version ("" = older but
 * unrecorded) and this one has release notes to show. Not on a first launch or a downgrade.
 */
export function shouldAnnounceUpdate(previous: string | null, current: string, releases: Release[] = RELEASES): boolean {
  if (previous === null || previous === current) return false;
  if (previous && compareVersions(previous, current) >= 0) return false;
  return releases.some((r) => r.version === current);
}
