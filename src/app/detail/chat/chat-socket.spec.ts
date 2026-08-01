import { WEB_SOCKET_OPEN, type WebSocketLike } from '../../api/web-socket';
import { CHAT_RECONNECT_MS, ChatSocket } from './chat-socket';

/** A socket whose every lifecycle moment is a method call. */
class FakeSocket implements WebSocketLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
  closedByClient = false;
  readonly sent: string[] = [];

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closedByClient = true;
    this.readyState = 3;
  }

  connect(): void {
    this.readyState = WEB_SOCKET_OPEN;
    this.onopen?.(new Event('open'));
  }

  deliver(text: string): void {
    this.onmessage?.(new MessageEvent<string>('message', { data: text }));
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }
}

/**
 * The chat socket's edges, all of which are unreachable from the outside.
 *
 * The one fact everything here rests on is that **opening replays the whole conversation** — the
 * transcript head stitched to the ring tail under the session lock, every event exactly once. That
 * is why the client rebuilds from scratch on every open instead of diffing, and why the reconnect
 * delay is a flat 1.5 s rather than the terminal socket's backoff ladder: re-attaching costs
 * nothing.
 */
describe('ChatSocket', () => {
  let opened: FakeSocket[];
  let socket: ChatSocket;

  const open = (url: string): WebSocketLike => {
    const fake = new FakeSocket(url);
    opened.push(fake);
    return fake;
  };

  const latest = () => opened[opened.length - 1];

  beforeEach(() => {
    vi.useFakeTimers();
    opened = [];
    socket = new ChatSocket('ws://host/workspaces/container/7/chat/commands/c1', open);
  });

  afterEach(() => {
    socket.close();
    vi.useRealTimers();
  });

  it('opens the url it was given and reports itself connecting until it is open', () => {
    socket.connect();
    expect(opened).toHaveLength(1);
    expect(latest().url).toBe('ws://host/workspaces/container/7/chat/commands/c1');
    expect(socket.status()).toBe('connecting');

    latest().connect();
    expect(socket.status()).toBe('open');
  });

  it('splits a multi-line frame into lines and holds a partial one back', () => {
    // The daemon writes the whole replay in one call, but a frame is not a promise about line
    // boundaries. Half a JSON object is the kind of bug that only appears on the longest
    // conversation someone has.
    socket.connect();
    latest().connect();

    latest().deliver('{"a":1}\n{"b":2}\n{"c":');
    expect(socket.lines()).toEqual(['{"a":1}', '{"b":2}']);

    latest().deliver('3}\n');
    expect(socket.lines()).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('rebuilds from the replay on every open rather than appending to what it had', () => {
    socket.connect();
    latest().connect();
    latest().deliver('{"first":true}\n');
    expect(socket.lines()).toHaveLength(1);

    latest().drop();
    // Still on screen while away: the data is stale, not wrong.
    expect(socket.lines()).toHaveLength(1);
    expect(socket.status()).toBe('reconnecting');

    vi.advanceTimersByTime(CHAT_RECONNECT_MS);
    latest().connect();
    expect(socket.lines()).toEqual([]);

    latest().deliver('{"first":true}\n{"second":true}\n');
    expect(socket.lines()).toHaveLength(2);
  });

  it('reconnects after the fixed delay and not before it', () => {
    socket.connect();
    latest().connect();
    latest().drop();

    vi.advanceTimersByTime(CHAT_RECONNECT_MS - 1);
    expect(opened).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(opened).toHaveLength(2);
  });

  it('sends straight through while open, and never optimistically renders the turn', () => {
    socket.connect();
    latest().connect();

    socket.send('do the thing');

    expect(latest().sent).toEqual(['{"type":"user","text":"do the thing"}']);
    // The turn appears when the *server* echoes it. Nothing was added locally.
    expect(socket.lines()).toEqual([]);
  });

  it('queues a message sent while down, and provokes an immediate reconnect for it', () => {
    // The wait exists for an idle drop, not for one the user just noticed by typing into it.
    socket.connect();
    latest().connect();
    latest().drop();

    socket.send('while it was away');

    expect(socket.queued()).toBe(1);
    expect(opened).toHaveLength(2);

    latest().connect();
    expect(latest().sent).toEqual(['{"type":"user","text":"while it was away"}']);
    expect(socket.queued()).toBe(0);
  });

  it('flushes a queue in the order it was typed', () => {
    socket.connect();
    latest().drop();
    socket.send('first');
    socket.send('second');

    latest().connect();

    expect(latest().sent).toEqual([
      '{"type":"user","text":"first"}',
      '{"type":"user","text":"second"}',
    ]);
  });

  it('ignores a blank send rather than queuing an empty turn', () => {
    socket.connect();
    latest().drop();
    socket.send('   ');
    expect(socket.queued()).toBe(0);
  });

  it('stops reconnecting once closed, because closing only detaches this end', () => {
    socket.connect();
    latest().connect();

    socket.close();
    expect(latest().closedByClient).toBe(true);
    expect(socket.status()).toBe('closed');

    vi.advanceTimersByTime(CHAT_RECONNECT_MS * 4);
    expect(opened).toHaveLength(1);
  });
});
