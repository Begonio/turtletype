import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveCookiePolicy } from './cookiePolicy.js';

describe('resolveCookiePolicy', () => {
  it('uses Lax + Secure for the single-origin production deploy', () => {
    // type.turtlegames.org serves both the SPA and the API.
    assert.deepEqual(
      resolveCookiePolicy(
        'https://type.turtlegames.org',
        'https://type.turtlegames.org/auth/google/callback',
        true,
      ),
      { sameSite: 'lax', secure: true },
    );
  });

  it('treats a different subdomain as cross-site', () => {
    // A split deploy (app on type., API on api.) needs None + Secure, or the
    // browser drops the cookie on the way back from Google.
    assert.deepEqual(
      resolveCookiePolicy(
        'https://type.turtlegames.org',
        'https://api.turtlegames.org/auth/google/callback',
        true,
      ),
      { sameSite: 'none', secure: true },
    );
  });

  it('never marks the cookie Secure in local development', () => {
    assert.deepEqual(
      resolveCookiePolicy('http://localhost:5173', 'http://localhost:8080/auth/google/callback', false),
      { sameSite: 'lax', secure: false },
    );
  });

  it('ignores a trailing slash difference', () => {
    assert.deepEqual(
      resolveCookiePolicy(
        'https://type.turtlegames.org/',
        'https://type.turtlegames.org/auth/google/callback',
        true,
      ),
      { sameSite: 'lax', secure: true },
    );
  });

  it('falls back to same-site rather than throwing on a malformed URL', () => {
    assert.deepEqual(resolveCookiePolicy('not-a-url', 'also-not-a-url', true), {
      sameSite: 'lax',
      secure: true,
    });
  });
});
