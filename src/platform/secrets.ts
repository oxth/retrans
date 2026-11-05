import { invoke } from "@tauri-apps/api/core";

/**
 * API keys live in the OS credential store. The app can set, check and remove a key, but never
 * read it back: only the Rust side reads keys, to call a provider.
 */
export const setSecret = (account: string, value: string) => invoke<void>("secret_set", { account, value });
export const hasSecret = (account: string) => invoke<boolean>("secret_has", { account });
export const deleteSecret = (account: string) => invoke<void>("secret_delete", { account });
