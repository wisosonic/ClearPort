import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import arCommon from './ar/common.json';
import enCommon from './en/common.json';
import type { Locale } from '@/lib/format';

const KEY = 'clearport.locale';
export const LOCALES: Locale[] = ['en', 'ar'];
export const dirOf = (l: Locale) => (l === 'ar' ? 'rtl' : 'ltr');

function initial(): Locale {
  try { const s = localStorage.getItem(KEY); if (s === 'en' || s === 'ar') return s; } catch { /* ignore */ }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

/** Applies language and direction to the document (<html lang dir>). Direction follows the language, never CSS hacks. */
export function applyLocale(l: Locale) {
  document.documentElement.lang = l;
  document.documentElement.dir = dirOf(l);
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: enCommon }, ar: { translation: arCommon } },
  lng: initial(), fallbackLng: 'en', interpolation: { escapeValue: false }, returnNull: false,
});
if (typeof document !== 'undefined') applyLocale(i18n.language as Locale);

export function setLocale(l: Locale) {
  try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
  void i18n.changeLanguage(l);
  applyLocale(l);
}

export default i18n;
