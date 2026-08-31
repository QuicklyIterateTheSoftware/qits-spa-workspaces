import { InjectionToken } from '@angular/core';

/**
 * The part of `window.location` this page uses, named so a spec can hand over something else.
 *
 * The same seam {@link ../api/event-source#EVENT_SOURCE_FACTORY} is, for the same reason: the
 * hand-off to the editor is a **full** navigation — the editor lives on another origin and is not
 * a route — so it goes through `location.assign` and never through the router. A spec that let
 * that run would navigate the test runner out of the page it is asserting on.
 *
 * Reading the hostname sits on the same token because it is the same object in production and the
 * same fake in a spec: the origin this page sends a reader to is *derived from the one it is
 * served on* (see {@link editorOrigin}), so the two halves are one seam or neither is.
 */
export interface BrowserLocation {
  /** The host of the page as it was served, without the port — `workspaces.qits.dev.example.eu`. */
  hostname(): string;

  /** Leave for another origin. Nothing after this call runs in a real browser. */
  assign(url: string): void;
}

/** How this application leaves for an origin the router does not own. */
export const BROWSER_LOCATION = new InjectionToken<BrowserLocation>('qits.browser-location', {
  providedIn: 'root',
  factory: () => ({
    hostname: () => location.hostname,
    assign: (url: string) => location.assign(url),
  }),
});

/**
 * Where a project's editor answers, derived from the address this page was served on.
 *
 * **From the host and never from configuration.** Every platform host is
 * `<app>.<project>.<environment>.<domain>`, so this page's own hostname already states the
 * environment and the domain the reader is in — and a configured base would be a second answer to
 * that question, one that a `dev` deployment could hold pointing at production. Dropping the first
 * two labels drops *this* application and *this* project and leaves the environment's domain, which
 * `editor.<slug>` is then put in front of. The slug is passed rather than reused from the hostname
 * because an unscoped address serves this page too, and the project it names is the scope's.
 *
 * `null` when there is no domain left after the first two labels — `localhost` under `ng serve` is
 * the case that produces it. A hand-off cannot be built there, and the page says so rather than
 * sending anyone to `https://editor.qits./`.
 */
export function editorOrigin(hostname: string, projectSlug: string): string | null {
  const labels = hostname.split('.');
  if (labels.length < 3 || projectSlug === '') {
    return null;
  }
  return `https://editor.${projectSlug}.${labels.slice(2).join('.')}/`;
}
