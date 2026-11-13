import { getVersion } from "@tauri-apps/api/app";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { DetectResult } from "../formats/adapter";
import { initLogging, log, logFilePath, redact, systemInfo, type SystemInfo } from "../platform/log";
import { useApp } from "./store";

const NEW_ISSUE_URL = "https://github.com/oxth/retrans/issues/new";

/** The bug form's "Operating system" option (.github/ISSUE_TEMPLATE/bug_report.yml). */
export function osOption(info: SystemInfo | null): string {
  if (info?.os === "macos") return info.arch === "aarch64" ? "macOS (Apple Silicon)" : "macOS (Intel)";
  if (info?.os === "windows") return "Windows";
  if (info?.os === "linux") return "Linux";
  return "Other";
}

/** The bug form's "Project format" option for the open project. */
export function formatOption(detected: DetectResult | null): string {
  if (!detected) return "Not related to a project";
  const ws = detected.workspace;
  if (ws?.source) return "TypeScript workspace";
  if (ws?.figma) return "Figma Variables";
  if (ws) return "New (format-free) project";
  return detected.format === "paraglide" ? "Paraglide / inlang" : "next-i18next (JSON)";
}

/**
 * A new GitHub issue from the bug form, with what Retrans knows already filled in. Field ids are
 * the query keys; never use "format": GitHub reads ?format= as the response type and answers 406.
 */
export function bugReportUrl(o: { version: string; os: string; format: string; logPath: string }): string {
  const q = new URLSearchParams({
    template: "bug_report.yml",
    version: o.version,
    os: o.os,
    "project-format": o.format,
    logs: `Please attach retrans.log (drag the file here). Retrans showed it when you chose Report a Bug; it is in:\n${o.logPath}`,
  });
  return `${NEW_ISSUE_URL}?${q}`;
}

/** Help → Request a Feature…: the GitHub feature request form (it has nothing Retrans could fill in). */
export const FEATURE_REQUEST_URL = `${NEW_ISSUE_URL}?template=feature_request.yml`;

export async function requestFeature(): Promise<void> {
  await openUrl(FEATURE_REQUEST_URL);
}

/** Shows the log file in Finder / Explorer, so it can be attached. */
export async function showLogFile(): Promise<void> {
  const path = await logFilePath();
  log.info("Log file shown for a bug report");
  await revealItemInDir(path);
}

/** Help → Report a Bug…: the GitHub bug form, filled in, and the log file to attach to it. */
export async function reportBug(): Promise<void> {
  const [version, info, logPath] = await Promise.all([
    getVersion().catch(() => "unknown"),
    systemInfo().catch(() => null),
    logFilePath().catch(() => "the Retrans log folder"),
  ]);
  const { detected } = useApp.getState();
  const url = bugReportUrl({
    version: typeof __COMMIT__ === "string" && __COMMIT__ ? `${version} (${__COMMIT__})` : version,
    os: osOption(info),
    format: formatOption(detected),
    logPath: redact(logPath),
  });
  await openUrl(url);
  await showLogFile().catch(() => {});
}

/**
 * Starts the log for this run: a startup line, then every error or notice the app shows (the bar
 * under the toolbar) as a warning, so the log matches what the user saw.
 */
export function startLogging(): () => void {
  initLogging(async () => {
    const [version, info] = await Promise.all([getVersion().catch(() => "unknown"), systemInfo().catch(() => null)]);
    const build = typeof __COMMIT__ === "string" && __COMMIT__ ? ` (${__COMMIT__})` : "";
    return `Retrans ${version}${build} started on ${info ? `${info.os} ${info.arch}` : navigator.userAgent}`;
  });
  let last = useApp.getState();
  return useApp.subscribe((s) => {
    if (s.error && s.error !== last.error) log.warn(`Shown error: ${s.error}`);
    if (s.notice && s.notice !== last.notice) log.warn(`Shown notice: ${s.notice}`);
    if (s.detected !== last.detected && s.detected) {
      log.info(`Opened a project: ${formatOption(s.detected)}, ${s.session?.data.locales.length ?? "?"} languages`);
    }
    last = s;
  });
}
