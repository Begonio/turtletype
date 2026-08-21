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
  callback: (response: TokenResponse) => void;
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

let tokenClient: TokenClient | null = null;
let tokenClientId: string | null = null;
let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * A `drive.file` access token for the browser.
 *
 * `prompt: ''` means Google only shows a consent screen when it has to: a user
 * who ticked the Drive box at sign-in never sees a second dialog, and one who
 * skipped it gets asked exactly once, here, where the reason is obvious.
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
    // The client is reusable, but not across a config change.
    if (!tokenClient || tokenClientId !== config.clientId) {
      tokenClient = oauth2.initTokenClient({
        client_id: config.clientId,
        scope: DRIVE_FILE_SCOPE,
        // Replaced per request below; the library requires one at construction.
        callback: () => {},
        error_callback: () => {},
      });
      tokenClientId = config.clientId;
    }

    tokenClient.callback = (response) => {
      if (response.error || !response.access_token) {
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
      resolve(response.access_token);
    };

    const client = tokenClient as TokenClient & {
      error_callback?: (error: { type?: string }) => void;
    };
    client.error_callback = (error) => {
      // popup_closed and popup_failed_to_open both mean the user never made a
      // choice, which is a cancel rather than a fault.
      reject(
        new PickerError(
          error.type === 'popup_failed_to_open'
            ? 'Your browser blocked Google’s permission popup. Allow popups for this site, or paste a link instead.'
            : 'Permission was not granted, so the picker could not open.',
          'declined',
        ),
      );
    };

    tokenClient.requestAccessToken({ prompt: '' });
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
