import { HttpErrorResponse } from '@angular/common/http';
import type { IntegrateResponse } from '../api/dto';
import { describeError, serverMessage, statusOf } from '../ui/loadable';

/**
 * Why an integrate did not happen — and the five answers are five different things a person does
 * something different about, which is the whole reason this type exists instead of one red box.
 *
 * - `conflict` — the branch does not apply to the default branch. Resolve it in the workspace and
 *   integrate again. **Nothing was released and nothing moved**, which is a property of the flow
 *   rather than a hope: the merge happens in a detached worktree and only the final push moves a
 *   ref, so a conflict leaves the default branch byte-identical.
 * - `moved` — another integrate landed first and this one's push was rejected as non-fast-forward.
 *   Pressing Integrate again is the whole fix; the same summary is kept for exactly that.
 * - `already-integrated` — this branch is already an ancestor of the default branch. The work is
 *   in. This is what a lost 200 looks like on retry, and it is deliberately **not** an error to
 *   apologise for: the right response is to refresh the list and see the workspace resolved.
 * - `refused` — the service declined for some other reason it stated: a blank summary, an unknown
 *   workspace, a workspace that is not ACTIVE, or the git host refusing the push. Its own sentence
 *   is the most useful thing on screen, so it is shown verbatim.
 * - `unavailable` — the request never got an answer, or the service failed. Nothing is known about
 *   whether anything happened; refresh before assuming either way.
 */
export type IntegrateFailureKind =
  'conflict' | 'moved' | 'already-integrated' | 'refused' | 'unavailable';

/** A failed integrate, classified, with whatever the service said about it. */
export interface IntegrateFailure {
  readonly kind: IntegrateFailureKind;
  /** The HTTP status, or 0 when the request never reached a server. */
  readonly status: number;
  /** The service's own sentence, always shown — the classification never replaces it. */
  readonly message: string;
  /** The conflicted paths, when the service listed them structurally. Empty otherwise. */
  readonly conflicts: readonly string[];
}

/**
 * The discriminator this client prefers, and the reason it is optional.
 *
 * The three 409s are genuinely different outcomes, but every qits service maps a domain exception
 * through one envelope — `{"message": …}` and nothing else — so as the API stands the only channel
 * carrying the difference is prose. This client therefore reads a `reason` field **first** and
 * falls back to matching the message. Adding the field server-side is a strictly additive change
 * and turns the fallback into dead code; until then the fallback is what makes the three surfaces
 * real, and an unrecognised 409 is honestly reported as `refused` with the server's own words
 * rather than guessed into one of the three.
 */
const REASONS: Readonly<Record<string, IntegrateFailureKind>> = {
  CONFLICT: 'conflict',
  MERGE_CONFLICT: 'conflict',
  NOT_FAST_FORWARD: 'moved',
  ALREADY_INTEGRATED: 'already-integrated',
};

/** Prose fallbacks, in priority order — the first match wins, so the specific ones come first. */
const PATTERNS: readonly (readonly [RegExp, IntegrateFailureKind])[] = [
  [/already[- ]integrated|already an ancestor|already merged|already in /i, 'already-integrated'],
  [/fast[- ]forward|moved under|has moved|non-ff/i, 'moved'],
  [/conflict/i, 'conflict'],
];

/** The `reason` field of an error body, upper-cased, when the body carries one. */
function reasonOf(body: unknown): IntegrateFailureKind | null {
  if (typeof body === 'object' && body !== null && 'reason' in body) {
    const reason = (body as { reason: unknown }).reason;
    if (typeof reason === 'string') {
      return REASONS[reason.toUpperCase()] ?? null;
    }
  }
  return null;
}

/**
 * The conflicted paths, when the body lists them.
 *
 * Two field names are accepted because the server side of this is not frozen yet and both are
 * plausible spellings of the same list. A body carrying neither is not a failure of this reader —
 * the message still says what happened, and the panel simply draws no file list.
 */
function conflictsOf(body: unknown): readonly string[] {
  if (typeof body !== 'object' || body === null) {
    return [];
  }
  const record = body as Record<string, unknown>;
  for (const key of ['conflicts', 'conflictedFiles']) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === 'string');
    }
  }
  return [];
}

/**
 * Read a rejected integrate for what it actually was.
 *
 * Everything that is not an HTTP answer — a network failure, a status of 0, a 5xx — is
 * `unavailable`, because in all three cases the client genuinely does not know what the server did.
 * Only a 409 is classified further; every other 4xx is a `refused` that already carries its own
 * explanation.
 */
export function classifyIntegrateFailure(error: unknown): IntegrateFailure {
  const status = statusOf(error);
  const message = describeError(error);
  const body = error instanceof HttpErrorResponse ? error.error : null;
  const conflicts = conflictsOf(body);

  if (status === 0 || status >= 500) {
    return { kind: 'unavailable', status, message, conflicts: [] };
  }
  if (status !== 409) {
    return { kind: 'refused', status, message, conflicts };
  }

  const declared = reasonOf(body);
  if (declared) {
    return { kind: declared, status, message, conflicts };
  }
  const prose = serverMessage(body) ?? message;
  for (const [pattern, kind] of PATTERNS) {
    if (pattern.test(prose)) {
      return { kind, status, message, conflicts };
    }
  }
  return { kind: 'refused', status, message, conflicts };
}

/**
 * What one workspace's Integrate affordance is doing right now.
 *
 * `closed` and `editing` are separate states because the summary input is not always on screen: a
 * list of eight workspaces with eight open text fields is a form, not a list, so the affordance is
 * a button until it is asked to be more.
 */
export type IntegrateState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'editing' }
  | { readonly kind: 'working' }
  | { readonly kind: 'done'; readonly result: IntegrateResponse }
  | { readonly kind: 'failed'; readonly failure: IntegrateFailure };

/** The merge commit's subject, exactly as the service writes it. */
export function commitSubject(version: string, summary: string): string {
  return `release(${version}): ${summary}`;
}

/**
 * What stands in for the version in the subject preview, before one exists.
 *
 * The stamp is taken from the *server's* clock at the start of the integrate, so the browser cannot
 * know it in advance and must not pretend to: a preview showing a plausible-looking
 * `2026.731.193059` would be a number that never appears in any commit. The placeholder says what
 * the shape is and that it is not yet decided.
 */
export const VERSION_PLACEHOLDER = 'YYYY.MMDD.HHMMSS';
