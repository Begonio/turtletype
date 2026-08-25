/**
 * The Google Picker: Google's own file chooser, opened over the app so the
 * user can point at a document instead of finding its URL and pasting it.
 *
 * Two Google scripts are involved and they do different jobs. Google Identity
 * Services (`gsi/client`) obtains a browser access token limited to
 * `drive.file`; the Picker (`api.js`) renders the chooser and returns the file
 * the user clicked. Neither touches the credentials the server types with —
 * those never leave the server — and the token minted here is per-file by
 * construction: it grants this app access to the documents the user selects
 * and nothing else.
 *
 * That narrowness is the point. A picker built on a Drive listing call would
 * need `drive.metadata.readonly`, which Google classifies as *restricted* and
 * which drags a CASA security assessment into OAuth verification. `drive.file`
 * is non-sensitive, so this whole feature costs the review nothing.
 *
 * Everything here degrades: if the deploy has no Picker API key, if a script
 * is blocked, or if the user declines the Drive permission, the caller falls
 * back to the paste-a-link field the app has always had.
 */

/** Per-file access to documents the user hands over through the Picker. */
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const GSI_SRC = 'https://accounts.google.com/gsi/client';
const GAPI_SRC = 'https://apis.google.com/js/api.js';

/** Refresh a little before expiry so a picker opened on the hour still works. */
const TOKEN_SKEW_MS = 60_000;

export interface PickerConfig {
  clientId: string;
  apiKey: string;
  appId: string;
}

export interface PickedDoc {
  id: string;
  name: string;
  url: string;
}

/** Something the user can act on, rather than a stack trace. */
export class PickerError extends Error {
  constructor(
    message: string,
    readonly code: 'unavailable' | 'declined' | 'failed',
  ) {
    super(message);
    this.name = 'PickerError';
  }
}

// Minimal shapes for the two globals. Google ships no types for either, and
// declaring only what is used keeps the surface honest.
interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}

interface TokenClient {
  requestAccessToken: (overrides?: { prompt?: string }) => void;
}

interface PickerDocument {
  id?: string;
  name?: string;
  url?: string;
}

interface PickerCallbackData {
  action?: string;
  docs?: PickerDocument[];
}

interface PickerBuilder {
  setAppId: (appId: string) => PickerBuilder;
  setOAuthToken: (token: string) => PickerBuilder;
  setDeveloperKey: (key: string) => PickerBuilder;
  setTitle: (title: string) => PickerBuilder;
  addView: (view: unknown) => PickerBuilder;
  setCallback: (callback: (data: PickerCallbackData) => void) => PickerBuilder;
  build: () => { setVisible: (visible: boolean) => void };
}

interface DocsView {
  setIncludeFolders: (include: boolean) => DocsView;
  setOwnedByMe: (owned: boolean) => DocsView;
  setMode: (mode: unknown) => DocsView;
  setLabel: (label: string) => DocsView;
}

interface GoogleGlobal {
  picker?: {
    PickerBuilder: new () => PickerBuilder;
    DocsView: new (viewId: unknown) => DocsView;
    ViewId: { DOCUMENTS: unknown };
    DocsViewMode: { LIST: unknown };
    Action: { PICKED: string; CANCEL: string };
  };
  accounts?: {
    oauth2: {
      initTokenClient: (options: {
        client_id: string;
        scope: string;
        callback: (response: TokenResponse) => void;
        error_callback?: (error: { type?: string }) => void;
      }) => TokenClient;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleGlobal;
    gapi?: { load: (name: string, callback: () => void) => void };
  }
}

/** One in-flight load per script, so N callers share one network request. */
const scriptLoads = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  const existing = scriptLoads.get(src);
  if (existing) return existing;

  const load = new Promise<void>((resolve, reject) => {
    const element = document.createElement('script');
    element.src = src;
    element.async = true;
    element.onload = () => resolve();
    element.onerror = () => {
      // Let a later attempt retry rather than caching the failure forever —
      // this is usually an extension or a network blip, not a permanent state.
      scriptLoads.delete(src);
      reject(new PickerError('Google’s file picker could not be loaded.', 'unavailable'));
    };
    document.head.appendChild(element);
  });

