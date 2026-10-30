export const COMMON_LOCALES: string[] = [
  "en", "en-US", "en-GB", "en-AU", "en-CA", "th", "ja", "zh-CN", "zh-TW", "zh-HK", "ko", "vi", "id", "ms", "fil",
  "fr", "fr-CA", "de", "de-CH", "es", "es-MX", "es-419", "pt", "pt-BR", "it", "ru", "uk", "pl", "cs", "sk", "hu", "ro",
  "bg", "el", "tr", "ar", "he", "fa", "hi", "bn", "ta", "te", "mr", "gu", "kn", "ml", "pa", "ur", "ne", "si", "my",
  "km", "lo", "mn", "kk", "uz", "az", "ka", "hy", "nl", "nl-BE", "sv", "da", "nb", "no", "fi", "is", "et", "lv", "lt",
  "sl", "hr", "sr", "bs", "mk", "sq", "mt", "ga", "cy", "gd", "eu", "ca", "gl", "af", "sw", "zu", "xh", "am", "ha",
  "yo", "ig", "so", "mg", "ps", "ku", "tg", "ky", "tk", "lb", "be", "la", "eo", "jv", "su", "ceb",
];

export function localeLabel(code: string): string {
  try {
    const names = new Intl.DisplayNames([navigator.language || "en"], { type: "language" });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}
