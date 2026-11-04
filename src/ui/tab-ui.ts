import type { Page } from "./Sidebar";
import type { FilterState } from "./Toolbar";

/** What a tab remembers about its screen while another tab is shown. */
export interface TabUi {
  page: Page;
  filter: FilterState;
  /** Languages hidden in the translations view. */
  hidden: string[];
}

export const INITIAL_FILTER: FilterState = { search: "", ns: "all", missing: false, needsReview: false, machine: false, status: "all" };

export const defaultTabUi = (): TabUi => ({ page: "translations", filter: { ...INITIAL_FILTER }, hidden: [] });