  scriptLoads.set(src, load);
  return load;
}

let pickerApiLoaded: Promise<void> | null = null;

/** `api.js` only exposes the picker after this second, callback-based load. */
function loadPickerApi(): Promise<void> {
  if (pickerApiLoaded) return pickerApiLoaded;
  pickerApiLoaded = loadScript(GAPI_SRC).then(
    () =>
      new Promise<void>((resolve, reject) => {
        const gapi = window.gapi;
        if (!gapi) {
          pickerApiLoaded = null;
          reject(new PickerError('Google’s file picker could not be loaded.', 'unavailable'));
          return;
        }
        gapi.load('picker', () => resolve());
      }),
  );
  return pickerApiLoaded;
}

/**
 * Fetches the scripts ahead of the click.
 *
 * Requesting a token opens a Google popup, and browsers only allow that while
 * the user's click is still "fresh". Loading two scripts first can outlast
 * that window, so the app warms them up as soon as it knows the picker is
 * configured. Failures are deliberately swallowed: this is an optimisation,
 * and the real attempt reports its own errors.
 */
export function preloadPicker(): void {
  void loadScript(GSI_SRC).catch(() => {});
  void loadPickerApi().catch(() => {});
}

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * Whether this browser has ever completed the Drive consent for this app.
 *
 * It decides whether the token request may suppress Google's prompt. Kept in
 * localStorage because the grant belongs to the Google account, not the tab: a
 * user who consented last week should not be asked again on a page reload.
 * Wrong in either direction is survivable — a stale true costs one silent
 * request that fails and re-prompts, a missing true costs one extra click.
 */
const GRANTED_KEY = 'turtletype.driveGranted';

function hasGrantedBefore(): boolean {
  try {
    return localStorage.getItem(GRANTED_KEY) === 'true';
  } catch {
    // Private mode, or storage disabled entirely. Prompting is the safe answer.
    return false;
  }
}

function rememberGrant(granted: boolean): void {
  try {
    if (granted) localStorage.setItem(GRANTED_KEY, 'true');
    else localStorage.removeItem(GRANTED_KEY);
  } catch {
    // Not being able to remember only costs an extra consent click.
  }
}

/** Longest a token request may sit unanswered before the UI is released. */
const TOKEN_TIMEOUT_MS = 120_000;

/**
 * A `drive.file` access token for the browser.
 *
 * The `prompt` value is the whole subtlety here. Google's default
 * (`select_account consent`) always asks; `''` asks only if it must — but
 * "must" is decided before the popup renders, so on an account that has never
 * granted the scope, `''` produces an account chooser that accepts a click and
 * then closes with nothing. Consent was required and had been suppressed.
 *
 * So the prompt is only suppressed once this browser has seen a grant succeed.
 * First time through, Google is allowed to ask properly; afterwards the user
 * gets the silent path they should have.
 */
