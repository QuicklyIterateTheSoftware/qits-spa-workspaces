import { TestBed } from '@angular/core/testing';
import type { TechnicalProcessFrame } from '../../api/dto';
import { EVENT_SOURCE_FACTORY, type EventSourceLike } from '../../api/event-source';
import { ProcessLog } from './process-log';

class FakeStream implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  closed = false;

  constructor(readonly url: string) {}

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  connect(): void {
    this.onopen?.(new Event('open'));
  }

  frame(frame: Partial<TechnicalProcessFrame>): void {
    const full: TechnicalProcessFrame = {
      segment: null,
      kind: 'line',
      seq: 0,
      line: null,
      status: null,
      hint: null,
      hintTarget: null,
      ...frame,
    };
    this.onmessage?.(new MessageEvent<string>('message', { data: JSON.stringify(full) }));
  }

  fail(readyState: number): void {
    this.readyState = readyState;
    this.onerror?.(new Event('error'));
  }
}

/**
 * The process stream's two rules, both of which look like shortcuts and are not.
 *
 * **Every connect rebuilds from scratch.** The server replays all buffered segments and lines with
 * fresh ordinals on each connect and then goes live, so appending a replay to what is already on
 * screen would double every line. `seq` orders one connection's frames and is never a resume token —
 * a client that treated it as one would silently drop the replay it needs.
 *
 * **A stream that ends without a terminal frame is its own state.** An unknown or evicted process id
 * answers 404, which the browser treats as fatal rather than retrying. Folding that into "failed"
 * would report a failure that may never have happened; folding it into "running" would leave a
 * finished operation spinning forever. It gets a sentence of its own.
 */
describe('ProcessLog', () => {
  let log: ProcessLog;
  let opened: FakeStream[];

  beforeEach(() => {
    opened = [];
    TestBed.configureTestingModule({
      providers: [
        ProcessLog,
        {
          provide: EVENT_SOURCE_FACTORY,
          useValue: (url: string) => {
            const stream = new FakeStream(url);
            opened.push(stream);
            return stream;
          },
        },
      ],
    });
    log = TestBed.inject(ProcessLog);
  });

  it('attaches to the payload-bearing stream, not to the hint channel', () => {
    log.attach('proc-1', () => undefined);

    expect(opened[0].url).toBe('/workspaces/api/technical-processes/proc-1/events');
  });

  it('builds the segment stack from the frames, in the order they opened', () => {
    log.attach('proc-1', () => undefined);
    const stream = opened[0];
    stream.connect();
    stream.frame({ kind: 'segment-open', segment: 'clone' });
    stream.frame({ kind: 'line', segment: 'clone', line: 'cloning…' });
    stream.frame({ kind: 'segment-settled', segment: 'clone', status: 'ok' });
    stream.frame({ kind: 'segment-open', segment: 'build' });

    expect(log.segments().map((segment) => segment.name)).toEqual(['clone', 'build']);
    expect(log.segments()[0].lines).toEqual(['cloning…']);
    expect(log.segments()[0].status).toBe('ok');
    expect(log.segments()[1].status).toBe('running');
  });

  it('throws away what it has and rebuilds on every reconnect', () => {
    log.attach('proc-1', () => undefined);
    const stream = opened[0];
    stream.connect();
    stream.frame({ kind: 'segment-open', segment: 'clone' });
    stream.frame({ kind: 'line', segment: 'clone', line: 'cloning…' });

    stream.connect();
    stream.frame({ kind: 'segment-open', segment: 'clone' });
    stream.frame({ kind: 'line', segment: 'clone', line: 'cloning…' });

    expect(log.segments()).toHaveLength(1);
    expect(log.segments()[0].lines).toEqual(['cloning…']);
  });

  it('keeps a failed segment’s classification and the target it applies to', () => {
    log.attach('proc-1', () => undefined);
    opened[0].frame({
      kind: 'segment-settled',
      segment: 'submodules',
      status: 'failed',
      hint: 'remote-auth',
      hintTarget: 'qits-spa-ui-components',
    });

    expect(log.segments()[0].hint).toBe('remote-auth');
    expect(log.segments()[0].hintTarget).toBe('qits-spa-ui-components');
  });

  it('settles on the terminal frame, tells the host once, and stops the reconnect', () => {
    let settled = 0;
    log.attach('proc-1', () => (settled += 1));
    opened[0].frame({ kind: 'done', status: 'ok' });

    expect(log.outcome()).toBe('ok');
    expect(settled).toBe(1);
    expect(opened[0].closed).toBe(true);
  });

  it('carries a failed terminal frame through as a failure', () => {
    log.attach('proc-1', () => undefined);
    opened[0].frame({ kind: 'done', status: 'failed' });

    expect(log.outcome()).toBe('failed');
  });

  it('calls a stream that closed with no terminal frame expired, not failed', () => {
    log.attach('proc-1', () => undefined);
    opened[0].fail(2);

    expect(log.outcome()).toBe('expired');
  });

  it('leaves the outcome alone while the browser is still going to retry', () => {
    log.attach('proc-1', () => undefined);
    opened[0].fail(0);

    expect(log.outcome()).toBe('running');
  });

  it('ignores the heartbeat and anything a newer service sends', () => {
    log.attach('proc-1', () => undefined);
    opened[0].frame({ kind: 'ping' });
    opened[0].frame({ kind: 'something-new' as 'line' });

    expect(log.segments()).toEqual([]);
    expect(log.outcome()).toBe('running');
  });

  it('moves to another process and abandons the first', () => {
    log.attach('proc-1', () => undefined);
    log.attach('proc-1', () => undefined);
    expect(opened).toHaveLength(1);

    log.attach('proc-2', () => undefined);

    expect(opened[0].closed).toBe(true);
    expect(opened[1].url).toContain('proc-2');
  });
});
