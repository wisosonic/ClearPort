/** UI convenience only. The backend enforces every permission; hiding a button is not security. */
type Granted = ReadonlySet<string> | readonly string[];
const toSet = (g: Granted): ReadonlySet<string> => (g instanceof Set ? g : new Set(g as readonly string[]));

/** True when ALL listed permissions are granted. */
export const can = (granted: Granted, ...required: string[]): boolean => {
  const s = toSet(granted);
  return required.every((p) => s.has(p));
};

/** True when ANY listed permission is granted. */
export const canAny = (granted: Granted, ...options: string[]): boolean => {
  const s = toSet(granted);
  return options.some((p) => s.has(p));
};
