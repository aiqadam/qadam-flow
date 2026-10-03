// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { redirectUtils } from '@/lib/redirect-utils';

const DEFAULT = redirectUtils.DEFAULT_REDIRECT_PATH;

describe('redirectUtils.toSameOriginPath', () => {
  it('keeps same-origin relative paths', () => {
    expect(redirectUtils.toSameOriginPath('/runs')).toBe('/runs');
    expect(
      redirectUtils.toSameOriginPath('/projects/abc/flows/xyz?tab=runs#step'),
    ).toBe('/projects/abc/flows/xyz?tab=runs#step');
    expect(redirectUtils.toSameOriginPath('/templates/1?a=1&b=2')).toBe(
      '/templates/1?a=1&b=2',
    );
  });

  it('reduces a same-origin absolute URL to its path', () => {
    expect(
      redirectUtils.toSameOriginPath(`${window.location.origin}/runs?x=1`),
    ).toBe('/runs?x=1');
  });

  it('falls back for a missing or non-string target', () => {
    for (const target of [null, undefined, '', 42, {}, ['/runs'], true]) {
      expect(redirectUtils.toSameOriginPath(target)).toBe(DEFAULT);
    }
  });

  it.each([
    'https://example.com/flows',
    'http://example.com',
    '//example.com',
    '//example.com/flows',
    '/\\example.com',
    '\\\\example.com',
    '\\/example.com',
    'https:/example.com',
    'javascript:void(0)',
    'data:text/html,x',
    'mailto:a@example.com',
    ' //example.com',
    '\t//example.com',
    '\n/\\example.com',
    '\u0000//example.com',
    '/\t/example.com',
    '/.//example.com',
    '/flows/../..//example.com',
    '/%2F%2Fexample.com',
    '/%2f/example.com',
    '/%5Cexample.com',
    '%2F%2Fexample.com',
    '/%E0%A4%A',
  ])('falls back for anything that would leave the origin: %j', (target) => {
    expect(redirectUtils.toSameOriginPath(target)).toBe(DEFAULT);
  });

  it('always returns a single-slash root-relative path', () => {
    const results = ['flows', 'http:example.com', '/runs', '//example.com'].map(
      (target) => redirectUtils.toSameOriginPath(target),
    );
    for (const result of results) {
      expect(result.startsWith('/')).toBe(true);
      expect(/^[/\\]{2}/.test(result)).toBe(false);
    }
  });
});
