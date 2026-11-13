import { afterEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => [] as Array<[string, string]>);
vi.mock("@tauri-apps/plugin-log", () => ({
  info: vi.fn(async (m: string) => void logged.push(["info", m])),
  warn: vi.fn(async (m: string) => void logged.push(["warn", m])),
  error: vi.fn(async (m: string) => void logged.push(["error", m])),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ["macos", "aarch64"]) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.5.1") }));
vi.mock("@tauri-apps/api/path", () => ({
  appLogDir: vi.fn(async () => "/Users/olaf/Library/Logs/com.retrans.app/"),
  homeDir: vi.fn(async () => "/Users/olaf"),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}), revealItemInDir: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {}, save: async () => {} })),
}));

import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { DetectResult } from "../formats/adapter";
import { formatArgs, logFilePath, redact } from "../platform/log";
import { bugReportUrl, FEATURE_REQUEST_URL, formatOption, osOption, reportBug, requestFeature, startLogging } from "./bug-report";
import { useApp } from "./store";

afterEach(() => {
  logged.length = 0;
});

describe("log helpers", () => {
  it("writes the home folder as ~", () => {
    expect(redact("Save failed: /Users/olaf/work/app/en.json", "/Users/olaf")).toBe("Save failed: ~/work/app/en.json");
    expect(redact("C:\\Users\\olaf\\x and C:/Users/olaf/y", "C:\\Users\\olaf")).toBe("~\\x and ~/y");
    expect(redact("nothing here", null)).toBe("nothing here");
  });

  it("formats errors with their stack and objects as JSON", () => {
    const e = new Error("boom");
    expect(formatArgs(["failed", e])).toContain("Error: boom");
    expect(formatArgs([{ a: 1 }])).toBe('{"a":1}');
  });

  it("the log file is retrans.log in the app's log folder", async () => {
    expect(await logFilePath()).toBe("/Users/olaf/Library/Logs/com.retrans.app/retrans.log");
  });
});

describe("bug report", () => {
  it("maps the system to the bug form's options", () => {
    expect(osOption({ os: "macos", arch: "aarch64" })).toBe("macOS (Apple Silicon)");
    expect(osOption({ os: "macos", arch: "x86_64" })).toBe("macOS (Intel)");
    expect(osOption({ os: "windows", arch: "x86_64" })).toBe("Windows");
    expect(osOption({ os: "linux", arch: "x86_64" })).toBe("Linux");
    expect(osOption(null)).toBe("Other");
  });

  it("maps the open project to the bug form's format", () => {
    const d = (x: Partial<DetectResult>) => ({ format: "next-i18next", ...x }) as DetectResult;
    expect(formatOption(null)).toBe("Not related to a project");
    expect(formatOption(d({}))).toBe("next-i18next (JSON)");
    expect(formatOption(d({ format: "paraglide" }))).toBe("Paraglide / inlang");
    expect(formatOption(d({ workspace: { source: {} } as DetectResult["workspace"] }))).toBe("TypeScript workspace");
    expect(formatOption(d({ workspace: { figma: {} } as DetectResult["workspace"] }))).toBe("Figma Variables");
    expect(formatOption(d({ workspace: {} as DetectResult["workspace"] }))).toBe("New (format-free) project");
  });

  it("fills in the GitHub bug form", () => {
    const url = new URL(bugReportUrl({ version: "0.5.1", os: "Linux", format: "Paraglide / inlang", logPath: "~/logs/retrans.log" }));
    expect(url.origin + url.pathname).toBe("https://github.com/oxth/retrans/issues/new");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ template: "bug_report.yml", version: "0.5.1", os: "Linux", "project-format": "Paraglide / inlang" });
    // GitHub reads ?format= as the response type: any other value is HTTP 406.
    expect(url.searchParams.has("format")).toBe(false);
    expect(url.searchParams.get("logs")).toContain("~/logs/retrans.log");
  });

  it("Report a Bug opens the form and shows the log file", async () => {
    await reportBug();
    const url = new URL(vi.mocked(openUrl).mock.lastCall![0] as string);
    expect(url.searchParams.get("os")).toBe("macOS (Apple Silicon)");
    expect(url.searchParams.get("version")).toMatch(/^0\.5\.1/);
    expect(revealItemInDir).toHaveBeenCalledWith("/Users/olaf/Library/Logs/com.retrans.app/retrans.log");
  });
});

describe("Request a Feature", () => {
  it("opens the GitHub feature request form", async () => {
    await requestFeature();
    expect(openUrl).toHaveBeenLastCalledWith(FEATURE_REQUEST_URL);
    expect(FEATURE_REQUEST_URL).toBe("https://github.com/oxth/retrans/issues/new?template=feature_request.yml");
  });
});

describe("Show Log File (⌘⇧L)", () => {
  it("works even with a dialog open", async () => {
    const { MENU_ACTIONS } = await import("./menu-actions");
    const dialog = document.body.appendChild(Object.assign(document.createElement("div"), { role: "dialog" }));
    dialog.setAttribute("role", "dialog");
    vi.mocked(revealItemInDir).mockClear();
    MENU_ACTIONS["show-log"]();
    await vi.waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("/Users/olaf/Library/Logs/com.retrans.app/retrans.log"));
    dialog.remove();
  });
});

describe("startLogging", () => {
  it("logs a startup line, errors the app shows, and console warnings, with ~ for home", async () => {
    const stop = startLogging();
    await vi.waitFor(() => expect(logged.some(([l, m]) => l === "info" && m.startsWith("Retrans 0.5.1"))).toBe(true));
    expect(logged.find(([, m]) => m.startsWith("Retrans"))![1]).toContain("macos aarch64");
    useApp.setState({ error: "Save failed: /Users/olaf/app/en.json" });
    console.warn("journal write failed", new Error("disk full"));
    await vi.waitFor(() => expect(logged).toContainEqual(["warn", "Shown error: Save failed: ~/app/en.json"]));
    expect(logged.some(([l, m]) => l === "warn" && m.includes("journal write failed") && m.includes("disk full"))).toBe(true);
    stop();
    useApp.setState({ error: null });
  });
});
