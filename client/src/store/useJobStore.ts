import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ApiError, api, loginUrl, streamUrl, type CurrentUser, type JobStatus } from '../lib/api';
import {
  PickerError,
  pickDocument,
  preloadPicker,
  type PickedDoc,
  type PickerConfig,
} from '../lib/googlePicker';

export type Phase = 'idle' | 'starting' | JobStatus;
export type DocMode = 'new' | 'existing';
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting';

type WireOp =
  | { kind: 'insert'; text: string }
  | { kind: 'delete'; count: number }
  | { kind: 'repair'; offset: number; remove: number; insert: string };

/** How much of the tail the preview keeps. Enough to read, bounded for 200k jobs. */
const PREVIEW_LIMIT = 6_000;

interface JobStore {
  // -- session ---------------------------------------------------------
  user: CurrentUser | null;
  authChecked: boolean;

  // -- composer --------------------------------------------------------
  text: string;
  /** Requested wall-clock duration. null means "run at the natural minimum". */
  durationMs: number | null;
  /** Shortest believable duration for the current text, computed server-side. */
  minDurationMs: number;
  maxDurationMs: number;
  /** Separate writing sessions the plan will produce, i.e. expected revisions. */
  bursts: number;
  /** Credits the current text would cost. 0 when billing is off. */
  jobCost: number;
  /** True once the server has told us this deploy charges for anything. */
  billingEnabled: boolean;
  /** Set when a job was refused for lack of credits, so the UI can offer the fix. */
  needsCredits: boolean;
  estimating: boolean;
  /** Plan time left when the last progress event arrived, and when that was. */
  remainingMs: number | null;
  remainingAt: number | null;
  resting: boolean;
  /** Characters that have scrolled off the front of the preview. */
  previewDropped: number;
  docMode: DocMode;
  docUrlInput: string;
  /** The document chosen through the Google Picker, if one was. */
  selectedDoc: PickedDoc | null;
  /** Picker settings from the server. null until /api/public-config answers. */
  pickerConfig: PickerConfig | null;
  pickerAvailable: boolean;
  pickerBusy: boolean;
  pickerError: string | null;

  // -- live job --------------------------------------------------------
  jobId: string | null;
  docUrl: string | null;
  phase: Phase;
  pct: number;
  charsWritten: number;
  totalChars: number;
  charsPerMinute: number;
  estimatedMs: number | null;
  preview: string;
  error: string | null;
  notice: string | null;
  connection: ConnectionState;

  // -- actions ---------------------------------------------------------
  loadUser: () => Promise<void>;
  /** Re-reads the balance after returning from Checkout. */
  refreshCredits: () => Promise<void>;
  signOut: () => Promise<void>;
  setText: (text: string) => void;
  setDurationMs: (durationMs: number | null) => void;
  refreshEstimate: () => void;
  setDocMode: (mode: DocMode) => void;
  setDocUrlInput: (value: string) => void;
  /** Opens the Google Picker and remembers what came back. */
  chooseDoc: () => Promise<void>;
  clearSelectedDoc: () => void;
  startJob: () => Promise<void>;
  pauseJob: () => Promise<void>;
  resumeJob: () => Promise<void>;
  cancelJob: () => Promise<void>;
  attachStream: (jobId: string) => void;
  detachStream: () => void;
  resetJob: () => void;
}

/**
 * The EventSource lives outside the store: it is a connection, not state, and
 * React strict-mode double-invocation must not open two of them.
 */
let source: EventSource | null = null;
let attachedJobId: string | null = null;

/** Estimate request bookkeeping — connection state, not app state. */
let estimateTimer: ReturnType<typeof setTimeout> | null = null;
let estimateController: AbortController | null = null;
let estimateRequestId = 0;
const ESTIMATE_DEBOUNCE_MS = 500;

const TERMINAL: Phase[] = ['done', 'failed', 'cancelled'];

/**
 * Applies document ops to the preview.
 *
 * The preview only keeps the tail, so `dropped` records how many characters
 * have scrolled off the front. Repairs arrive as absolute offsets from the
 * start of the job's text and have to be translated into that window; one
 * aimed at text that has already scrolled away is simply skipped.
 */
function applyOps(
  preview: string,
  dropped: number,
  ops: WireOp[],
): { preview: string; dropped: number } {
  let next = preview;

  for (const op of ops) {
    if (op.kind === 'insert') {
      next += op.text;
    } else if (op.kind === 'delete') {
      next = next.slice(0, Math.max(0, next.length - op.count));
    } else {
      const local = op.offset - dropped;
      if (local >= 0 && local + op.remove <= next.length) {
        next = next.slice(0, local) + op.insert + next.slice(local + op.remove);
      }
    }
  }

  if (next.length <= PREVIEW_LIMIT) return { preview: next, dropped };
  const overflow = next.length - PREVIEW_LIMIT;
  return { preview: next.slice(overflow), dropped: dropped + overflow };
}

