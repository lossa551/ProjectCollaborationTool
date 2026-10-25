// Small per-device conveniences, like remembering your display name.
export function remember(key: string, value: string) {
  try {
    localStorage.setItem(`pct.${key}`, value);
  } catch {
    // Storage can be unavailable; nothing depends on it.
  }
}

export function recall(key: string): string {
  try {
    return localStorage.getItem(`pct.${key}`) ?? '';
  } catch {
    return '';
  }
}
