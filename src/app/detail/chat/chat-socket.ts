import { signal, type Signal } from '@angular/core';
import { WEB_SOCKET_OPEN, type WebSocketFactory, type WebSocketLike } from '../../api/web-socket';

/** How long to wait before re-attaching after a drop. Fixed, not backed off — see the class note. */
export const CHAT_RECONNECT_MS = 1500;

/** Whether the conversation is attached, coming back, or finished. */
export type ChatLink = 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * One attachment to `WS /chat/commands/{id}`.
 *
 * ## Opening replays everything, so re-attaching is the recovery
 *
 * The daemon replays the **whole** conversation on attach — the imported transcript head stitched to
 * its 256 KB ring tail at the first line whose `uuid` the transcript already contains, under the
 * session lock, so every event replays exactly once. That single fact is what makes everything else
 * here trivial: {@link lines} is **reset on every open** and rebuilt from the replay, and there is no
 * diffing, no resume token and no gap to reason about. Rebuilding from scratch is the intended
 * contract rather than a fallback.
 *
 * It is also why the reconnect delay is a flat 1.5 s rather than the terminal socket's backoff
 * ladder. A terminal that reconnects too eagerly repaints a screen; a chat that reconnects too
 * eagerly re-reads a conversation that is already correct. The expensive failure mode is not here.
 *
 * ## A message sent while down is queued, not lost
 *
 * Typing does not stop because a socket did. A send while closed is queued **and provokes an
 * immediate reconnect attempt** rather than waiting out the delay — the person is right there, and
 * the wait exists for an idle drop, not for one the user just noticed. The queue flushes on open,
 * in order.
 *
 * ## The user's turn is never rendered from here
 *
 * {@link send} writes and nothing else. The turn appears when the *server* echoes it back as a
 * synthetic `user` line, which is what guarantees the live view and a later replay show the same
 * things in the same order. An optimistic bubble would be the one place those two could disagree.
 */
export class ChatSocket {
  private readonly received = signal<readonly string[]>([]);
  private readonly link = signal<ChatLink>('connecting');
  private readonly waiting = signal(0);

  /** Every line of the current attachment's replay-plus-live stream, in order. */
  readonly lines: Signal<readonly string[]> = this.received.asReadonly();

  /** Whether the conversation is attached. `reconnecting` means stale, not wrong. */
  readonly status: Signal<ChatLink> = this.link.asReadonly();

  /** How many turns are waiting for the socket to come back. Drawn, so nobody wonders. */
  readonly queued: Signal<number> = this.waiting.asReadonly();

  private socket: WebSocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly queue: string[] = [];
  private stopped = false;

  /**
   * A partial line held back until its newline arrives.
   *
   * The daemon writes the whole replay in one call and each live event in another, but a frame is
   * not a promise about line boundaries — a large replay can be split by any layer between here and
   * there. Buffering the remainder is correct whether or not it ever happens, and half a JSON object
   * is the kind of bug that only shows up on the longest conversation someone has.
   */
  private partial = '';

  constructor(
    private readonly url: string,
    private readonly open: WebSocketFactory,
  ) {}

  /** Attach, and keep re-attaching until {@link close}. */
  connect(): void {
    this.stopped = false;
    this.attach();
  }

  /**
   * Detach for good.
   *
   * Closing the socket only detaches; the agent keeps running server-side, which is the whole reason
   * a tab switch is free. This is called when the panel is destroyed, not when the tab is hidden.
   */
  close(): void {
    this.stopped = true;
    this.clearTimer();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.link.set('closed');
  }

  /**
   * Send a user turn.
   *
   * `{"type":"user","text":…}` is the only frame the server acts on; anything else it ignores.
   */
  send(text: string): void {
    if (!text.trim()) {
      return;
    }
    const frame = JSON.stringify({ type: 'user', text });
    const socket = this.socket;
    if (socket && socket.readyState === WEB_SOCKET_OPEN) {
      socket.send(frame);
      return;
    }
    this.queue.push(frame);
    this.waiting.set(this.queue.length);
    if (!this.stopped) {
      this.reattachNow();
    }
  }

  private attach(): void {
    this.clearTimer();
    this.socket?.close();
    this.partial = '';
    const socket = this.open(this.url);
    this.socket = socket;
    socket.onopen = () => this.handleOpen();
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onclose = () => this.handleClose();
    socket.onerror = () => {
      // A socket error is always followed by a close, and the close is where the retry lives.
      // Handling both would schedule two reconnects for one failure.
    };
  }

  private handleOpen(): void {
    // The replay is about to rebuild the conversation, so whatever the last attachment left is
    // stale by definition. Clearing here rather than on close keeps the old lines on screen while
    // the socket is away, which is what "stale, not wrong" looks like.
    this.received.set([]);
    this.partial = '';
    this.link.set('open');
    const pending = this.queue.splice(0, this.queue.length);
    this.waiting.set(0);
    for (const frame of pending) {
      this.socket?.send(frame);
    }
  }

  private handleMessage(data: string): void {
    const parts = (this.partial + data).split('\n');
    this.partial = parts.pop() ?? '';
    const complete = parts.filter((line) => line.trim().length > 0);
    if (complete.length > 0) {
      this.received.update((lines) => [...lines, ...complete]);
    }
  }

  private handleClose(): void {
    this.socket = null;
    if (this.stopped) {
      this.link.set('closed');
      return;
    }
    this.link.set('reconnecting');
    this.timer = setTimeout(() => this.attach(), CHAT_RECONNECT_MS);
  }

  private reattachNow(): void {
    this.clearTimer();
    if (this.socket) {
      // Already attaching. The open handler flushes whatever is queued by then.
      return;
    }
    this.attach();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