export const useJobStore = create<JobStore>()(
  persist(
    (set, get) => ({
      user: null,
      authChecked: false,

      text: '',
      durationMs: null,
      minDurationMs: 0,
      maxDurationMs: 24 * 60 * 60 * 1_000,
      bursts: 0,
      jobCost: 0,
      billingEnabled: false,
      needsCredits: false,
      estimating: false,
      remainingMs: null,
      remainingAt: null,
      resting: false,
      previewDropped: 0,
      docMode: 'new',
      docUrlInput: '',
      selectedDoc: null,
      pickerConfig: null,
      pickerAvailable: false,
      pickerBusy: false,
      pickerError: null,

      jobId: null,
      docUrl: null,
      phase: 'idle',
      pct: 0,
      charsWritten: 0,
      totalChars: 0,
      charsPerMinute: 0,
      estimatedMs: null,
      preview: '',
      error: null,
      notice: null,
      connection: 'idle',

      async loadUser() {
        try {
          const { user } = await api.me();
          set({ user, authChecked: true });
          // Cheap, and it tells the composer whether to show prices at all.
          void api
            .catalog()
            .then(({ enabled }) => set({ billingEnabled: enabled }))
            .catch(() => {});
          // Whether this deploy can open the Google Picker. Fetched here so
          // the scripts can be warmed up before the user clicks: requesting a
          // token opens a popup, and browsers only permit that while the click
          // that caused it is still recent.
          void api
            .publicConfig()
            .then(({ picker }) => {
              if (!picker?.enabled) return;
              set({
                pickerAvailable: true,
                pickerConfig: {
                  clientId: picker.clientId,
                  apiKey: picker.apiKey,
                  appId: picker.appId,
                },
              });
              preloadPicker();
            })
            .catch(() => {});
        } catch {
          set({ user: null, authChecked: true });
        }
      },

      /**
       * Re-reads the balance from the server.
       *
       * Called after returning from Checkout. The success URL is not proof of
       * payment — Stripe's webhook is — so this polls briefly rather than
       * assuming the credits have landed: the webhook usually beats the
       * browser redirect back, but not always.
       */
      async refreshCredits() {
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const { user } = await api.me();
            const previous = get().user?.credits ?? 0;
            set({ user });
            if (user.credits > previous || attempt === 4) return;
          } catch {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
        }
      },

      async signOut() {
        get().detachStream();
        try {
          await api.logout();
        } finally {
          set({ user: null, jobId: null, phase: 'idle', preview: '' });
        }
      },

      setText: (text) => {
        set({ text });
        get().refreshEstimate();
      },
      setDurationMs: (durationMs) => set({ durationMs }),
      /**
       * Asks the server what the shortest believable duration for this text is.
       * Debounced, and older replies are discarded, so typing quickly cannot
       * leave a stale floor on the slider.
       */
      refreshEstimate() {
        const { text } = get();

        if (estimateTimer !== null) clearTimeout(estimateTimer);
        estimateController?.abort();

        if (!text.trim()) {
          set({ minDurationMs: 0, bursts: 0, jobCost: 0, estimating: false });
          return;
        }

        set({ estimating: true });
        estimateTimer = setTimeout(() => {
          const controller = new AbortController();
          estimateController = controller;
          const requestId = ++estimateRequestId;

          void api
            .estimate({ text: get().text }, controller.signal)
            .then((estimate) => {
              if (requestId !== estimateRequestId) return;
              set((state) => ({
                minDurationMs: estimate.minDurationMs,
                maxDurationMs: estimate.maxDurationMs,
                bursts: estimate.bursts,
                jobCost: estimate.credits,
                estimating: false,
                // Keep an explicit choice, but never below the new floor.
                durationMs:
                  state.durationMs === null ? null : Math.max(state.durationMs, estimate.minDurationMs),
              }));
            })
            .catch(() => {
              if (requestId === estimateRequestId) set({ estimating: false });
            });
        }, ESTIMATE_DEBOUNCE_MS);
      },

      setDocMode: (docMode) => set({ docMode, pickerError: null }),
      // Typing a link is an explicit choice of a different document, so it
      // supersedes whatever the picker returned earlier.
      setDocUrlInput: (docUrlInput) =>
        set({ docUrlInput, ...(docUrlInput.trim() ? { selectedDoc: null } : {}) }),

      /**
       * Opens Google's own file chooser.
       *
       * Failure here is never fatal: the paste-a-link field is still on the
       * screen, so anything that goes wrong is reported as a sentence next to
       * the button rather than a dead end.
       */
      async chooseDoc() {
        const { pickerConfig, pickerBusy } = get();
        if (!pickerConfig || pickerBusy) return;

        set({ pickerBusy: true, pickerError: null });
        try {
          const doc = await pickDocument(pickerConfig);
          // A closed picker is a decision to pick nothing, not an error, and
          // it must not clear a document already chosen.
          if (doc) set({ selectedDoc: doc, docUrlInput: '', error: null });
        } catch (error) {
          set({
            pickerError:
              error instanceof PickerError
                ? error.message
                : 'The picker could not be opened. Paste a link instead.',
          });
        } finally {
          set({ pickerBusy: false });
        }
      },

      clearSelectedDoc: () => set({ selectedDoc: null, pickerError: null }),

      async startJob() {
        const { text, durationMs, docMode, docUrlInput, selectedDoc } = get();
        if (!text.trim() || get().phase === 'starting') return;

        // A picked document wins over the paste field: it is the more recent
        // choice whenever both are set, and it is already a bare ID the server
        // does not have to parse out of a URL.
        const targetDoc = selectedDoc?.id ?? docUrlInput.trim();

        get().detachStream();
        set({
          phase: 'starting',
          error: null,
          notice: null,
          needsCredits: false,
          preview: '',
          previewDropped: 0,
          pct: 0,
          charsWritten: 0,
          charsPerMinute: 0,
          totalChars: text.length,
          docUrl: null,
          estimatedMs: null,
          remainingMs: null,
          remainingAt: null,
          resting: false,
        });

        try {
          const response = await api.createJob({
            text,
            // Omitted means "run at the natural minimum", which the server computes.
            ...(durationMs ? { durationMs } : {}),
            ...(docMode === 'existing' && targetDoc ? { docId: targetDoc } : {}),
          });

          set((state) => ({
            jobId: response.jobId,
            docUrl: response.docUrl,
            totalChars: response.totalChars,
            estimatedMs: response.estimatedMs,
            minDurationMs: response.minDurationMs,
            bursts: response.bursts,
            // The server is authoritative about what was actually charged.
            user: state.user ? { ...state.user, credits: response.creditsRemaining } : state.user,
            phase: response.started ? 'running' : 'pending',
            notice: response.started
              ? null
              : `Queued at position ${response.queuePosition} — it will start automatically.`,
          }));

          get().attachStream(response.jobId);
        } catch (error) {
          // A revoked or expired Google grant is not something the user can
          // fix from this screen — send them straight back through consent.
          if (error instanceof ApiError && error.code === 'REAUTH_REQUIRED') {
            window.location.href = loginUrl('/app');
            return;
          }
          // Out of credits is not a failure of the job — the text is still in
          // the composer and the only thing missing is a purchase. Say so
          // without dropping into the 'failed' phase, which reads as an error
          // and hides the start button behind a reset.
          if (error instanceof ApiError && error.code === 'INSUFFICIENT_CREDITS') {
            set({ phase: 'idle', error: error.message, needsCredits: true });
            return;
          }
          const message =
            error instanceof ApiError ? error.message : 'Could not start the job. Please try again.';
          set({ phase: 'failed', error: message });
        }
      },

      async pauseJob() {
        const { jobId } = get();
        if (!jobId) return;
        // Optimistic: the SSE status event confirms it a moment later.
        set({ phase: 'paused' });
        try {
          await api.pauseJob(jobId);
        } catch (error) {
          set({ phase: 'running', error: error instanceof ApiError ? error.message : null });
        }
      },

      async resumeJob() {
        const { jobId } = get();
        if (!jobId) return;
        set({ phase: 'running' });
        try {
          await api.resumeJob(jobId);
        } catch (error) {
          set({ phase: 'paused', error: error instanceof ApiError ? error.message : null });
        }
      },

      async cancelJob() {
        const { jobId } = get();
        if (!jobId) return;
        try {
          await api.cancelJob(jobId);
        } catch (error) {
          set({ error: error instanceof ApiError ? error.message : 'Could not stop the job.' });
        }
      },

      attachStream(jobId) {
        if (attachedJobId === jobId && source && source.readyState !== EventSource.CLOSED) return;
        get().detachStream();

        attachedJobId = jobId;
        set({ connection: 'connecting' });

        const es = new EventSource(streamUrl(jobId), { withCredentials: true });
        source = es;

        es.addEventListener('open', () => set({ connection: 'open', notice: null }));

        es.addEventListener('snapshot', (event) => {
          const data = JSON.parse((event as MessageEvent<string>).data) as {
            status: JobStatus;
            pct: number;
            charsWritten: number;
            totalChars: number;
            docUrl: string | null;
          };
          set((state) => ({
            phase: data.status,
            pct: data.pct,
            charsWritten: data.charsWritten,
            totalChars: data.totalChars || state.totalChars,
            docUrl: data.docUrl ?? state.docUrl,
          }));
        });

        es.addEventListener('progress', (event) => {
          const data = JSON.parse((event as MessageEvent<string>).data) as {
            status: JobStatus;
            pct: number;
            charsWritten: number;
            totalChars: number;
            charsPerMinute: number;
            remainingMs?: number;
            resting: boolean;
            ops: WireOp[];
          };
          set((state) => ({
            // A local pause has not necessarily reached the server yet; do not
            // let an in-flight progress event flip the button back.
            phase: state.phase === 'paused' && data.status === 'running' ? state.phase : data.status,
            pct: data.pct,
            charsWritten: data.charsWritten,
            totalChars: data.totalChars,
            charsPerMinute: data.charsPerMinute,
            resting: data.resting,
            // Stamped on arrival so the client can tick it down locally without
            // trusting the two clocks to agree.
            remainingMs: data.remainingMs ?? null,
            remainingAt: data.remainingMs === undefined ? null : Date.now(),
            ...applyOps(state.preview, state.previewDropped, data.ops),
            notice: null,
          }));
        });

        es.addEventListener('status', (event) => {
          const data = JSON.parse((event as MessageEvent<string>).data) as {
            status: JobStatus;
            docUrl?: string | null;
          };
          set((state) => ({ phase: data.status, docUrl: data.docUrl ?? state.docUrl }));
        });

        es.addEventListener('retry', (event) => {
          const data = JSON.parse((event as MessageEvent<string>).data) as {
            attempt: number;
            delayMs: number;
            httpStatus?: number;
          };
          const reason = data.httpStatus === 429 ? 'Google is rate limiting' : 'Google hiccuped';
          set({
            notice: `${reason} — retrying in ${Math.round(data.delayMs / 1000)}s (attempt ${data.attempt}/5).`,
          });
        });

        es.addEventListener('done', (event) => {
          const data = JSON.parse((event as MessageEvent<string>).data) as {
            status: JobStatus;
            charsWritten: number;
            totalChars: number;
            docUrl: string | null;
          };
          set((state) => ({
            phase: data.status,
            charsWritten: data.charsWritten,
            totalChars: data.totalChars,
            pct: data.status === 'done' ? 100 : state.pct,
            docUrl: data.docUrl ?? state.docUrl,
            notice: null,
          }));
          get().detachStream();
        });

        es.addEventListener('error', (event) => {
          // Two very different things arrive here: a job-level error event
          // from the server (which carries data) and a transport drop (which
          // does not). Only the first is fatal.
          const data = (event as MessageEvent<string>).data;
          if (data) {
            const payload = JSON.parse(data) as { message: string; code?: string };
            set({ phase: 'failed', error: payload.message, notice: null });
            get().detachStream();
            return;
          }
          if (es.readyState === EventSource.CLOSED) {
            set({ connection: 'idle' });
            return;
          }
          // EventSource reconnects on its own and replays via Last-Event-ID.
          set({ connection: 'reconnecting', notice: 'Reconnecting to the live stream…' });
        });
      },

      detachStream() {
        if (source) {
          source.close();
          source = null;
        }
        attachedJobId = null;
        set({ connection: 'idle' });
      },

      resetJob() {
        get().detachStream();
        set({
          jobId: null,
          docUrl: null,
          phase: 'idle',
          pct: 0,
          charsWritten: 0,
          charsPerMinute: 0,
          estimatedMs: null,
          remainingMs: null,
          remainingAt: null,
          resting: false,
          preview: '',
          previewDropped: 0,
          error: null,
          notice: null,
        });
      },
    }),
    {
      name: 'turtletype',
      // A half-typed 40k paste should survive an accidental refresh, and a
      // running job should be re-attachable. Nothing else is worth keeping.
      partialize: (state) => ({
        text: state.text,
        durationMs: state.durationMs,
        docMode: state.docMode,
        docUrlInput: state.docUrlInput,
        // Worth keeping for the same reason as the pasted link: a refresh
        // should not send the user back through the picker. The grant behind
        // it belongs to the account, not the tab.
        selectedDoc: state.selectedDoc,
        jobId: TERMINAL.includes(state.phase) ? null : state.jobId,
      }),
    },
  ),
);

export const isTerminal = (phase: Phase): boolean => TERMINAL.includes(phase);
export const isActive = (phase: Phase): boolean =>
  phase === 'running' || phase === 'paused' || phase === 'pending' || phase === 'starting';
