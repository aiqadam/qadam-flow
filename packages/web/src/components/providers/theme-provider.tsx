import { isNil } from '@aiqadam/shared';
import { createContext, useContext, useEffect, useState } from 'react';
import * as RippleHook from 'use-ripple-hook';

import { flagsHooks } from '@/hooks/flags-hooks';
import { colorsUtils } from '@/lib/color-utils';
import { themeUtils, type ResolvedTheme, type Theme } from '@/lib/theme-utils';

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
};

type ThemeProviderState = {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  forceLightMode: boolean;
  setForceLightMode: (value: boolean) => void;
};

const initialState: ThemeProviderState = {
  theme: 'system',
  resolvedTheme: 'light',
  setTheme: () => null,
  forceLightMode: false,
  setForceLightMode: () => null,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

export const setFavicon = (url: string) => {
  // An empty/unset URL means the platform hasn't configured a custom favicon —
  // leave the icons index.html already ships (including apple-touch-icon) alone
  // instead of replacing them with an empty href.
  if (isNil(url) || url === '') {
    return;
  }
  // Only rel="icon" links are ours to replace; apple-touch-icon is a distinct
  // rel used for iOS home-screen icons and must survive this swap.
  document.querySelectorAll("link[rel='icon']").forEach((el) => el.remove());
  const link = document.createElement('link');
  link.rel = 'icon';
  link.href = url;
  document.head.appendChild(link);
};

// `system` is the default and it resolved to `light` unconditionally, so the OS preference was
// read by nothing — a user whose machine is in dark mode still got a light app and had to pick
// dark by hand. Honouring the preference is the conventional behaviour and what the setting's own
// name promises (#178, item 3). This changes only what `system` means; the default is still
// `system`, so anyone who has explicitly chosen light or dark is unaffected.
function resolveSystemTheme(): ResolvedTheme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = 'ap-ui-theme',
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(storageKey) as Theme) || defaultTheme,
  );
  const [forceLightMode, setForceLightMode] = useState(false);
  // Re-read on every OS change, not just on mount. Without this the setting is only honoured
  // until the user flips their system theme with the app open, which is exactly when they would
  // expect a setting called `system` to follow — verified by driving prefers-color-scheme on a
  // running page and watching the class not move.
  const [systemTheme, setSystemTheme] =
    useState<ResolvedTheme>(resolveSystemTheme);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) {
      return;
    }
    const onChange = (event: MediaQueryListEvent) =>
      setSystemTheme(event.matches ? 'dark' : 'light');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  const branding = flagsHooks.useWebsiteBranding();
  const resolvedTheme = themeUtils.resolveTheme({
    theme,
    systemTheme,
    forceLightMode,
  });
  useEffect(() => {
    if (!branding) {
      console.warn('Website brand is not defined');
      return;
    }
    const root = window.document.documentElement;

    root.classList.remove('light', 'dark');
    document.title = branding.websiteName;
    document.documentElement.style.setProperty(
      '--primary',
      colorsUtils.hexToHslString(branding.colors.primary.default),
    );

    setFavicon(branding.logos.favIconUrl);
    switch (resolvedTheme) {
      case 'light': {
        document.documentElement.style.setProperty(
          '--primary-100',
          colorsUtils.hexToHslString(branding.colors.primary.light),
        );
        document.documentElement.style.setProperty(
          '--primary-300',
          colorsUtils.hexToHslString(branding.colors.primary.dark),
        );
        break;
      }
      case 'dark': {
        document.documentElement.style.setProperty(
          '--primary-100',
          colorsUtils.hexToHslString(branding.colors.primary.dark),
        );
        document.documentElement.style.setProperty(
          '--primary-300',
          colorsUtils.hexToHslString(branding.colors.primary.light),
        );
        break;
      }
      default:
        break;
    }

    root.classList.add(resolvedTheme);
  }, [resolvedTheme, branding]);

  const value = {
    theme,
    resolvedTheme,
    setTheme: (theme: Theme) => {
      localStorage.setItem(storageKey, theme);
      setTheme(theme);
    },
    forceLightMode,
    setForceLightMode,
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);

  if (context === undefined)
    throw new Error('useTheme must be used within a ThemeProvider');

  return context;
};

export const useApRipple = () => {
  const { resolvedTheme } = useTheme();
  return RippleHook.default({
    color:
      resolvedTheme === 'dark'
        ? 'rgba(233, 233, 233, 0.2)'
        : 'rgba(155, 155, 155, 0.2)',
    cancelAutomatically: true,
  });
};
