import { InjectionToken } from '@angular/core';

/**
 * The part of `WebSocket` this application uses, named so a spec can hand over something else.
 *
 * The same seam `EVENT_SOURCE_FACTORY` is, for the same reason: a socket is opened by the browser
 * and never goes through `HttpClient`, so `HttpTestingController` has nothing to intercept. It is
 * deliberately smaller than the real thing — no `binaryType`, because both of this daemon's sockets
 * are text, and no `addEventListener`, because one handler each is all anything here sets.
 *
 * `close()` takes no arguments on purpose. The client never closes with a code; only the *server's*
 * code is read, and a 1000 from the server means something this client must not be able to fake.
 */
export interface WebSocketLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  readonly readyState: number;
  send(data: string): void;
  close(): void;
}

/** `WebSocket.OPEN` — the only state in which {@link WebSocketLike.send} is allowed to be called. */
export const WEB_SOCKET_OPEN = 1;

/** Opens a socket at an absolute `ws://` or `wss://` URL. One function, so a fake is one function. */
export type WebSocketFactory = (url: string) => WebSocketLike;

/**
 * How this application opens a socket.
 *
 * The behaviour worth testing on the chat socket is all in its edges — the replay that arrives on
 * every open, the queue that survives a drop, the reconnect a send while closed provokes — and none
 * of it is reachable without driving `onopen`, `onmessage` and `onclose` by hand.
 */
export const WEB_SOCKET_FACTORY = new InjectionToken<WebSocketFactory>('qits.web-socket', {
  providedIn: 'root',
  factory: () => (url: string) => new WebSocket(url) as WebSocketLike,
});
