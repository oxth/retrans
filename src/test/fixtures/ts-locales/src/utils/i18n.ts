import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { buttonEN, buttonTH } from '@/assets/locales/button';
import { commonTH, commonEN } from '@/assets/locales/common';
import {
  changePasswordTH,
  changePasswordEN,
} from '@/assets/locales/change-password';
import { maguroEN, maguroTH } from '@/assets/locales/dashboardMaguro';

// Define translations
const resources = {
  en: {
    translation: {
      ...buttonEN,
      ...commonEN,
      ...changePasswordEN,
      ...maguroEN,
    },
  },
  th: {
    translation: {
      ...buttonTH,
      ...commonTH,
      ...changePasswordTH,
      ...maguroTH,
    },
  },
};

i18n.use(initReactI18next).init({
  resources,
  lng: 'th', // Default language
  fallbackLng: 'th', // Fallback language
  interpolation: {
    escapeValue: false, // React escapes by default
  },
});

export default i18n;
