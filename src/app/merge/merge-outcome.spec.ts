import { HttpErrorResponse } from '@angular/common/http';
import {
  VERSION_PLACEHOLDER,
  classifyMergeFailure,
  integrateResult,
  integrateSubject,
  releaseResult,
  releaseSubject,
} from './merge-outcome';

/** A rejected merge, as `HttpClient` hands it to a caller. */
function rejection(status: number, body: unknown, path = 'release'): HttpErrorResponse {
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
 * inside a template. **One classifier serves both doors**, because release and integrate answer out
 * of the same family.
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

  it('classifies an integrate’s 409 exactly as a release’s, because the family is shared', () => {
    const failure = classifyMergeFailure(
      rejection(
        409,
        { reason: 'CONFLICT', conflicts: ['README.md'], message: 'conflict' },
        'integrate',
      ),
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
    // RELEASE_REQUIRED is the one 409 with a button rather than a sentence: nothing is wrong with
    // the work, the other door is simply the right one, and the panel offers it.
    const failure = classifyMergeFailure(
      rejection(
        409,
        { reason: 'RELEASE_REQUIRED', message: 'target main requires a release' },
        'integrate',
      ),
    );
    expect(failure.kind).toBe('release-required');
    expect(failure.message).toContain('requires a release');
  });

  it('reads the same guard out of the message alone', () => {
    const failure = classifyMergeFailure(
      rejection(
        409,
        { message: 'this workspace targets main; use the release endpoint' },
        'integrate',
      ),
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

describe('the commit subjects', () => {
  it('spells a release with the version it stamped', () => {
    expect(releaseSubject('2026.731.193059', 'teach the explorer to group runs')).toBe(
      'release(2026.731.193059): teach the explorer to group runs',
    );
  });

  it('spells an integrate with the branch it merged', () => {
    expect(integrateSubject('task/group-runs', 'land the task on its epic')).toBe(
      'integrate(task/group-runs): land the task on its epic',
    );
  });

  it('previews a release with a placeholder rather than a plausible-looking version', () => {
    // The stamp is taken from the server's clock, so any version this browser rendered before the
    // request would be a number that appears in no commit anywhere. An integrate needs no
    // placeholder: its scope is the source branch, which is already known here.
    expect(VERSION_PLACEHOLDER).toBe('YYYY.MMDD.HHMMSS');
    expect(releaseSubject(VERSION_PLACEHOLDER, 'x')).toBe('release(YYYY.MMDD.HHMMSS): x');
  });
});

describe('the two answers, flattened', () => {
  it('carries a released request’s version and the target it was given', () => {
    expect(
      releaseResult(
        {
          id: 'req-1',
          state: 'RELEASED',
          version: '2026.731.193059',
          commitSha: 'abc1234def',
          branch: 'explorer-grouping',
          detail: null,
        },
        'main',
      ),
    ).toEqual({
      action: 'release',
      version: '2026.731.193059',
      commitSha: 'abc1234def',
      branch: 'explorer-grouping',
      targetBranch: 'main',
    });
  });

  it('carries no version for an integrate, and takes the target from the answer', () => {
    // Null rather than an empty string: the surface asks "is there a version" and must get an
    // answer, not a string that renders as a blank slot.
    expect(
      integrateResult({
        commitSha: 'def5678abc',
        branch: 'task/group-runs',
        targetBranch: 'epic/explorer',
      }),
    ).toEqual({
      action: 'integrate',
      version: null,
      commitSha: 'def5678abc',
      branch: 'task/group-runs',
      targetBranch: 'epic/explorer',
    });
  });
});
