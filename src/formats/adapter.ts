import type { Fs } from "../platform/fs";
import type { JsonStyle } from "../core/json-text";
import type { Format, MessageValue, ProjectData } from "../core/model";

export interface DetectResult {
  format: Format;
  baseLocale: string | null; // null -> the UI asks the user to pick
  locales: string[];
  namespaces: string[];
  localesPath: string; // relative to root, e.g. "public/locales"; "" for Paraglide
  keyCount: number;
}

export interface ProjectOptions {
  baseLocale: string;
  localesPath: string;
}

export interface LoadedFile {
  relPath: string;
  locale: string;
  ns: string;
  text: string;
  style: JsonStyle;
  readOnly: boolean; // failed to parse
  shape: "nested" | "flat";
  segIndex: Map<string, string[]>; // dotted key -> actual JSON path in this file
}

export interface FileError {
  relPath: string;
  message: string;
}

export interface LoadResult {
  data: ProjectData;
  files: LoadedFile[];
  errors: FileError[];
}

export interface FormatAdapter {
  format: Format;
  detect(fs: Fs, root: string): Promise<DetectResult | null>;
  load(fs: Fs, root: string, opts: ProjectOptions): Promise<LoadResult>;
  filePath(opts: ProjectOptions, locale: string, ns: string): string; // relative
  jsonPath(file: LoadedFile, key: string): string[];
  encode(v: MessageValue): unknown;
  newFileStyle(files: LoadedFile[]): {
    style: JsonStyle;
    shape: "nested" | "flat";
    prefix?: Record<string, unknown>;
  };
  onLocalesChanged(fs: Fs, root: string, locales: string[]): Promise<{ configSnippet?: string }>;
}
