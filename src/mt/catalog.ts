import catalog from "./catalog.json";

export type PromptTemplate = "translategemma" | "qwen3";

export interface CatalogModel {
  id: string;
  name: string;
  tier: "small" | "recommended" | "best" | "best-alt";
  repo: string;
  file: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  ramGb: string;
  languages: string;
  license: { name: string; url: string; requiresAcceptance: boolean };
  template: PromptTemplate;
  recommended?: boolean;
}

export const CATALOG: CatalogModel[] = catalog as CatalogModel[];

export function findModel(id: string): CatalogModel | undefined {
  return CATALOG.find((m) => m.id === id);
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  return `${(n / 1e6).toFixed(1)} MB`;
}
