import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { grantedDocumentsAccess } from './scopes.js';

const DOCS = 'https://www.googleapis.com/auth/documents';

/**
 * Google renders sensitive scopes as checkboxes that cannot be pre-ticked, so
 * a user can complete sign-in having granted only their identity. The token
 * that comes back looks entirely valid and simply cannot write to a document,
 * which used to surface much later as a 403 on every job.
 */
describe('grantedDocumentsAccess', () => {
  it('accepts a grant that includes the documents scope', () => {
    assert.equal(
      grantedDocumentsAccess({ scope: `openid email profile ${DOCS}` }),
      true,
    );
    assert.equal(grantedDocumentsAccess({ scope: DOCS }), true);
  });

  it('rejects a sign-in where the checkbox was left unticked', () => {
    // Exactly what Google returns when someone clicks through the consent
    // screen without ticking the Docs box.
    assert.equal(
      grantedDocumentsAccess({
        scope:
          'openid https://www.googleapis.com/auth/userinfo.email ' +
          'https://www.googleapis.com/auth/userinfo.profile',
      }),
      false,
    );
  });

  it('rejects a missing or empty scope list rather than assuming the best', () => {
    assert.equal(grantedDocumentsAccess({}), false);
    assert.equal(grantedDocumentsAccess({ scope: '' }), false);
    assert.equal(grantedDocumentsAccess({ scope: '   ' }), false);
  });

  it('does not match a scope that merely looks similar', () => {
    // readonly is a different permission and cannot write.
    assert.equal(
      grantedDocumentsAccess({ scope: 'https://www.googleapis.com/auth/documents.readonly' }),
      false,
    );
  });

  it('tolerates the irregular whitespace Google sometimes returns', () => {
    assert.equal(grantedDocumentsAccess({ scope: `openid  ${DOCS}  profile` }), true);
  });
});
