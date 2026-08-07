import { describe, expect, it } from 'vitest';

import { themeUtils } from '@/lib/theme-utils';

describe('themeUtils.resolveTheme', () => {
  it('resolves an explicit light theme to light', () => {
    expect(
      themeUtils.resolveTheme({
        theme: 'light',
        systemTheme: 'dark',
        forceLightMode: false,
      }),
    ).toBe('light');
  });

  it('resolves an explicit dark theme to dark', () => {
    expect(
      themeUtils.resolveTheme({
        theme: 'dark',
        systemTheme: 'light',
        forceLightMode: false,
      }),
    ).toBe('dark');
  });

  it('resolves system to the current system theme when system is dark', () => {
    expect(
      themeUtils.resolveTheme({
        theme: 'system',
        systemTheme: 'dark',
        forceLightMode: false,
      }),
    ).toBe('dark');
  });

  it('resolves system to the current system theme when system is light', () => {
    expect(
      themeUtils.resolveTheme({
        theme: 'system',
        systemTheme: 'light',
        forceLightMode: false,
      }),
    ).toBe('light');
  });

  it('forces light regardless of an explicit dark theme when forceLightMode is set', () => {
    expect(
      themeUtils.resolveTheme({
        theme: 'dark',
        systemTheme: 'dark',
        forceLightMode: true,
      }),
    ).toBe('light');
  });

  it('forces light regardless of a dark system theme when forceLightMode is set', () => {
    expect(
      themeUtils.resolveTheme({
        theme: 'system',
        systemTheme: 'dark',
        forceLightMode: true,
      }),
    ).toBe('light');
  });
});
