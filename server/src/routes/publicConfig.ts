import { Router } from 'express';
import { config } from '../config.js';

/**
 * The facts about this deployment that the browser needs before anyone signs
 * in: who operates the service, and whether Google has verified the OAuth app.
 *
 * Served rather than compiled in, for the same reason in both cases — each is
 * a fact that changes without the code changing. Google's OAuth review checks
 * that the operator and support address match the Cloud project and re-checks
 * annually, and verification itself lands on a day nobody can predict. Making
 * them environment variables means a correction is a platform setting away
 * rather than a rebuild, which matters when a reviewer asks for one and the
 * clock is running on the review.
 *
 * Public by design: a reviewer reads the policy pages before they ever reach
 * the consent screen, and the sign-in warning is for people who are not signed
 * in yet.
 */
export const publicConfigRouter = Router();

publicConfigRouter.get('/public-config', (_req, res) => {
  // Cacheable, but not for long — a correction during OAuth review should
  // reach the reviewer on their next load, not an hour later.
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    legal: {
      operator: config.legal.operator,
      contactEmail: config.legal.contactEmail,
      /** Empty when unconfigured; the client says so rather than inventing one. */
      jurisdiction: config.legal.jurisdiction,
      lastUpdated: config.legal.lastUpdated,
    },
    /**
     * False until Google finishes verification. While false the sign-in page
     * explains the "Google hasn't verified this app" screen users are about
     * to meet, rather than letting it read as a malware warning.
     */
    oauthVerified: config.google.appVerified,
    /**
     * What the browser needs to open the Google Picker. All three values are
     * public — the Picker runs client-side and Google requires them there —
     * but they are served rather than compiled in so that changing the API key
     * is a platform setting rather than a client rebuild.
     */
    picker: config.google.picker,
  });
});
