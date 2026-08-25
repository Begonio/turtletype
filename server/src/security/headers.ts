/**
 * Response security headers.
 *
 * Kept apart from `index.ts` and free of any I/O so the reasoning below can be
 * tested rather than trusted — the same discipline as `cookiePolicy.ts` and
 * `launchChecks.ts`. One of these settings is load-bearing for a feature that
 * lives entirely in the browser, and it fails in a way that points nowhere
 * near a header.
 */

import type { HelmetOptions } from 'helmet';

export const helmetOptions: Readonly<HelmetOptions> = {
  // The SPA is served from this same process in production; the default CSP
  // would block its own bundle.
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  /**
   * Google's file picker works by opening a popup that reports back to the
   * page that opened it. Helmet's default of `same-origin` cuts that link: the
   * popup can no longer reach `window.opener`, so the token it obtained is
   * never delivered and the window simply closes. From the app that is
   * indistinguishable from the user closing it themselves — which is exactly
   * how it was misread the first time.
   *
   * `same-origin-allow-popups` keeps the protection that matters — other
   * origins still cannot get a handle on this page — while letting popups this
   * page opened talk back to it. It is the setting Google documents for
   * Identity Services.
   *
   * This only differs in production. In development Vite serves the page and
   * these headers never apply, so a picker that works locally and dies on the
   * deploy is the signature of this line being wrong.
   */
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
};
