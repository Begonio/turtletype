import type { DocOp } from '../docs/documents.js';
import type { HumanEvent } from './humanize.js';

/**
 * The in-memory window between the typing simulation and Google.
 *
 * The replay loop pushes one event at a time; the flush loop drains whatever
 * accumulated. Runs of the same kind coalesce as they arrive, so a window of
 * 40 keystrokes leaves the buffer as a single insert rather than 40 of them.
 */
export class TypingBuffer {
  private ops: DocOp[] = [];

  get length(): number {
    return this.ops.length;
  }

  get isEmpty(): boolean {
    return this.ops.length === 0;
  }

  /**
   * Only appends land here. Pauses carry no document change, and repairs
   * target a position inside already-written text, so the runner sends those
   * itself rather than letting them queue behind pending appends.
   */
  push(event: HumanEvent): void {
    if (event.type === 'pause' || event.type === 'repair') return;

    const last = this.ops[this.ops.length - 1];
    if (event.type === 'type') {
      if (last?.kind === 'insert') last.text += event.char;
      else this.ops.push({ kind: 'insert', text: event.char });
      return;
    }

    if (last?.kind === 'delete') last.count += event.count;
    else this.ops.push({ kind: 'delete', count: event.count });
  }

  /** Hands over everything buffered and starts a fresh window. */
  drain(): DocOp[] {
    const ops = this.ops;
    this.ops = [];
    return ops;
  }
}
