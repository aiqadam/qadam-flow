function resolveTheme({
  theme,
  systemTheme,
  forceLightMode,
}: {
  theme: Theme;
  systemTheme: ResolvedTheme;
  forceLightMode: boolean;
}): ResolvedTheme {
  if (forceLightMode) {
    return 'light';
  }
  return theme === 'system' ? systemTheme : theme;
}

export const themeUtils = { resolveTheme };

export type ResolvedTheme = 'light' | 'dark';
export type Theme = ResolvedTheme | 'system';
