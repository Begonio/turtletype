/**
 * Settings the browser needs to open the Google Picker.
 *
 * None of it is secret — the Picker runs in the user's browser and Google
 * requires the client ID, a browser API key and the Cloud project number to be
 * visible there. It is served from `/api/public-config` rather than baked in
 * with `VITE_` variables for the same reason the legal identity is: the client
 * bundle is built once inside the Dockerfile, so anything compiled into it
 * costs a rebuild and a redeploy to change, while an environment variable is a
 * platform setting and a restart.
 *
 * Pure, like `launchChecks.ts`: it reads the values handed to it rather than
 * `process.env`, so the derivation can be tested without an environment.
 */

export interface PickerInput {
  /** The OAuth client ID the app signs in with. */
  clientId?: string | undefined;
  /** Browser API key, from Credentials → Create credentials → API key. */
  apiKey?: string | undefined;
  /** Cloud project number. Derived from the client ID when not given. */
  appId?: string | undefined;
}

export interface PickerSettings {
  /**
   * Whether the browser has everything it needs. False leaves the picker
   * button out entirely and the paste-a-link field is the only way to name an
   * existing document — which is exactly how the app worked before, so a
   * deploy with no API key is degraded rather than broken.
   */
  enabled: boolean;
  clientId: string;
  apiKey: string;
  appId: string;
}

/**
 * The Cloud project number, which the Picker wants as `appId`.
 *
 * A Google OAuth client ID is the project number, a dash, then an opaque
 * string: `123456789012-abc123.apps.googleusercontent.com`. Reading it from
 * there rather than asking for it separately removes an environment variable
 * whose only failure mode is being quietly wrong — a mismatched appId means
 * the per-file grants the Picker hands out are attributed to another project,
 * and the symptom is a 404 on a document the user just chose.
 */
export function projectNumberFromClientId(clientId: string): string {
  return /^(\d+)-/.exec(clientId.trim())?.[1] ?? '';
}

export function resolvePickerConfig(input: PickerInput): PickerSettings {
  const clientId = input.clientId?.trim() ?? '';
  const apiKey = input.apiKey?.trim() ?? '';
  const appId = input.appId?.trim() || projectNumberFromClientId(clientId);

  return {
    // An appId is required as well as the key: without it the Picker opens but
    // the file it returns is not shared with this project, so the pick
    // silently produces a document the app cannot read.
    enabled: Boolean(clientId && apiKey && appId),
    clientId,
    apiKey,
    appId,
  };
}
