import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ApiError, api, loginUrl, streamUrl, type CurrentUser, type JobStatus } from '../lib/api';
import { openPicker, PickerUnavailableError, parseDocId, type PickedDoc } from '../lib/picker';

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
  /**
   * The document the user handed over through the Google Picker.
   *
   * Under `drive.file` this is the only way an existing document becomes
   * writable — the pasted link in `docUrlInput` is a navigation hint for the
   * picker, never permission by itself. So a job in 'existing' mode is not
   * startable until this is set.
   */
  pickedDoc: PickedDoc | null;
  pickerBusy: boolean;
  pickerError: string | null;
  /** False when the deploy has no Picker API key, so the UI can say why. */
  pickerAvailable: boolean;

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
  /** Opens the Google Picker so Google can grant access to one document. */
  chooseDoc: () => Promise<void>;
  clearPickedDoc: () => void;
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
      pickedDoc: null,
      pickerBusy: false,
      pickerError: null,
      pickerAvailable: true,

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
      /**
       * Editing the link drops the picked document. Keeping it would leave the
       * box showing one document while the job wrote into another, and the
       * grant belongs to the document that was picked, not to the text here.
       */
      setDocUrlInput: (docUrlInput) => set({ docUrlInput, pickedDoc: null, pickerError: null }),

      /**
       * Hands the picker to Google and keeps whatever comes back.
       *
       * A link already in the box pre-navigates the picker to that file, so
       * the habit of pasting a URL still works — it just ends in Google
       * granting access to that one document rather than in this app assuming
       * it has access it was never given.
       */
      async chooseDoc() {
        if (get().pickerBusy) return;
        set({ pickerBusy: true, pickerError: null });

        try {
          const session = await api.pickerSession();
          if (!session.configured) {
            set({ pickerAvailable: false });
            throw new PickerUnavailableError(
              'Choosing an existing document is unavailable on this deployment. ' +
                'Create a new document instead.',
            );
          }
          set({ pickerAvailable: true });

          const hinted = parseDocId(get().docUrlInput);
          const picked = await openPicker(session, hinted ? { fileIds: [hinted] } : {});
          // Null means they closed it without choosing; leave everything as it was.
          if (picked) set({ pickedDoc: picked, docUrlInput: picked.url });
        } catch (error) {
          // A grant that predates the drive.file migration cannot open a
          // picker at all. One trip through consent fixes it permanently, so
          // go there rather than showing an error nobody can act on.
          if (error instanceof ApiError && error.code === 'REAUTH_REQUIRED') {
            window.location.href = loginUrl('/app');
            return;
          }
          set({
            pickerError:
              error instanceof PickerUnavailableError || error instanceof ApiError
                ? error.message
                : 'Could not open Google Drive. Please try again.',
          });
        } finally {
          set({ pickerBusy: false });
        }
      },

      clearPickedDoc: () => set({ pickedDoc: null, docUrlInput: '', pickerError: null }),

      async startJob() {
        const { text, durationMs, docMode, pickedDoc } = get();
        if (!text.trim() || get().phase === 'starting') return;
        // Belt and braces: the button is disabled without one, but sending a
        // pasted ID under `drive.file` would only fail at the first write.
        if (docMode === 'existing' && !pickedDoc) {
          set({ pickerError: 'Choose the document from Google Drive first.' });
          return;
        }

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
            // Always the ID the picker returned — the one Google actually
            // granted access to — never whatever is in the paste box.
            ...(docMode === 'existing' && pickedDoc ? { docId: pickedDoc.id } : {}),
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
        // The grant lives with Google and outlives the tab, so a picked
        // document survives a refresh the same way the composer text does.
        pickedDoc: state.pickedDoc,
        jobId: TERMINAL.includes(state.phase) ? null : state.jobId,
      }),
    },
  ),
);

export const isTerminal = (phase: Phase): boolean => TERMINAL.includes(phase);
export const isActive = (phase: Phase): boolean =>
  phase === 'running' || phase === 'paused' || phase === 'pending' || phase === 'starting';
