import { InjectionToken } from '@angular/core';

/**
 * The part of `EventSource` this application uses, named so a spec can hand over something else.
 *
 * Angular ships no server-sent-event client and there is nothing to mock in `HttpTestingController`
 * — an `EventSource` is opened by the browser and never goes through `HttpClient`. So the seam has
 * to be the constructor itself, and this interface is what both sides of it agree on. It is
 * deliberately smaller than the real thing: no `addEventListener`, because every stream on this
 * screen is unnamed-event-only, and no `withCredentials`, because everything is same-origin.
 */
export interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  readonly readyState: number;
  close(): void;
}

/** `EventSource.CLOSED` — the browser has given up and will not retry by itself. */
export const EVENT_SOURCE_CLOSED = 2;

/** Opens a stream at a URL. One function, so a fake is one function. */
export type EventSourceFactory = (url: string) => EventSourceLike;

/**
 * How this application opens a live stream.
 *
 * A token rather than a bare `new EventSource(url)` for one reason, and it is the same reason
 * {@link ./api-base#QITS_API_BASE} is one: the streams carry the behaviour most worth testing on
 * this screen — invalidate-everything-on-connect, rebuild-from-replay, the terminal frame — and
 * none of it is reachable without driving `onopen` and `onmessage` by hand.
 */
export const EVENT_SOURCE_FACTORY = new InjectionToken<EventSourceFactory>('qits.event-source', {
  providedIn: 'root',
  factory: () => (url: string) => new EventSource(url) as EventSourceLike,
});
