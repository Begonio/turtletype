import { config } from '../config.js';
import { finishJob } from '../db/jobs.js';
import { emitJobEvent } from './events.js';
import { JobRunner, type JobSpec } from './runner.js';

/**
 * In-memory job queue.
 *
 * Jobs are long-lived (a 5,000 character document at normal speed runs for
 * roughly ten minutes), so the process caps how many replay at once. Anything
 * over the cap waits in 'pending' and starts the moment a slot frees.
 *
 * Deliberately not durable: a restart cannot resume a half-typed document
 * safely, so boot marks orphaned jobs failed instead of pretending otherwise.
 */
class JobQueue {
  private readonly active = new Map<string, JobRunner>();
  private readonly waiting: JobSpec[] = [];

  get activeCount(): number {
    return this.active.size;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  enqueue(spec: JobSpec): { started: boolean; queuePosition: number } {
    if (this.active.size < config.jobs.maxConcurrentJobs) {
      this.start(spec);
      return { started: true, queuePosition: 0 };
    }
    this.waiting.push(spec);
    return { started: false, queuePosition: this.waiting.length };
  }

  private start(spec: JobSpec): void {
    const runner = new JobRunner(spec);
    this.active.set(spec.jobId, runner);

    void runner
      .run()
      .catch((error) => {
        // JobRunner.run handles its own failures; this is the last line of
        // defence against an unhandled rejection taking the process down.
        console.error(`[queue] job ${spec.jobId} threw out of run():`, error);
        return finishJob(spec.jobId, 'failed', 'Internal error').catch(() => {});
      })
      .finally(() => {
        this.active.delete(spec.jobId);
        this.drain();
      });
  }

  private drain(): void {
    while (this.active.size < config.jobs.maxConcurrentJobs) {
      const next = this.waiting.shift();
      if (!next) return;
      this.start(next);
    }
  }

  get(jobId: string): JobRunner | undefined {
    return this.active.get(jobId);
  }

  /** True if the job is queued but has not started replaying yet. */
  isWaiting(jobId: string): boolean {
    return this.waiting.some((spec) => spec.jobId === jobId);
  }

  /**
   * Cancels a running job, or drops a queued one before it ever starts.
   * Returns false when the job is not known to this process.
   */
  async cancel(jobId: string): Promise<boolean> {
    const runner = this.active.get(jobId);
    if (runner) {
      runner.cancel();
      return true;
    }

    const index = this.waiting.findIndex((spec) => spec.jobId === jobId);
    if (index === -1) return false;

    const [spec] = this.waiting.splice(index, 1);
    if (!spec) return false;
    await finishJob(jobId, 'cancelled');
    emitJobEvent(jobId, {
      type: 'done',
      status: 'cancelled',
      charsWritten: 0,
      totalChars: spec.text.length,
      docUrl: spec.docUrl,
    });
    return true;
  }

  pause(jobId: string): boolean {
    const runner = this.active.get(jobId);
    if (!runner) return false;
    runner.pause();
    return true;
  }

  resume(jobId: string): boolean {
    const runner = this.active.get(jobId);
    if (!runner) return false;
    runner.resume();
    return true;
  }

  /** Cancels everything on shutdown so in-flight jobs stop cleanly. */
  async shutdown(): Promise<void> {
    this.waiting.length = 0;
    const runners = [...this.active.values()];
    for (const runner of runners) runner.cancel();
    // Give the cancel path a moment to write its final state.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export const jobQueue = new JobQueue();
