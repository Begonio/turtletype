import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import helmet from 'helmet';
import { helmetOptions } from './headers.js';

/** Runs the configured helmet middleware and collects the headers it sets. */
function headersFrom(options: Parameters<typeof helmet>[0]): Record<string, string> {
  const collected: Record<string, string> = {};
  const res = {
    setHeader(name: string, value: string) {
      collected[name] = value;
    },
    getHeader() {
      return undefined;
    },
    removeHeader() {},
  };
  helmet(options)({ headers: {} } as never, res as never, () => {});
  return collected;
}

describe('helmetOptions', () => {
  /**
   * The regression this exists for. Helmet defaults COOP to `same-origin`,
   * which stops a popup reaching `window.opener` — so Google's token popup
   * closes without ever delivering the token, and the app sees a window the
   * user appears to have closed. It only breaks in production, because in
   * development Vite serves the page and none of these headers apply.
   */
  it('allows popups this page opened to report back', () => {
    const headers = headersFrom(helmetOptions);
    assert.equal(headers['Cross-Origin-Opener-Policy'], 'same-origin-allow-popups');
  });

  it('is not simply the default, which would break the picker', () => {
    const defaults = headersFrom(undefined);
    assert.equal(
      defaults['Cross-Origin-Opener-Policy'],
      'same-origin',
      'helmet changed its default; re-check whether the override is still needed',
    );
  });

  it('leaves the CSP off, since the SPA is served from this process', () => {
    const headers = headersFrom(helmetOptions);
    assert.equal(headers['Content-Security-Policy'], undefined);
  });

  it('still sets the ordinary hardening headers', () => {
    const headers = headersFrom(helmetOptions);
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.ok(headers['Strict-Transport-Security']);
  });
});
