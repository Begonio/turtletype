import type { Response } from 'express';
import type { JobStatus } from '../db/types.js';

/** Op shapes sent to the browser so the preview can mirror the document. */
export type WireOp = { kind: 'insert'; text: string } | { kind: 'delete'; count: number };

export type JobEvent =
  | {
      type: 'progress';
      status: JobStatus;
      pct: number;
      charsWritten: number;
      totalChars: number;
      charsPerMinute: number;
      ops: WireOp[];
    }
  | { type: 'status'; status: JobStatus; docUrl?: string | null }
  | { type: 'retry'; attempt: number; delayMs: number; httpStatus?: number }
  | { type: 'done'; status: JobStatus; charsWritten: number; totalChars: number; docUrl: string | null }
  | { type: 'error'; message: string; code?: string; status: JobStatus };

interface StoredEvent {
  id: number;
  event: JobEvent;
}

/** How many past events are kept for Last-Event-ID replay after a reconnect. */
const REPLAY_BUFFER = 100;

/** How long a finished job's channel stays around so late subscribers still see the outcome. */
const CHANNEL_TTL_MS = 5 * 60_000;

const HEARTBEAT_MS = 15_000;

class JobChannel {
  private subscribers = new Set<Response>();
  private history: StoredEvent[] = [];
  private nextId = 1;
  private terminal = false;
  private reaper: NodeJS.Timeout | null = null;

  constructor(readonly jobId: string) {}

  get isTerminal(): boolean {
    return this.terminal;
  }

  emit(event: JobEvent): void {
    const stored: StoredEvent = { id: this.nextId++, event };
    this.history.push(stored);
    if (this.history.length > REPLAY_BUFFER) this.history.shift();

    const frame = `id: ${stored.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of this.subscribers) {
      try {
        res.write(frame);
      } catch {
        this.subscribers.delete(res);
      }
    }

    if (event.type === 'done' || event.type === 'error') {
      this.terminal = true;
      // Keep the channel briefly: a client that reconnects a moment later
      // still learns how the job ended instead of hanging on an empty stream.
      this.reaper = setTimeout(() => channels.delete(this.jobId), CHANNEL_TTL_MS);
      this.reaper.unref?.();
    }
  }

  subscribe(res: Response, lastEventId: number | null): () => void {
    this.subscribers.add(res);

    // Replay anything the client missed while it was disconnected.
    const missed = lastEventId === null ? [] : this.history.filter((item) => item.id > lastEventId);
    for (const item of missed) {
      res.write(`id: ${item.id}\nevent: ${item.event.type}\ndata: ${JSON.stringify(item.event)}\n\n`);
    }

    const heartbeat = setInterval(() => {
      // A bare comment keeps proxies and load balancers from reaping an idle
      // stream (a job can legitimately sit quiet during a long pause).
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    return () => {
      clearInterval(heartbeat);
      this.subscribers.delete(res);
    };
  }

  dispose(): void {
    if (this.reaper) clearTimeout(this.reaper);
    for (const res of this.subscribers) {
      try {
        res.end();
      } catch {
        // already closed
      }
    }
    this.subscribers.clear();
  }
}

const channels = new Map<string, JobChannel>();

export function getChannel(jobId: string): JobChannel {
  let channel = channels.get(jobId);
  if (!channel) {
    channel = new JobChannel(jobId);
    channels.set(jobId, channel);
  }
  return channel;
}

export function peekChannel(jobId: string): JobChannel | undefined {
  return channels.get(jobId);
}

export function emitJobEvent(jobId: string, event: JobEvent): void {
  getChannel(jobId).emit(event);
}

export function disposeAllChannels(): void {
  for (const channel of channels.values()) channel.dispose();
  channels.clear();
}

export type { JobChannel };
