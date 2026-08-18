import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ApiError, api, loginUrl, streamUrl, type CurrentUser, type JobStatus } from '../lib/api';

export type Phase = 'idle' | 'starting' | JobStatus;
export type DocMode = 'new' | 'existing';
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting';

type WireOp = { kind: 'insert'; text: string } | { kind: 'delete'; count: number };

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
  estimating: boolean;
  humanness: number;
  docMode: DocMode;
  docUrlInput: string;

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
  signOut: () => Promise<void>;
  setText: (text: string) => void;
  setDurationMs: (durationMs: number | null) => void;
  refreshEstimate: () => void;
  setHumanness: (humanness: number) => void;
  setDocMode: (mode: DocMode) => void;
  setDocUrlInput: (value: string) => void;
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

function applyOps(preview: string, ops: WireOp[]): string {
  let next = preview;
  for (const op of ops) {
    if (op.kind === 'insert') next += op.text;
    else next = next.slice(0, Math.max(0, next.length - op.count));
  }
  return next.length > PREVIEW_LIMIT ? next.slice(next.length - PREVIEW_LIMIT) : next;
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
      estimating: false,
      humanness: 0.5,
      docMode: 'new',
      docUrlInput: '',

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
        } catch {
          set({ user: null, authChecked: true });
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
      setHumanness: (humanness) => {
        set({ humanness });
        // Typos add keystrokes, so the floor moves with this too.
        get().refreshEstimate();
      },

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
          set({ minDurationMs: 0, bursts: 0, estimating: false });
          return;
        }

        set({ estimating: true });
        estimateTimer = setTimeout(() => {
          const controller = new AbortController();
          estimateController = controller;
          const requestId = ++estimateRequestId;

          void api
            .estimate({ text: get().text, humanness: get().humanness }, controller.signal)
            .then((estimate) => {
              if (requestId !== estimateRequestId) return;
              set((state) => ({
                minDurationMs: estimate.minDurationMs,
                maxDurationMs: estimate.maxDurationMs,
                bursts: estimate.bursts,
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

      setDocMode: (docMode) => set({ docMode }),
      setDocUrlInput: (docUrlInput) => set({ docUrlInput }),

      async startJob() {
        const { text, durationMs, humanness, docMode, docUrlInput } = get();
        if (!text.trim() || get().phase === 'starting') return;

        get().detachStream();
        set({
          phase: 'starting',
          error: null,
          notice: null,
          preview: '',
          pct: 0,
          charsWritten: 0,
          charsPerMinute: 0,
          totalChars: text.length,
          docUrl: null,
          estimatedMs: null,
        });

        try {
          const response = await api.createJob({
            text,
            humanness,
            // Omitted means "run at the natural minimum", which the server computes.
            ...(durationMs ? { durationMs } : {}),
            ...(docMode === 'existing' && docUrlInput.trim() ? { docId: docUrlInput.trim() } : {}),
          });

          set({
            jobId: response.jobId,
            docUrl: response.docUrl,
            totalChars: response.totalChars,
            estimatedMs: response.estimatedMs,
            minDurationMs: response.minDurationMs,
            bursts: response.bursts,
            phase: response.started ? 'running' : 'pending',
            notice: response.started
              ? null
              : `Queued at position ${response.queuePosition} — it will start automatically.`,
          });

          get().attachStream(response.jobId);
        } catch (error) {
          // A revoked or expired Google grant is not something the user can
          // fix from this screen — send them straight back through consent.
          if (error instanceof ApiError && error.code === 'REAUTH_REQUIRED') {
            window.location.href = loginUrl('/app');
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
            preview: applyOps(state.preview, data.ops),
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
          preview: '',
          error: null,
          notice: null,
        });
      },
    }),
    {
      name: 'humantype',
      // A half-typed 40k paste should survive an accidental refresh, and a
      // running job should be re-attachable. Nothing else is worth keeping.
      partialize: (state) => ({
        text: state.text,
        durationMs: state.durationMs,
        humanness: state.humanness,
        docMode: state.docMode,
        docUrlInput: state.docUrlInput,
        jobId: TERMINAL.includes(state.phase) ? null : state.jobId,
      }),
    },
  ),
);

export const isTerminal = (phase: Phase): boolean => TERMINAL.includes(phase);
export const isActive = (phase: Phase): boolean =>
  phase === 'running' || phase === 'paused' || phase === 'pending' || phase === 'starting';
