/**
 * The log file people attach to bug reports (retrans.log, written by tauri-plugin-log in the OS
 * log folder). It gets warnings and errors, uncaught errors and a startup line. Translation text
 * and API keys are never logged; the home folder is written as "~".
 */
import { invoke } from "@tauri-apps/api/core";
import { appLogDir, homeDir } from "@tauri-apps/api/path";
import { error as logError, info as logInfo, warn as logWarn } from "@tauri-apps/plugin-log";

let home: string | null = null;

/** Paths under the home folder as "~/…", so a shared log doesn't carry the user name. */
export function redact(text: string, homePath = home): string {
  if (!homePath) return text;
  const h = homePath.replace(/[\\/]+$/, "");
  return h ? text.split(h).join("~").split(h.replace(/\\/g, "/")).join("~") : text;
}

/** One log line from console-style arguments; errors keep their stack. */
export function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack?.includes(a.message) ? a.stack : `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ""}`;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

const write = (level: "info" | "warn" | "error", message: string) => {
  const fn = level === "error" ? logError : level === "warn" ? logWarn : logInfo;
  void fn(redact(message)).catch(() => {}); // not running inside Tauri (tests, browser)
};

export const log = {
  info: (...args: unknown[]) => write("info", formatArgs(args)),
  warn: (...args: unknown[]) => write("warn", formatArgs(args)),
  error: (...args: unknown[]) => write("error", formatArgs(args)),
};

export interface SystemInfo {
  /** "macos", "windows", "linux". */
  os: string;
  /** "aarch64", "x86_64". */
  arch: string;
}

export async function systemInfo(): Promise<SystemInfo> {
  const [os, arch] = await invoke<[string, string]>("system_info");
  return { os, arch };
}

/** Where the log is: <log folder>/retrans.log. */
export async function logFilePath(): Promise<string> {
  const dir = (await appLogDir()).replace(/[\\/]+$/, "");
  return `${dir}${dir.includes("\\") ? "\\" : "/"}retrans.log`;
}

let started = false;

/**
 * Starts logging: console.warn/error also go to the file, as do uncaught errors and rejected
 * promises nobody handled. `startup` is written first (version, build, OS).
 */
export function initLogging(startup: () => Promise<string>): void {
  if (started) return;
  started = true;
  for (const level of ["warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      write(level, formatArgs(args));
    };
  }
  window.addEventListener("error", (e) => write("error", `Uncaught: ${formatArgs([e.error ?? e.message])}`));
  window.addEventListener("unhandledrejection", (e) => write("error", `Unhandled rejection: ${formatArgs([e.reason])}`));
  // Logging must never break the app: a missing path API (tests, browser) just skips the redaction.
  void Promise.resolve()
    .then(() => homeDir())
    .then((h) => (home = h), () => {})
    .then(startup)
    .then((line) => write("info", line), () => {});
}
