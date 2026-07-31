import { InjectionToken } from '@angular/core';

/**
 * The origin every request in this app is built on, and it is empty on purpose.
 *
 * The SPA is served at `/workspaces/` by qits-workspaces itself, behind the same gateway that
 * serves `/projects/api/…` — so a same-origin absolute path is not a shortcut, it is the whole
 * reason the browser's session cookie reaches both services with no machine token and no CORS
 * pre-flight. A configured base URL would move these calls cross-origin and lose exactly that.
 *
 * It is a token rather than a constant for one reason: a spec needs a seam to assert the path
 * against, and `ng serve` (no gateway in front) may want the dev proxy's prefix.
 *
 * Duplicated from qits-spa-ci/qits-spa-cd rather than shared, per the explorer plan's Decision 2:
 * the alternative is a transport dependency inside a *components* library that seven other SPAs
 * consume without making a single request.
 */
export const QITS_API_BASE = new InjectionToken<string>('qits.api-base', {
  providedIn: 'root',
  factory: () => '',
});
