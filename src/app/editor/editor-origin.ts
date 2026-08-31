import { InjectionToken } from '@angular/core';

/**
 * The part of `window.location` this page uses, named so a spec can hand over something else.
 *
 * The same seam {@link ../api/event-source#EVENT_SOURCE_FACTORY} is, for the same reason: the
 * hand-off to the editor is a **full** navigation — the editor lives on another origin and is not
 * a route — so it goes through `location.assign` and never through the router. A spec that let
 * that run would navigate the test runner out of the page it is asserting on.
 */
export interface BrowserLocation {
  /** The host of the page as it was served, without the port. */
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
 * Where a project's editor answers: `editor.<slug>.` in front of the ENVIRONMENT'S OWN ORIGIN, as
 * the platform states it.
 *
 * **The environment origin comes from the edge's navigation document** (`/main-navigation`,
 * `origin` — `EnvironmentAuthority` on the edge side, rooted in the platform's configured domain),
 * which is the same statement every cross-application link in the sidebar is already composed
 * from. Scheme and port travel with it, so a plain-http local platform hands off to plain http.
 *
 * This function has been wrong twice, both times by inventing the domain instead of asking for
 * it: it shipped deriving from `location.hostname` by dropping two labels (a
 * `<app>.<project>.<env>.<domain>` host shape no deployment serves — the first real click landed
 * on `https://editor.qits.eu/`, somebody else's domain), and the corrected label count was still
 * string surgery on this page's own address. The domain is configured — the bootstrap states it,
 * the certificate is ordered against it, the edge publishes it — and the navigation document is
 * where the platform says it to a browser. Ask; never derive.
 *
 * `null` while the platform has not answered (the document not loaded yet, or `ng serve` with no
 * edge in front) and for an empty slug. The page keeps asking rather than guessing.
 */
export function editorOrigin(
  environmentOrigin: string | undefined,
  projectSlug: string,
): string | null {
  if (!environmentOrigin || projectSlug === '') {
    return null;
  }
  let origin: URL;
  try {
    origin = new URL(environmentOrigin);
  } catch {
    return null;
  }
  if (!origin.host) {
    return null;
  }
  return `${origin.protocol}//editor.${projectSlug}.${origin.host}/`;
}
