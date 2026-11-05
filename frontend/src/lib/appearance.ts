import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type FontSize = 'small' | 'medium' | 'large';

export const THEMES: Theme[] = ['light', 'dark', 'system'];
export const FONT_SIZES: FontSize[] = ['small', 'medium', 'large'];
const THEME_KEY = 'clearport.theme';
const SIZE_KEY = 'clearport.fontSize';

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try { const v = localStorage.getItem(key); return allowed.includes(v as T) ? (v as T) : fallback; } catch { return fallback; }
}
function write(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* private mode: the choice lasts until the tab closes */ } }

const prefersDark = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;

let theme: Theme = read(THEME_KEY, THEMES, 'light');
let fontSize: FontSize = read(SIZE_KEY, FONT_SIZES, 'medium');
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Puts the saved choices on the <html> element (dark class, font size). Safe to call any time. */
export function applyAppearance() {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark' || (theme === 'system' && prefersDark()));
  root.dataset.fontSize = fontSize;
}

export function setTheme(t: Theme) { theme = t; write(THEME_KEY, t); applyAppearance(); emit(); }
export function setFontSize(s: FontSize) { fontSize = s; write(SIZE_KEY, s); applyAppearance(); emit(); }

// "System" follows the device while the app is open.
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (theme === 'system') applyAppearance(); });
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useTheme = () => useSyncExternalStore(subscribe, () => theme);
export const useFontSize = () => useSyncExternalStore(subscribe, () => fontSize);
/** The theme as it is actually shown right now (system resolved to light or dark). */
export const isDark = () => document.documentElement.classList.contains('dark');
