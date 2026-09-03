import { HttpErrorResponse } from '@angular/common/http';
import type { IntegrateResponse } from '../api/dto';
import { describeError, serverMessage, statusOf } from '../ui/loadable';

/**
 * Why an integrate did not happen — and the answers are different things a person does something
 * different about, which is the whole reason this type exists instead of one red box.
 *
 * - `conflict` — the branch does not apply to its target. Resolve it in the workspace and try
 *   again. **Nothing landed and the target did not move**, which is a property of the flow rather
 *   than a hope: the merge happens in a detached worktree and only the final push moves a ref, so a
 *   conflict leaves the target byte-identical.
 * - `moved` — someone else's merge landed first and this one's push was rejected as
 *   non-fast-forward. Pressing the button again is the whole fix; the same summary is kept for
 *   exactly that.
 * - `already-integrated` — this branch is already an ancestor of the target. The work is in. This is
 *   what a lost 200 looks like on retry, and it is deliberately **not** an error to apologise for:
 *   the right response is to refresh the list and see the workspace resolved.
 * - `release-required` — the merge targets the repository's default branch, which qits-workspaces
 *   does not write at all. Nothing is wrong with the work and nothing here can land it: the default
 *   branch is written by a release request in qits-projects, so this surface says where to go rather
 *   than offering a door that no longer exists.
 * - `refused` — the service declined for some other reason it stated: a blank summary, an unknown
 *   workspace, a workspace that is not ACTIVE, or the git host rejecting the push. Its own sentence
 *   is the most useful thing on screen, so it is shown verbatim.
 * - `unavailable` — the request never got an answer, or the service failed. Nothing is known about
 *   whether anything happened; refresh before assuming either way.
 */
export type MergeFailureKind =
  | 'conflict'
  | 'moved'
  | 'already-integrated'
  | 'release-required'
  | 'refused'
  | 'unavailable';

/** A failed integrate, classified, with whatever the service said about it. */
export interface MergeFailure {
  readonly kind: MergeFailureKind;
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
 * The 409s are genuinely different outcomes, but every qits service maps a domain exception through
 * one envelope — `{"message": …}` and nothing else — so as the API stands the only channel carrying
 * the difference is prose. This client therefore reads a `reason` field **first** and falls back to
 * matching the message. Adding the field server-side is a strictly additive change and turns the
 * fallback into dead code; until then the fallback is what makes the surfaces real, and an
 * unrecognised 409 is honestly reported as `refused` with the server's own words rather than
 * guessed into one of the others.
 *
 * `PUSH_REJECTED` is mapped to `refused` and deliberately not to `moved`: the family already spells
 * a lost race `NOT_FAST_FORWARD`, so a declared push rejection is the git host saying no for a
 * reason of its own — a protected branch, a missing token — and offering "press it again" would be
 * advice that cannot work.
 *
 * `RELEASE_REQUIRED` is qits-workspaces' main-target guard, thrown by every merge endpoint left
 * here. The work is fine; the branch it aims at simply is not this service's to write.
 */
const REASONS: Readonly<Record<string, MergeFailureKind>> = {
  CONFLICT: 'conflict',
  MERGE_CONFLICT: 'conflict',
  NOT_FAST_FORWARD: 'moved',
  ALREADY_INTEGRATED: 'already-integrated',
  RELEASE_REQUIRED: 'release-required',
  PUSH_REJECTED: 'refused',
};

/** Prose fallbacks, in priority order — the first match wins, so the specific ones come first. */
const PATTERNS: readonly (readonly [RegExp, MergeFailureKind])[] = [
  [/already[- ]integrated|already an ancestor|already merged|already in /i, 'already-integrated'],
  [/release[- ]required|requires a release|use the release/i, 'release-required'],
  [/fast[- ]forward|moved under|has moved|non-ff/i, 'moved'],
  [/conflict/i, 'conflict'],
];

/** The `reason` field of an error body, upper-cased, when the body carries one. */
function reasonOf(body: unknown): MergeFailureKind | null {
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
 * Read a rejected merge for what it actually was.
 *
 * Everything that is not an HTTP answer — a network failure, a status of 0, a 5xx — is
 * `unavailable`, because in all three cases the client genuinely does not know what the server did.
 * Only a 409 is classified further; every other 4xx is a `refused` that already carries its own
 * explanation.
 */
export function classifyMergeFailure(error: unknown): MergeFailure {
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
 * What an integrate produced — the answer, in the shape this screen draws and records.
 *
 * **There is no version on it, and that absence is the model and not an omission.** This shape once
 * carried one because the same panel could release; the release door has left qits-workspaces
 * entirely, so nothing reachable from here can stamp a version and a nullable field for it would be
 * a slot no code path could ever fill.
 */
export interface MergeResult {
  readonly commitSha: string;
  readonly branch: string;
  readonly targetBranch: string;
}

/** An integrate, as this screen holds it. The target comes from the answer, not from the row. */
export function integrateResult(response: IntegrateResponse): MergeResult {
  return {
    commitSha: response.commitSha,
    branch: response.branch,
    targetBranch: response.targetBranch,
  };
}

/**
 * What one workspace's merge affordance is doing right now.
 *
 * `closed` and `editing` are separate states because the summary input is not always on screen: a
 * list of eight workspaces with eight open text fields is a form, not a list, so the affordance is
 * a button until it is asked to be more.
 */
export type MergeState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'editing' }
  | { readonly kind: 'working' }
  | { readonly kind: 'done'; readonly result: MergeResult }
  | { readonly kind: 'failed'; readonly failure: MergeFailure };

/**
 * An integrate commit's subject, exactly as the service writes it. The scope is the branch that was
 * integrated — the source. The target is not in the subject: it is where the commit sits.
 *
 * <p>This preview is exact, where the release preview it used to sit beside never could be: an
 * integrate's scope is a branch the browser already knows, and a release's was a version taken from
 * the server's clock. That asymmetry left with the release door.
 */
export function integrateSubject(branch: string, summary: string): string {
  return `integrate(${branch}): ${summary}`;
}
