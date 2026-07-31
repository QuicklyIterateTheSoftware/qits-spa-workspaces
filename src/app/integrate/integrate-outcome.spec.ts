import { HttpErrorResponse } from '@angular/common/http';
import { VERSION_PLACEHOLDER, classifyIntegrateFailure, commitSubject } from './integrate-outcome';

/** A rejected integrate, as `HttpClient` hands it to a caller. */
function rejection(status: number, body: unknown): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    statusText: status === 409 ? 'Conflict' : 'Error',
    error: body,
    url: '/workspaces/api/workspaces/7/integrate',
  });
}

/**
 * The three 409s are three different things a person does something different about, so telling
 * them apart is the load-bearing logic of this screen — and it is the piece most exposed to the
 * server side changing under it, which is why it is a pure function with its own suite rather than
 * an `if` inside a template.
 *
 * Both channels are asserted: the structural `reason` this client prefers, and the prose fallback
 * that is all the platform's one error envelope (`{"message": …}`) can currently carry. The last
 * case is the important one — an unrecognised 409 is reported as a refusal with the server's own
 * words, never guessed into one of the three, because a wrong guess sends someone to fix a conflict
 * that does not exist.
 */
describe('classifyIntegrateFailure', () => {
  it('prefers a declared reason over the prose', () => {
    // Deliberately contradictory: the reason says the branch is in, the message says "conflict".
    // The structured field is the one the server meant.
    const failure = classifyIntegrateFailure(
      rejection(409, { reason: 'ALREADY_INTEGRATED', message: 'conflict' }),
    );
    expect(failure.kind).toBe('already-integrated');
  });

  it('reads an already-integrated 409 out of the message alone', () => {
    const failure = classifyIntegrateFailure(
      rejection(409, { message: 'branch explorer-grouping is already integrated into main' }),
    );
    expect(failure.kind).toBe('already-integrated');
    expect(failure.message).toContain('already integrated');
  });

  it('reads a non-fast-forward 409 as “main moved”', () => {
    const failure = classifyIntegrateFailure(
      rejection(409, { message: 'push rejected: not a fast-forward — main moved, retry' }),
    );
    expect(failure.kind).toBe('moved');
  });

  it('reads a merge-conflict 409 and keeps a structured file list', () => {
    const failure = classifyIntegrateFailure(
      rejection(409, {
        message: 'merge conflict',
        conflicts: ['pom.xml', 'src/main/java/A.java'],
      }),
    );
    expect(failure.kind).toBe('conflict');
    expect(failure.conflicts).toEqual(['pom.xml', 'src/main/java/A.java']);
  });

  it('accepts the other plausible spelling of the file list', () => {
    // The server side of this is not frozen; both names mean the same list, and a body carrying
    // neither still renders its message.
    const failure = classifyIntegrateFailure(
      rejection(409, { message: 'conflict', conflictedFiles: ['README.md'] }),
    );
    expect(failure.conflicts).toEqual(['README.md']);
  });

  it('never invents a conflict out of an unrecognised 409', () => {
    const failure = classifyIntegrateFailure(
      rejection(409, { message: 'the workspace is not ACTIVE' }),
    );
    expect(failure.kind).toBe('refused');
    expect(failure.conflicts).toEqual([]);
    expect(failure.message).toContain('the workspace is not ACTIVE');
  });

  it('treats every other 4xx as a refusal that speaks for itself', () => {
    const failure = classifyIntegrateFailure(
      rejection(400, { message: 'summary must not be blank' }),
    );
    expect(failure.kind).toBe('refused');
    expect(failure.message).toContain('summary must not be blank');
  });

  it('treats a 5xx as unavailable, because what the server did is unknown', () => {
    // A 500 from the push step may or may not have moved main. Claiming "nothing happened" would
    // be the one statement this client cannot make.
    const failure = classifyIntegrateFailure(rejection(500, { message: 'push failed' }));
    expect(failure.kind).toBe('unavailable');
  });

  it('treats a request that never reached a server as unavailable', () => {
    const failure = classifyIntegrateFailure(rejection(0, null));
    expect(failure.kind).toBe('unavailable');
    expect(failure.message).toBe('the service is unreachable');
  });

  it('survives a non-HTTP failure', () => {
    const failure = classifyIntegrateFailure(new Error('boom'));
    expect(failure.kind).toBe('unavailable');
    expect(failure.message).toBe('boom');
  });
});

describe('commitSubject', () => {
  it('is the frozen shape, verbatim', () => {
    expect(commitSubject('2026.731.193059', 'teach the explorer to group runs')).toBe(
      'release(2026.731.193059): teach the explorer to group runs',
    );
  });

  it('previews with a placeholder rather than a plausible-looking version', () => {
    // The stamp is taken from the server's clock, so any version this browser rendered before the
    // request would be a number that appears in no commit anywhere.
    expect(VERSION_PLACEHOLDER).toBe('YYYY.MMDD.HHMMSS');
    expect(commitSubject(VERSION_PLACEHOLDER, 'x')).toBe('release(YYYY.MMDD.HHMMSS): x');
  });
});
