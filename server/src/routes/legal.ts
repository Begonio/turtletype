import { Router } from 'express';
import { config } from '../config.js';

/**
 * Who operates this service, for the privacy policy and terms to quote.
 *
 * Served rather than compiled in for a practical reason: Google's OAuth
 * verification checks that the operator and support address on the policy
 * pages match the Cloud project, and it re-checks annually. Making those an
 * environment variable means correcting them is a platform setting away,
 * not a rebuild of the SPA — which matters when a reviewer asks for a change
 * and the clock is running on the review.
 *
 * Public by design: these pages must be readable without signing in, because
 * a reviewer reads them before they ever see the consent screen.
 */
export const legalRouter = Router();

legalRouter.get('/legal', (_req, res) => {
  // Cacheable, but not for long — a correction during OAuth review should
  // reach the reviewer on their next load, not an hour later.
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    operator: config.legal.operator,
    contactEmail: config.legal.contactEmail,
    /** Empty when unconfigured; the client says so rather than inventing one. */
    jurisdiction: config.legal.jurisdiction,
    lastUpdated: config.legal.lastUpdated,
  });
});
