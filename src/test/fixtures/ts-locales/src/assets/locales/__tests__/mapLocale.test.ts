import { describe, expect, it } from 'vitest';
import { mapLocale } from '@/assets/locales/mapLocale';

describe('mapLocale', () => {
  it('picks the requested locale value for each key', () => {
    const table = {
      greeting: { th: 'สวัสดี', en: 'Hello' },
      farewell: { th: 'ลาก่อน', en: 'Goodbye' },
    };

    expect(mapLocale(table, 'th')).toEqual({
      greeting: 'สวัสดี',
      farewell: 'ลาก่อน',
    });
    expect(mapLocale(table, 'en')).toEqual({
      greeting: 'Hello',
      farewell: 'Goodbye',
    });
  });

  it('omits keys that have no value for the requested locale', () => {
    const table = {
      onlyEn: { en: 'English only' },
    } as Record<string, { th?: string; en?: string }>;

    expect(mapLocale(table, 'th')).toEqual({});
    expect(mapLocale(table, 'en')).toEqual({ onlyEn: 'English only' });
  });
});
