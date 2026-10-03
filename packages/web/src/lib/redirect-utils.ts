import { isNil, tryCatchSync } from '@aiqadam/shared';

export const redirectUtils = {
  DEFAULT_REDIRECT_PATH: '/flows',
  toSameOriginPath,
};

/**
 * Post-sign-in navigation targets come from the URL (`?from=`, OAuth `state`), so they are
 * only honoured when they resolve to the app's own origin and scheme. The result is always
 * a root-relative path that starts with exactly one `/`, decoded or not; anything else
 * yields the default route.
 */
function toSameOriginPath(target: unknown): string {
  if (typeof target !== 'string' || target.length === 0) {
    return redirectUtils.DEFAULT_REDIRECT_PATH;
  }
  const { origin, protocol } = window.location;
  const { data: url } = tryCatchSync(() => new URL(target, origin));
  if (isNil(url) || url.origin !== origin || url.protocol !== protocol) {
    return redirectUtils.DEFAULT_REDIRECT_PATH;
  }
  // Consumers may decode the path or hand it to `href`, so the root-relative shape has to
  // hold for the decoded form too.
  const { data: decodedPathname } = tryCatchSync(() =>
    decodeURIComponent(url.pathname),
  );
  if (isNil(decodedPathname) || !/^\/(?![/\\])/.test(decodedPathname)) {
    return redirectUtils.DEFAULT_REDIRECT_PATH;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
