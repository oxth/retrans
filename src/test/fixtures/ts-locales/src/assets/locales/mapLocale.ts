/**
 * Derives one language's flat translation map from a table of
 * `{ th, en }` pairs, keeping each translation key written once in the
 * source instead of duplicated across parallel `xxxTH`/`xxxEN` objects.
 */
export function mapLocale<TKey extends string>(
  table: Record<TKey, { th?: string; en?: string }>,
  locale: 'th' | 'en',
): Partial<Record<TKey, string>> {
  return Object.fromEntries(
    Object.entries(table)
      .map(([key, value]) => [
        key,
        (value as { th?: string; en?: string })[locale],
      ])
      .filter(([, value]) => value !== undefined),
  ) as Partial<Record<TKey, string>>;
}
