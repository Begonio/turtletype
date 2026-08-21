import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { grantedDocumentsAccess, parseGrantedScopes, storedGrantCoversDocs } from './scopes.js';

const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
/** The scope the app requested until Google's review refused it in August 2026. */
const LEGACY_DOCUMENTS = 'https://www.googleapis.com/auth/documents';

/**
 * Google renders Drive scopes as checkboxes that cannot be pre-ticked, so a
 * user can complete sign-in having granted only their identity. The token that
 * comes back looks entirely valid and simply cannot write to a document, which
 * used to surface much later as a 403 on every job.
 */
describe('grantedDocumentsAccess', () => {
  it('accepts a grant that includes the drive.file scope', () => {
    assert.equal(
      grantedDocumentsAccess({ scope: `openid email profile ${DRIVE_FILE}` }),
      true,
    );
    assert.equal(grantedDocumentsAccess({ scope: DRIVE_FILE }), true);
  });

  it('rejects a sign-in where the checkbox was left unticked', () => {
    // Exactly what Google returns when someone clicks through the consent
    // screen without ticking the Drive box.
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
    // drive.appdata is a different permission and cannot reach user documents.
    assert.equal(
      grantedDocumentsAccess({ scope: 'https://www.googleapis.com/auth/drive.appdata' }),
      false,
    );
    // Neither does the readonly variant, which cannot write.
    assert.equal(
      grantedDocumentsAccess({ scope: 'https://www.googleapis.com/auth/drive.readonly' }),
      false,
    );
  });

  it('does not accept the old documents scope as a substitute', () => {
    // It is genuinely wider, and would work for the Docs API — but it cannot
    // drive the Picker, which is now the only way to reach an existing
    // document. Accepting it here would let such an account through to a
    // picker that fails with nothing useful to say.
    assert.equal(grantedDocumentsAccess({ scope: `openid ${LEGACY_DOCUMENTS}` }), false);
  });

  it('tolerates the irregular whitespace Google sometimes returns', () => {
    assert.equal(grantedDocumentsAccess({ scope: `openid  ${DRIVE_FILE}  profile` }), true);
  });
});

/**
 * The stored-grant side of the same question, which is what carries existing
 * accounts across the scope migration.
 */
describe('storedGrantCoversDocs', () => {
  it('accepts a stored grant carrying drive.file', () => {
    assert.equal(storedGrantCoversDocs(`openid email profile ${DRIVE_FILE}`), true);
  });

  it('rejects a row that predates the column', () => {
    // Every such account signed in under the old scope, so NULL is not
    // "unknown, probably fine" — it is a grant that certainly lacks drive.file.
    assert.equal(storedGrantCoversDocs(null), false);
    assert.equal(storedGrantCoversDocs(undefined), false);
  });

  it('rejects a stored grant from before the migration', () => {
    assert.equal(storedGrantCoversDocs(`openid email profile ${LEGACY_DOCUMENTS}`), false);
  });
});

describe('parseGrantedScopes', () => {
  it('splits on any run of whitespace and drops the empties', () => {
    assert.deepEqual(parseGrantedScopes(' openid   email\tprofile '), [
      'openid',
      'email',
      'profile',
    ]);
    assert.deepEqual(parseGrantedScopes(''), []);
    assert.deepEqual(parseGrantedScopes(null), []);
  });
});