async function getAccessToken(config: PickerConfig): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - TOKEN_SKEW_MS > now) return cachedToken.value;

  await loadScript(GSI_SRC);
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) {
    throw new PickerError('Google’s sign-in library could not be loaded.', 'unavailable');
  }

  return new Promise<string>((resolve, reject) => {
    // Settled once, by whichever of the three paths below gets there first.
    // Google's library is not required to call either callback — a popup that
    // is closed by the operating system reaches neither — and an unsettled
    // promise here leaves the button disabled with no way back.
    let settled = false;
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new PickerError(
            'Google did not answer the permission request. Try again, or paste a link instead.',
            'failed',
          ),
        ),
      );
    }, TOKEN_TIMEOUT_MS);

    // Built fresh per request rather than reused. `error_callback` is read off
    // the config object when the client is constructed, so a client built once
    // and re-pointed later keeps calling whichever handler it was born with —
    // which silently swallowed every failure.
    const client = oauth2.initTokenClient({
      client_id: config.clientId,
      scope: DRIVE_FILE_SCOPE,
      callback: (response) => {
        finish(() => {
          if (response.error || !response.access_token) {
            // The recorded grant is evidently not usable; prompt properly next time.
            rememberGrant(false);
            reject(
              new PickerError(
                'Google did not grant permission to open your documents.',
                response.error === 'access_denied' ? 'declined' : 'failed',
              ),
            );
            return;
          }
          cachedToken = {
            value: response.access_token,
            expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000,
          };
          rememberGrant(true);
          resolve(response.access_token);
        });
      },
      error_callback: (error) => {
        finish(() => {
          if (error.type === 'popup_failed_to_open') {
            reject(
              new PickerError(
                'Your browser blocked Google’s permission popup. Allow popups for this site, or paste a link instead.',
                'declined',
              ),
            );
            return;
          }

          // Otherwise the popup closed without a token. Usually that is the
          // user shutting it; it is also what a rejected request looks like,
          // because Google renders its own error page inside the popup. The
          // library reports both identically, so the message covers both and
          // the console carries the diagnosis a developer needs.
          rememberGrant(false);
          console.warn(
            '[picker] Google closed the token popup without issuing a token. If an ' +
              '"Access blocked / no registered origin / 401 invalid_client" page appeared, ' +
              `add this page's origin (${window.location.origin}) to Authorized JavaScript ` +
              'origins on the OAuth client in Google Cloud Console — that is a different ' +
              'field from the redirect URI used for sign-in, and it is empty by default. ' +
              'If the popup simply closed after choosing an account, the drive.file scope ' +
              'is likely missing from the OAuth consent screen, or this account is not on ' +
              'the app’s test-user list while the app is in Testing.',
          );
          reject(
            new PickerError(
              'The Google window closed before a document was chosen. If it showed an ' +
                'error, this site’s Google setup needs fixing — paste a link instead for now.',
              'declined',
            ),
          );
        });
      },
    });

    // Suppress the prompt only where suppressing it is safe: see above.
    client.requestAccessToken(hasGrantedBefore() ? { prompt: '' } : {});
  });
}

/**
 * Opens the picker and resolves with the chosen document, or `null` if the
 * user closed it without choosing.
 */
export async function pickDocument(config: PickerConfig): Promise<PickedDoc | null> {
  const [token] = await Promise.all([getAccessToken(config), loadPickerApi()]);
  const picker = window.google?.picker;
  if (!picker) {
    throw new PickerError('Google’s file picker could not be loaded.', 'unavailable');
  }

  return new Promise<PickedDoc | null>((resolve, reject) => {
    // Two views, because "shared with me" is where a document someone else
    // started — the assignment template, the shared draft — actually lives,
    // and that is the case the paste-a-link field existed for.
    const myDocs = new picker.DocsView(picker.ViewId.DOCUMENTS)
      .setIncludeFolders(true)
      .setMode(picker.DocsViewMode.LIST)
      .setLabel('My documents');
    const sharedWithMe = new picker.DocsView(picker.ViewId.DOCUMENTS)
      .setOwnedByMe(false)
      .setMode(picker.DocsViewMode.LIST)
      .setLabel('Shared with me');

    try {
      new picker.PickerBuilder()
        .setAppId(config.appId)
        .setOAuthToken(token)
        .setDeveloperKey(config.apiKey)
        .setTitle('Choose a Google Doc')
        .addView(myDocs)
        .addView(sharedWithMe)
        .setCallback((data) => {
          if (data.action === picker.Action.CANCEL) {
            resolve(null);
            return;
          }
          if (data.action !== picker.Action.PICKED) return;

          const doc = data.docs?.[0];
          if (!doc?.id) {
            reject(new PickerError('Google returned a document with no ID.', 'failed'));
            return;
          }
          resolve({
            id: doc.id,
            name: doc.name?.trim() || 'Untitled document',
            url: doc.url ?? `https://docs.google.com/document/d/${doc.id}/edit`,
          });
        })
        .build()
        .setVisible(true);
    } catch {
      reject(new PickerError('Google’s file picker failed to open.', 'failed'));
    }
  });
}
