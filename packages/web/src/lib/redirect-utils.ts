import { isNil, tryCatchSync } from '@aiqadam/shared';

export const redirectUtils = {
  DEFAULT_REDIRECT_PATH: '/flows',
  toSameOriginPath,
};

/**
 * Post-sign-in navigation targets come from the URL (`?from=`, OAuth `state`), so they are
 * only honoured when they resolve to a path on the app's own origin. Anything else — a
 * non-string, an absolute or protocol-relative URL, a non-http scheme — yields the default
 * route, and the result is always a root-relative path no later consumer can read as a host.
 */
function toSameOriginPath(target: unknown): string {
  if (typeof target !== 'string' || target.length === 0) {
    return redirectUtils.DEFAULT_REDIRECT_PATH;
  }
  const origin = window.location.origin;
  const { data: url } = tryCatchSync(() => new URL(target, origin));
  if (isNil(url) || url.origin !== origin) {
    return redirectUtils.DEFAULT_REDIRECT_PATH;
  }
  // Dot-segment normalisation (`/.//x`) or a percent-encoded slash (`/%2F/x`) can leave a
  // same-origin pathname that reads as protocol-relative once something decodes it or
  // feeds it to `href`; no route of this app starts that way.
  const { data: decodedPathname } = tryCatchSync(() =>
    decodeURIComponent(url.pathname),
  );
  if (isNil(decodedPathname) || /^[/\\]{2}/.test(decodedPathname)) {
    return redirectUtils.DEFAULT_REDIRECT_PATH;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
