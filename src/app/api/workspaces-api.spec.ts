import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { WorkspacesApi } from './workspaces-api';

/**
 * The paths, the envelopes and the request bodies, asserted once here so the page's spec can be
 * about rendering.
 *
 * Two assertions matter most. **The two doors are two routes** — `/release` stamps a version,
 * `/integrate` does not — so a spec that let one call the other would hide the whole change. And
 * **both bodies are frozen as `{summary}` and nothing else**: neither call names a target, because
 * release always lands on the repository's default branch and integrate always lands on the
 * workspace's parent, so a client that grew a `target` field would be describing an API that does
 * not exist.
 *
 * These are same-origin absolute paths on purpose; the SPA is served at `/workspaces/` behind the
 * gateway that also serves `/projects/api/…`, and that is what carries the session cookie to both.
 */
describe('WorkspacesApi', () => {
  let api: WorkspacesApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(WorkspacesApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('scopes the workspace list by repository, which the service requires', async () => {
    const workspaces = api.workspaces('qits-ci');
    const request = http.expectOne(
      (candidate) =>
        candidate.url === '/workspaces/api/workspaces' &&
        candidate.params.get('repositoryId') === 'qits-ci',
    );
    request.flush({
      entries: [{ workspace: { id: 7, workspaceId: 'explorer-grouping', status: 'ACTIVE' } }],
    });
    await expect(workspaces).resolves.toMatchObject([{ id: 7, workspaceId: 'explorer-grouping' }]);
  });

  it('unwraps an empty entry list as no workspaces, not as a crash', async () => {
    const workspaces = api.workspaces('qits-ci');
    http
      .expectOne((candidate) => candidate.url === '/workspaces/api/workspaces')
      .flush({
        entries: [],
      });
    await expect(workspaces).resolves.toEqual([]);
  });

  it('carries the repository in the create’s body, where the service reads it', async () => {
    // The listing scopes by a query parameter and the create does not: a create carries its scope
    // in the payload, and the service answers 400 for a body without `repositoryId`.
    const created = api.createWorkspace({
      repositoryId: 'qits-ci',
      id: 'fix-lint',
      parent: 'main',
      branch: 'fix-lint',
      preamble: '',
      adoptExisting: true,
    });
    const request = http.expectOne(
      (candidate) => candidate.method === 'POST' && candidate.url === '/workspaces/api/workspaces',
    );

    expect(request.request.params.get('repositoryId')).toBeNull();
    expect(request.request.body).toEqual({
      repositoryId: 'qits-ci',
      id: 'fix-lint',
      parent: 'main',
      branch: 'fix-lint',
      preamble: '',
      adoptExisting: true,
    });

    request.flush({ workspace: { id: 12, workspaceId: 'fix-lint', status: 'ACTIVE' } });
    await expect(created).resolves.toMatchObject({ id: 12, workspaceId: 'fix-lint' });
  });

  it('posts the summary and nothing else to the workspace’s release route', async () => {
    const release = api.release(7, 'teach the explorer to group runs by repository');
    const request = http.expectOne('/workspaces/api/workspaces/7/release');

    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      summary: 'teach the explorer to group runs by repository',
    });

    request.flush({
      version: '2026.731.193059',
      commitSha: '9f2c1ab3d4e5f60718293a4b5c6d7e8f90123456',
      branch: 'explorer-grouping',
    });
    await expect(release).resolves.toEqual({
      version: '2026.731.193059',
      commitSha: '9f2c1ab3d4e5f60718293a4b5c6d7e8f90123456',
      branch: 'explorer-grouping',
    });
  });

  it('posts the summary to the integrate route, and reads back a version-free answer', async () => {
    // The whole difference between the two doors is in this answer: an integrate is a merge into
    // the workspace's parent and stamps nothing, so there is no version to read and none is invented.
    const integrate = api.integrate(7, 'land the task on its epic');
    const request = http.expectOne('/workspaces/api/workspaces/7/integrate');

    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ summary: 'land the task on its epic' });

    request.flush({
      commitSha: '4b5c6d7e8f90123456789abcdef0123456789abc',
      branch: 'task/group-runs',
      targetBranch: 'epic/explorer',
    });
    await expect(integrate).resolves.toEqual({
      commitSha: '4b5c6d7e8f90123456789abcdef0123456789abc',
      branch: 'task/group-runs',
      targetBranch: 'epic/explorer',
    });
  });

  it('rejects with the HttpErrorResponse, so callers can read the status and the body', async () => {
    const release = api.release(7, 'anything');
    http
      .expectOne('/workspaces/api/workspaces/7/release')
      .flush({ message: 'merge conflict' }, { status: 409, statusText: 'Conflict' });

    await expect(release).rejects.toBeInstanceOf(HttpErrorResponse);
  });

  it('rejects an integrate the same way, because the 409 family is shared', async () => {
    const integrate = api.integrate(7, 'anything');
    http
      .expectOne('/workspaces/api/workspaces/7/integrate')
      .flush(
        { reason: 'CONFLICT', message: 'merge conflict' },
        { status: 409, statusText: 'Conflict' },
      );

    await expect(integrate).rejects.toBeInstanceOf(HttpErrorResponse);
  });
});
