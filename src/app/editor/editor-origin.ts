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
 * **From the host and never from configuration.** This application's public host is
 * `<app>.<domain>` — `workspaces.wohlben.eu` — because the edge reads only the FIRST label as the
 * application and the editor is a default-environment feature. So the page's own hostname states
 * the domain after exactly ONE label, and `editor.<slug>` is put in front of what remains. A
 * configured base would be a second answer to that question, one a `dev` deployment could hold
 * pointing at production.
 *
 * This function shipped dropping TWO labels — written against a
 * `<app>.<project>.<environment>.<domain>` host shape no deployment serves — and the first real
 * click paid for it: served on `workspaces.wohlben.eu` it dropped `workspaces` AND `wohlben` and
 * sent the reader to `https://editor.qits.eu/`, somebody else's domain. The host model above is
 * the deployed one, verified against the edge's `$app.$domain` reading and the live navigation
 * document.
 *
 * The slug is passed rather than reused from the hostname because an unscoped address serves this
 * page too, and the project it names is the scope's.
 *
 * `null` when nothing is left after the app label — `localhost` under `ng serve` is the case that
 * produces it. A hand-off cannot be built there, and the page says so rather than sending anyone
 * to `https://editor.qits./`.
 */
export function editorOrigin(hostname: string, projectSlug: string): string | null {
  const labels = hostname.split('.');
  if (labels.length < 2 || projectSlug === '') {
    return null;
  }
  return `https://editor.${projectSlug}.${labels.slice(1).join('.')}/`;
}
