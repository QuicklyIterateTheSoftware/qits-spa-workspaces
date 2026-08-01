import { Injectable, inject, signal, type Signal } from '@angular/core';
import { QITS_API_BASE } from '../../api/api-base';
import type { TechnicalProcessFrame } from '../../api/dto';
import {
  EVENT_SOURCE_CLOSED,
  EVENT_SOURCE_FACTORY,
  type EventSourceLike,
} from '../../api/event-source';

/** One named stage of the operation, and how it went. */
export interface ProcessSegment {
  readonly name: string;
  readonly lines: readonly string[];
  readonly status: 'running' | 'ok' | 'failed';
  /** A failure classification, on a failed segment that carried one. */
  readonly hint: string | null;
  /** What the hint applies to — for `remote-auth`, the repository to sign into. */
  readonly hintTarget: string | null;
}

/**
 * Where the whole operation stands.
 *
 * `expired` is its own state and not a kind of failure: the stream ended without a terminal frame,
 * which means the process was evicted server-side rather than that the work went wrong. Collapsing
 * it into `failed` would report a failure that may not have happened, and collapsing it into
 * `running` would leave a finished operation spinning forever.
 */
export type ProcessOutcome = 'running' | 'ok' | 'failed' | 'expired';

/**
 * One technical process's payload-bearing log stream.
 *
 * Separate from the workspace's hint channel on purpose: that one says only "a process started", and
 * the log itself is far too much data to put on a channel every panel listens to.
 *
 * **Every connect rebuilds from scratch.** The server replays all buffered segments and lines with
 * fresh ordinals on each connect and then goes live, so {@link handleOpen} clears the local state and
 * lets the replay refill it. This is the intended contract, not a fallback for a missing diff
 * protocol — `seq` orders one connection's frames and is never a resume token.
 *
 * **A stream that closes without a terminal frame is a distinct state.** An unknown or evicted id
 * answers 404, which the browser treats as fatal rather than retrying, and that lands on
 * {@link ProcessOutcome} `expired` — otherwise an expired process is indistinguishable from one still
 * running. A close *with* a terminal frame is ordinary: the source is closed from here, because the
 * server completing the stream is not what stops the browser reconnecting.
 */
@Injectable()
export class ProcessLog {
  private readonly base = inject(QITS_API_BASE);
  private readonly openStream = inject(EVENT_SOURCE_FACTORY);

  private readonly stages = signal<readonly ProcessSegment[]>([]);
  private readonly state = signal<ProcessOutcome>('running');

  /** The segments, in the order the process opened them. */
  readonly segments: Signal<readonly ProcessSegment[]> = this.stages.asReadonly();

  /** Where the operation stands. */
  readonly outcome: Signal<ProcessOutcome> = this.state.asReadonly();

  private source: EventSourceLike | null = null;
  private attached: string | null = null;
  private settled: (() => void) | null = null;

  /**
   * Follow one process. Re-attaching to the same id does nothing; a different id starts over.
   *
   * `onSettled` fires once, on the terminal frame, and is how the host learns that the container,
   * the working tree and the command list all just changed.
   */
  attach(processId: string, onSettled: () => void): void {
    if (this.attached === processId && this.source) {
      return;
    }
    this.detach();
    this.attached = processId;
    this.settled = onSettled;
    this.state.set('running');
    const source = this.openStream(
      `${this.base}/workspaces/api/technical-processes/${encodeURIComponent(processId)}/events`,
    );
    source.onopen = () => this.handleOpen();
    source.onmessage = (event) => this.handleFrame(event.data);
    source.onerror = () => this.handleError();
    this.source = source;
  }

  /** Stop following. The final state stays on screen; only the connection goes. */
  detach(): void {
    this.source?.close();
    this.source = null;
    this.attached = null;
    this.settled = null;
  }

  private handleOpen(): void {
    this.stages.set([]);
    this.state.set('running');
  }

  private handleFrame(data: string): void {
    let frame: TechnicalProcessFrame;
    try {
      frame = JSON.parse(data) as TechnicalProcessFrame;
    } catch {
      // A frame this build cannot read is not a reason to stop reading the rest of them.
      return;
    }
    switch (frame.kind) {
      case 'segment-open':
        this.openSegment(frame.segment);
        break;
      case 'line':
        this.appendLine(frame.segment, frame.line);
        break;
      case 'segment-settled':
        this.settleSegment(frame);
        break;
      case 'done':
        this.finish(frame.status === 'failed' ? 'failed' : 'ok');
        break;
      default:
        // `ping`, and anything a newer service invents.
        break;
    }
  }

  private handleError(): void {
    if (this.state() !== 'running') {
      return;
    }
    if (this.source?.readyState === EVENT_SOURCE_CLOSED) {
      this.state.set('expired');
    }
    // Anything else is the browser about to retry, and a retry replays everything.
  }

  private openSegment(name: string | null): void {
    if (!name) {
      return;
    }
    this.stages.update((segments) =>
      segments.some((segment) => segment.name === name)
        ? segments
        : [...segments, { name, lines: [], status: 'running', hint: null, hintTarget: null }],
    );
  }

  private appendLine(name: string | null, line: string | null): void {
    if (!name || line === null) {
      return;
    }
    this.openSegment(name);
    this.stages.update((segments) =>
      segments.map((segment) =>
        segment.name === name ? { ...segment, lines: [...segment.lines, line] } : segment,
      ),
    );
  }

  private settleSegment(frame: TechnicalProcessFrame): void {
    const name = frame.segment;
    if (!name) {
      return;
    }
    this.openSegment(name);
    this.stages.update((segments) =>
      segments.map((segment) =>
        segment.name === name
          ? {
              ...segment,
              status: frame.status === 'failed' ? 'failed' : 'ok',
              hint: frame.hint,
              hintTarget: frame.hintTarget,
            }
          : segment,
      ),
    );
  }

  private finish(outcome: ProcessOutcome): void {
    this.state.set(outcome);
    const settled = this.settled;
    this.source?.close();
    this.source = null;
    this.settled = null;
    settled?.();
  }
}
