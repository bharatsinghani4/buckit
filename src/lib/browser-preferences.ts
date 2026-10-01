export function getPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setPreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* The current page still uses the selected preference. */
  }
}
