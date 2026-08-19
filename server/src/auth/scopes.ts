import { config } from '../config.js';

/** Returned to the browser when the Docs permission checkbox was left unticked. */
export const DOCS_SCOPE_DECLINED = 'docs_scope_declined';

export interface GoogleTokenParams {
  expires_in?: number;
  /** Space-delimited list of the scopes the user actually granted. */
  scope?: string;
}

/**
 * Whether the grant actually includes permission to write documents.
 *
 * Google presents sensitive scopes as checkboxes on the consent screen, and
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
  const granted = (params?.scope ?? '').split(/\s+/).filter(Boolean);
  return granted.includes(config.google.documentsScope);
}
