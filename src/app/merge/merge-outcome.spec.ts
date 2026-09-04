import { HttpErrorResponse } from '@angular/common/http';
import { classifyMergeFailure, integrateResult, integrateSubject } from './merge-outcome';

/** A rejected merge, as `HttpClient` hands it to a caller. */
function rejection(status: number, body: unknown, path = 'integrate'): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    statusText: status === 409 ? 'Conflict' : 'Error',
    error: body,
    url: `/workspaces/api/workspaces/7/${path}`,
  });
}

/**
 * The 409s are different things a person does something different about, so telling them apart is
 * the load-bearing logic of this screen — and it is the piece most exposed to the server side
 * changing under it, which is why it is a pure function with its own suite rather than an `if`
 * inside a template. It classifies the integrate door's answers, which are all this screen has left
 * to classify — the release door has gone from qits-workspaces entirely.
 *
 * Both channels are asserted: the structural `reason` this client prefers, and the prose fallback
 * that is all the platform's one error envelope (`{"message": …}`) can currently carry. The last
 * case is the important one — an unrecognised 409 is reported as a refusal with the server's own
 * words, never guessed into one of the others, because a wrong guess sends someone to fix a
 * conflict that does not exist.
 */
describe('classifyMergeFailure', () => {
  it('prefers a declared reason over the prose', () => {
    // Deliberately contradictory: the reason says the branch is in, the message says "conflict".
    // The structured field is the one the server meant.
    const failure = classifyMergeFailure(
      rejection(409, { reason: 'ALREADY_INTEGRATED', message: 'conflict' }),
    );
    expect(failure.kind).toBe('already-integrated');
  });

  it('reads an already-integrated 409 out of the message alone', () => {
    const failure = classifyMergeFailure(
      rejection(409, { message: 'branch explorer-grouping is already integrated into main' }),
    );
    expect(failure.kind).toBe('already-integrated');
    expect(failure.message).toContain('already integrated');
  });

  it('reads a non-fast-forward 409 as “the target moved”', () => {
    const failure = classifyMergeFailure(
      rejection(409, { message: 'push rejected: not a fast-forward — main moved, retry' }),
    );
    expect(failure.kind).toBe('moved');
  });

  it('reads a merge-conflict 409 and keeps a structured file list', () => {
    const failure = classifyMergeFailure(
      rejection(409, {
        message: 'merge conflict',
        conflicts: ['pom.xml', 'src/main/java/A.java'],
      }),
    );
    expect(failure.kind).toBe('conflict');
    expect(failure.conflicts).toEqual(['pom.xml', 'src/main/java/A.java']);
  });

  it('reads a declared conflict reason as well as the prose', () => {
    const failure = classifyMergeFailure(
      rejection(409, { reason: 'CONFLICT', conflicts: ['README.md'], message: 'conflict' }),
    );
    expect(failure.kind).toBe('conflict');
    expect(failure.conflicts).toEqual(['README.md']);
  });

  it('accepts the other plausible spelling of the file list', () => {
    // The server side of this is not frozen; both names mean the same list, and a body carrying
    // neither still renders its message.
    const failure = classifyMergeFailure(
      rejection(409, { message: 'conflict', conflictedFiles: ['README.md'] }),
    );
    expect(failure.conflicts).toEqual(['README.md']);
  });

  it('reads a declared push rejection as a refusal, not as a lost race', () => {
    // The family spells a lost race NOT_FAST_FORWARD, so PUSH_REJECTED is the git host saying no
    // for a reason of its own — a protected branch, a missing token. "Press it again" cannot fix it.
    const failure = classifyMergeFailure(
      rejection(409, { reason: 'PUSH_REJECTED', message: 'the git host refused the push' }),
    );
    expect(failure.kind).toBe('refused');
    expect(failure.message).toContain('the git host refused the push');
  });

  it('never invents a conflict out of an unrecognised 409', () => {
    const failure = classifyMergeFailure(
      rejection(409, { message: 'the workspace is not ACTIVE' }),
    );
    expect(failure.kind).toBe('refused');
    expect(failure.conflicts).toEqual([]);
    expect(failure.message).toContain('the workspace is not ACTIVE');
  });

  it('reads the main-target guard as its own outcome, not as a refusal', () => {
    // RELEASE_REQUIRED still has a surface of its own, and it is now a sentence rather than a
    // hand-over: nothing is wrong with the work, and the branch it aims at is written elsewhere.
    const failure = classifyMergeFailure(
      rejection(409, { reason: 'RELEASE_REQUIRED', message: 'target main requires a release' }),
    );
    expect(failure.kind).toBe('release-required');
    expect(failure.message).toContain('requires a release');
  });

  it('reads the same guard out of the message alone', () => {
    const failure = classifyMergeFailure(
      rejection(409, { message: 'this workspace targets main; use the release flow' }),
    );
    expect(failure.kind).toBe('release-required');
  });

  it('treats every other 4xx as a refusal that speaks for itself', () => {
    const failure = classifyMergeFailure(rejection(400, { message: 'summary must not be blank' }));
    expect(failure.kind).toBe('refused');
    expect(failure.message).toContain('summary must not be blank');
  });

  it('treats a 5xx as unavailable, because what the server did is unknown', () => {
    // A 500 from the push step may or may not have moved the target. Claiming "nothing happened"
    // would be the one statement this client cannot make.
    const failure = classifyMergeFailure(rejection(500, { message: 'push failed' }));
    expect(failure.kind).toBe('unavailable');
  });

  it('treats a request that never reached a server as unavailable', () => {
    const failure = classifyMergeFailure(rejection(0, null));
    expect(failure.kind).toBe('unavailable');
    expect(failure.message).toBe('the service is unreachable');
  });

  it('survives a non-HTTP failure', () => {
    const failure = classifyMergeFailure(new Error('boom'));
    expect(failure.kind).toBe('unavailable');
    expect(failure.message).toBe('boom');
  });
});

describe('the commit subject', () => {
  /**
   * Exact, where the release preview beside it never could be: an integrate's scope is a branch the
   * browser already holds, and a release's was a version taken from the server's clock. That
   * asymmetry — and the placeholder it needed — left with the release door.
   */
  it('spells an integrate with the branch it merged', () => {
    expect(integrateSubject('task/group-runs', 'land the task on its epic')).toBe(
      'integrate(task/group-runs): land the task on its epic',
    );
  });
});

describe('the answer, flattened', () => {
  /**
   * No version and no action word on the result: this shape carried both while the same panel could
   * release, and nothing reachable from here can stamp a version now. A nullable field for one would
   * be a slot no code path could fill.
   */
  it('is the sha, the branch and the target the service answered with', () => {
    expect(
      integrateResult({
        commitSha: 'def5678abc',
        branch: 'task/group-runs',
        targetBranch: 'epic/explorer',
      }),
    ).toEqual({
      commitSha: 'def5678abc',
      branch: 'task/group-runs',
      targetBranch: 'epic/explorer',
    });
  });
});
