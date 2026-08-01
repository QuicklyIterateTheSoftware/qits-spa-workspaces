import { HttpErrorResponse } from '@angular/common/http';
import type { IntegrateResponse, ReleaseResponse } from '../api/dto';
import { describeError, serverMessage, statusOf } from '../ui/loadable';

/**
 * Which of the two doors a workspace goes home through.
 *
 * They are two processes, not one with a toggle. `release` merges into the repository's default
 * branch and stamps a calver version onto it — the only way into that branch. `integrate` merges a
 * workspace into its **parent** branch and stamps nothing: a task workspace lands on its epic, and
 * releasing the epic is a separate, later act.
 */
export type MergeAction = 'release' | 'integrate';

/**
 * Why a release or an integrate did not happen — and the six answers are six different things a
 * person does something different about, which is the whole reason this type exists instead of one
 * red box. The 409 family is shared by both doors, so this classification is too.
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
 * - `release-required` — the merge targets the repository's default branch, and that branch has one
 *   door. Nothing is wrong with the work: the wrong door was knocked on, which happens when the
 *   list's reading of the parent is stale. The way out is the other door, so this surface offers it
 *   rather than describing it.
 * - `refused` — the service declined for some other reason it stated: a blank summary, an unknown
 *   workspace, a workspace that is not ACTIVE, or the git host rejecting the push. Its own sentence
 *   is the most useful thing on screen, so it is shown verbatim.
 * - `unavailable` — the request never got an answer, or the service failed. Nothing is known about
 *   whether anything happened; refresh before assuming either way.
 */
export type MergeFailureKind =
  'conflict' | 'moved' | 'already-integrated' | 'release-required' | 'refused' | 'unavailable';

/** A failed release or integrate, classified, with whatever the service said about it. */
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
 * `RELEASE_REQUIRED` is qits-workspaces' main-target guard, and both merge endpoints throw it. It
 * is the one 409 with a button rather than a sentence: the work is fine and the other door is right
 * there.
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
 * Read a rejected merge for what it actually was. One function for both doors, because both answer
 * out of the same 409 family.
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
 * What a merge produced, whichever door it came through — the two answers, flattened to the one
 * shape this screen draws and records.
 *
 * `version` is `null` for an integrate, and that is the point of the type: an integrate stamps no
 * version, so the surface draws no version rather than an empty slot where one used to be.
 */
export interface MergeResult {
  readonly action: MergeAction;
  readonly version: string | null;
  readonly commitSha: string;
  readonly branch: string;
  readonly targetBranch: string;
}

/** A release, as this screen holds it. The target is the repository's default branch. */
export function releaseResult(response: ReleaseResponse, targetBranch: string): MergeResult {
  return {
    action: 'release',
    version: response.version,
    commitSha: response.commitSha,
    branch: response.branch,
    targetBranch,
  };
}

/** An integrate, as this screen holds it. The target comes from the answer, not from the row. */
export function integrateResult(response: IntegrateResponse): MergeResult {
  return {
    action: 'integrate',
    version: null,
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

/** A release commit's subject, exactly as the service writes it. */
export function releaseSubject(version: string, summary: string): string {
  return `release(${version}): ${summary}`;
}

/**
 * An integrate commit's subject, exactly as the service writes it. The scope is the branch that was
 * integrated — the source. The target is not in the subject: it is where the commit sits.
 */
export function integrateSubject(branch: string, summary: string): string {
  return `integrate(${branch}): ${summary}`;
}

/**
 * What stands in for the version in a release preview, before one exists.
 *
 * The stamp is taken from the *server's* clock at the start of the release, so the browser cannot
 * know it in advance and must not pretend to: a preview showing a plausible-looking
 * `2026.731.193059` would be a number that never appears in any commit. The placeholder says what
 * the shape is and that it is not yet decided. An integrate needs no placeholder — its scope is the
 * source branch, which this client already knows.
 */
export const VERSION_PLACEHOLDER = 'YYYY.MMDD.HHMMSS';
