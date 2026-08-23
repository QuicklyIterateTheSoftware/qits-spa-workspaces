import { WEB_SOCKET_OPEN, type WebSocketLike } from '../../api/web-socket';
import { TERMINAL_BACKOFF_MS, TerminalSocket } from './terminal-socket';

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
  }

  connect(): void {
    this.readyState = WEB_SOCKET_OPEN;
    this.onopen?.(new Event('open'));
  }

  deliver(text: string): void {
    this.onmessage?.(new MessageEvent<string>('message', { data: text }));
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code }));
  }
}

/**
 * The terminal attachment, in the terms its failures set.
 *
 * Every rule asserted here was learned from a real failure: a clean close that must not be retried
 * into a loop, a dirty close that must be, a screen that must be cleared before a replay repaints
 * it, and a budget that must come back when the laptop does.
 */
describe('TerminalSocket', () => {
  let sockets: FakeSocket[];
  let terminals: TerminalSocket[];
  const open = (url: string) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket;
  };

  beforeEach(() => {
    sockets = [];
    terminals = [];
    vi.useFakeTimers();
  });

  // Closing is what removes the wake listeners. A terminal left attached would go on re-arming on
  // the next test's `visibilitychange`, which is the same leak a panel would have without a destroy
  // hook — worth having the suite prove rather than tolerate.
  afterEach(() => {
    terminals.forEach((terminal) => terminal.close());
    vi.useRealTimers();
  });

  const attach = () => {
    const terminal = new TerminalSocket('ws://host/terminal/commands/c1', open, document);
    terminals.push(terminal);
    terminal.connect();
    return terminal;
  };

  it('tells the PTY its size on open, so it is never an 80x24 guess', () => {
    const terminal = attach();
    terminal.resize(120, 40);
    sockets[0].connect();
    expect(sockets[0].sent).toContain(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  });

  it('preserves raw PTY frames for xterm.js', () => {
    const terminal = attach();
    sockets[0].connect();
    sockets[0].deliver('hello\r\nagent');
    expect(terminal.frames().chunks).toEqual(['hello\r\nagent']);
  });

  it('sends keystrokes as data frames, and drops them while detached', () => {
    const terminal = attach();
    terminal.send('x');
    expect(sockets[0].sent).toEqual([]);
    sockets[0].connect();
    terminal.send('x');
    expect(sockets[0].sent).toContain(JSON.stringify({ type: 'data', data: 'x' }));
  });

  it('treats a clean server close as final and never reconnects into it', () => {
    const terminal = attach();
    sockets[0].connect();
    sockets[0].serverClose(1000);
    vi.advanceTimersByTime(30_000);
    expect(terminal.status()).toBe('disconnected');
    expect(sockets).toHaveLength(1);
  });

  it('reconnects on any other close, resetting the screen so the replay repaints it', () => {
    const terminal = attach();
    sockets[0].connect();
    sockets[0].deliver('the old frame');
    sockets[0].serverClose(1006);
    expect(terminal.status()).toBe('reconnecting');
    vi.advanceTimersByTime(TERMINAL_BACKOFF_MS[0]);
    expect(sockets).toHaveLength(2);
    expect(terminal.frames().chunks).toEqual([]);
  });

  it('spends its budget and then says so rather than retrying forever', () => {
    const terminal = attach();
    for (let attempt = 0; attempt <= TERMINAL_BACKOFF_MS.length; attempt++) {
      sockets[sockets.length - 1].serverClose(1006);
      vi.advanceTimersByTime(10_000);
    }
    expect(terminal.status()).toBe('lost');
    expect(sockets).toHaveLength(TERMINAL_BACKOFF_MS.length + 1);
  });

  it('re-arms a spent budget when the page comes back, because a sleep outlives the window', () => {
    const terminal = attach();
    for (let attempt = 0; attempt <= TERMINAL_BACKOFF_MS.length; attempt++) {
      sockets[sockets.length - 1].serverClose(1006);
      vi.advanceTimersByTime(10_000);
    }
    const spent = sockets.length;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sockets.length).toBe(spent + 1);
    expect(terminal.status()).toBe('connecting');
  });

  it('closing detaches and stops the retries; it does not terminate anything', () => {
    const terminal = attach();
    sockets[0].connect();
    terminal.close();
    expect(sockets[0].closedByClient).toBe(true);
    expect(terminal.status()).toBe('disconnected');
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(30_000);
    expect(sockets).toHaveLength(1);
  });
});
