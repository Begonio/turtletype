/**
 * The Google Picker.
 *
 * Under `https://www.googleapis.com/auth/drive.file` TurtleType can only reach
 * documents it created itself and documents the user has explicitly handed it.
 * Pasting a link is not handing it over — Google grants nothing on a URL — so
 * this is the only route to "write into a document I already have".
 *
 * The picker runs in Google's own iframe, so the file list, the search box and
 * the account's Drive contents never touch this app. What comes back is one
 * document ID that the account has now granted us, and nothing else.
 */

/** What the server hands over so a picker can be opened. */
export interface PickerSession {
  /** False when the deploy has no Picker API key: the existing-doc path is off. */
  configured: boolean;
  accessToken?: string;
  apiKey?: string;
  /** Cloud project number. Empty is allowed; only shared drives need it. */
  appId?: string;
  scope?: string;
}

export interface PickedDoc {
  id: string;
  name: string;
  url: string;
}

/** Only the handful of members this module touches, rather than a types package. */
interface PickerBuilderLike {
  setTitle(title: string): PickerBuilderLike;
  setDeveloperKey(key: string): PickerBuilderLike;
  setAppId(appId: string): PickerBuilderLike;
  setOAuthToken(token: string): PickerBuilderLike;
  addView(view: unknown): PickerBuilderLike;
  enableFeature(feature: unknown): PickerBuilderLike;
  setCallback(callback: (data: Record<string, unknown>) => void): PickerBuilderLike;
  build(): { setVisible(visible: boolean): void; dispose?(): void };
}

interface DocsViewLike {
  setIncludeFolders(include: boolean): DocsViewLike;
  setSelectFolderEnabled(enabled: boolean): DocsViewLike;
  setMimeTypes(mimeTypes: string): DocsViewLike;
  setOwnedByMe(ownedByMe: boolean): DocsViewLike;
  setEnableDrives(enable: boolean): DocsViewLike;
  /** Comma-separated. Pre-navigates the picker straight to these files. */
  setFileIds(fileIds: string): DocsViewLike;
}

interface PickerNamespace {
  DocsView: new (viewId?: unknown) => DocsViewLike;
  PickerBuilder: new () => PickerBuilderLike;
  ViewId: { DOCUMENTS: unknown };
  Feature: { SUPPORT_DRIVES: unknown };
  Action: { PICKED: string; CANCEL: string };
  Response: { ACTION: string; DOCUMENTS: string };
  Document: { ID: string; NAME: string; URL: string };
}

declare global {
  interface Window {
    gapi?: {
      load(name: string, options: { callback: () => void; onerror?: () => void }): void;
    };
    google?: { picker?: PickerNamespace };
  }
}

const GAPI_SRC = 'https://apis.google.com/js/api.js';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

export class PickerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PickerUnavailableError';
  }
}

/**
 * Single-flight script load. React strict mode mounts twice and a user can
 * click the button before the first load settles, so the promise is cached —
 * but cleared on failure, so a picker that failed on a flaky connection can be
 * retried rather than being broken until reload.
 */
let loader: Promise<PickerNamespace> | null = null;

function injectGapi(): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (): void =>
      reject(new PickerUnavailableError('Could not load Google Drive. Check your connection and try again.'));

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GAPI_SRC}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', fail);
      return;
    }

    const script = document.createElement('script');
    script.src = GAPI_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true';
      resolve();
    });
    script.addEventListener('error', fail);
    document.head.appendChild(script);
  });
}

export function loadPicker(): Promise<PickerNamespace> {
  if (!loader) {
    loader = injectGapi()
      .then(
        () =>
          new Promise<PickerNamespace>((resolve, reject) => {
            const gapi = window.gapi;
            if (!gapi) {
              reject(new PickerUnavailableError('Google Drive did not load. Please try again.'));
              return;
            }
            gapi.load('picker', {
              callback: () => {
                const picker = window.google?.picker;
                if (picker) resolve(picker);
                else reject(new PickerUnavailableError('Google Drive did not load. Please try again.'));
              },
              onerror: () =>
                reject(new PickerUnavailableError('Google Drive did not load. Please try again.')),
            });
          }),
      )
      .catch((error: unknown) => {
        loader = null;
        throw error;
      });
  }
  return loader;
}

/**
 * Opens the picker and resolves with the chosen document, or null if the user
 * closed it without choosing.
 *
 * `fileIds` pre-navigates the picker to specific documents, which is what
 * keeps the pasted-link habit alive: paste a URL, and instead of a dead end
 * the user gets a picker already showing that one file, one click from
 * granting access to it. Google added `setFileIds` for exactly this, and
 * pointed at it when they refused the broader scope.
 */
export async function openPicker(
  session: PickerSession,
  options: { fileIds?: string[] } = {},
): Promise<PickedDoc | null> {
  if (!session.configured || !session.accessToken || !session.apiKey) {
    throw new PickerUnavailableError(
      'Choosing an existing document is not available on this deployment.',
    );
  }

  const picker = await loadPicker();
  const fileIds = (options.fileIds ?? []).filter(Boolean);

  const view = new picker.DocsView(picker.ViewId.DOCUMENTS)
    .setMimeTypes(GOOGLE_DOC_MIME)
    .setIncludeFolders(false)
    .setSelectFolderEnabled(false);

  if (fileIds.length > 0) {
    // Google's reference is explicit that this overrides setEnableDrives and
    // setParent, so the shared-drive branch below is deliberately the `else`.
    view.setFileIds(fileIds.join(','));
  } else if (session.appId) {
    // Shared drives only show up when the picker knows which app is asking.
    view.setEnableDrives(true);
  }

  return new Promise<PickedDoc | null>((resolve) => {
    const builder = new picker.PickerBuilder()
      .setTitle('Choose a Google Doc for TurtleType to write into')
      .setDeveloperKey(session.apiKey!)
      .setOAuthToken(session.accessToken!)
      .addView(view);

    if (session.appId) {
      builder.setAppId(session.appId);
      if (fileIds.length === 0) builder.enableFeature(picker.Feature.SUPPORT_DRIVES);
    }

    const built = builder
      .setCallback((data) => {
        const action = data[picker.Response.ACTION];
        if (action === picker.Action.CANCEL) {
          resolve(null);
          return;
        }
        if (action !== picker.Action.PICKED) return;

        const docs = data[picker.Response.DOCUMENTS] as
          | Array<Record<string, string>>
          | undefined;
        const chosen = docs?.[0];
        if (!chosen?.[picker.Document.ID]) {
          resolve(null);
          return;
        }
        resolve({
          id: chosen[picker.Document.ID]!,
          name: chosen[picker.Document.NAME] ?? 'Untitled document',
          url:
            chosen[picker.Document.URL] ??
            `https://docs.google.com/document/d/${chosen[picker.Document.ID]}/edit`,
        });
      })
      .build();

    built.setVisible(true);
  });
}

/**
 * Pulls a document ID out of anything a user might paste. Mirrors
 * `parseDocId` on the server, and exists so a pasted link can pre-navigate the
 * picker before any request is made.
 */
export function parseDocId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const patterns = [
    /\/document\/d\/([a-zA-Z0-9_-]{10,})/,
    /[?&]id=([a-zA-Z0-9_-]{10,})/,
    /^([a-zA-Z0-9_-]{20,})$/,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}
