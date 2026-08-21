import { config } from '../config.js';

/** Returned to the browser when the Google Drive permission checkbox was left unticked. */
export const DOCS_SCOPE_DECLINED = 'docs_scope_declined';

export interface GoogleTokenParams {
  expires_in?: number;
  /** Space-delimited list of the scopes the user actually granted. */
  scope?: string;
}

/** Splits Google's space-delimited scope string, tolerating irregular whitespace. */
export function parseGrantedScopes(scope: string | null | undefined): string[] {
  return (scope ?? '').split(/\s+/).filter(Boolean);
}

/**
 * Whether the grant actually includes permission to write documents.
 *
 * Google presents Drive scopes as checkboxes on the consent screen, and
 * nothing in the OAuth request can pre-tick them — no parameter, and
 * verification does not change it. A user who clicks straight through grants
 * sign-in but not document access, and the token that comes back looks
 * perfectly valid. It just cannot write anything.
 *
 * Checking here turns a confusing "403 on every job, forever" into a clear
 * message at the moment the permission was skipped.
 *
 * Lives apart from the Passport wiring so it can be tested without dragging in
 * the database connection.
 */
export function grantedDocumentsAccess(params: GoogleTokenParams): boolean {
  return parseGrantedScopes(params?.scope).includes(config.google.docsAccessScope);
}

/**
 * The same question asked of a grant that was stored earlier, rather than one
 * arriving from the consent screen right now.
 *
 * This is what carries the August 2026 scope migration. Accounts that signed
 * in while the app requested `auth/documents` hold a grant that has no
 * `drive.file` in it, and the column recording what they granted did not exist
 * yet — so their stored scope list is NULL. Both cases answer false, which is
 * the honest answer: the Picker cannot mint a per-file grant from a token that
 * was never issued for per-file access, and a job pointed at a document that
 * grant cannot reach would fail at the first write.
 *
 * The caller turns a false into a re-consent, which is the whole of the
 * migration for an existing user: one trip through the Google screen, once.
 */
export function storedGrantCoversDocs(grantedScopes: string | null | undefined): boolean {
  return parseGrantedScopes(grantedScopes).includes(config.google.docsAccessScope);
}
