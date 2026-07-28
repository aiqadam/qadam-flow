// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { setFavicon } from '@/components/providers/theme-provider';

const seedExistingIcons = () => {
  document.head.innerHTML = `
    <link rel="icon" type="image/svg+xml" href="/logo.svg">
    <link rel="icon" type="image/png" sizes="192x192" href="/logo-192.png">
    <link rel="apple-touch-icon" sizes="180x180" href="/logo-180.png">
  `;
};

describe('setFavicon', () => {
  beforeEach(() => {
    seedExistingIcons();
  });

  it('leaves every existing icon link alone when the branding favicon URL is empty', () => {
    setFavicon('');

    expect(document.querySelectorAll("link[rel='icon']")).toHaveLength(2);
    expect(
      document.querySelectorAll("link[rel='apple-touch-icon']"),
    ).toHaveLength(1);
  });

  it('replaces rel="icon" links but preserves apple-touch-icon when a real favicon URL is configured', () => {
    setFavicon('/custom-favicon.png');

    const iconLinks =
      document.querySelectorAll<HTMLLinkElement>("link[rel='icon']");
    expect(iconLinks).toHaveLength(1);
    expect(iconLinks[0].href).toContain('/custom-favicon.png');

    expect(
      document.querySelectorAll("link[rel='apple-touch-icon']"),
    ).toHaveLength(1);
  });
});
