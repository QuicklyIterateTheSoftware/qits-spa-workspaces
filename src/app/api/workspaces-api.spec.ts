import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { WorkspacesApi } from './workspaces-api';

/**
 * The paths, the envelope and the request body, asserted once here so the page's spec can be about
 * rendering.
 *
 * The body assertion is the one that matters most: the integrate contract is **frozen** as
 * `{summary}` and nothing else — no target, because the target is the repository's default branch
 * by construction — so a client that grew a `target` field would be describing an API that does not
 * exist. These are same-origin absolute paths on purpose; the SPA is served at `/workspaces/`
 * behind the gateway that also serves `/projects/api/…`, and that is what carries the session
 * cookie to both.
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

  it('posts the summary and nothing else to the workspace’s integrate route', async () => {
    const integrate = api.integrate(7, 'teach the explorer to group runs by repository');
    const request = http.expectOne('/workspaces/api/workspaces/7/integrate');

    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      summary: 'teach the explorer to group runs by repository',
    });

    request.flush({
      version: '2026.731.193059',
      commitSha: '9f2c1ab3d4e5f60718293a4b5c6d7e8f90123456',
      branch: 'explorer-grouping',
    });
    await expect(integrate).resolves.toEqual({
      version: '2026.731.193059',
      commitSha: '9f2c1ab3d4e5f60718293a4b5c6d7e8f90123456',
      branch: 'explorer-grouping',
    });
  });

  it('rejects with the HttpErrorResponse, so callers can read the status and the body', async () => {
    const integrate = api.integrate(7, 'anything');
    http
      .expectOne('/workspaces/api/workspaces/7/integrate')
      .flush({ message: 'merge conflict' }, { status: 409, statusText: 'Conflict' });

    await expect(integrate).rejects.toBeInstanceOf(HttpErrorResponse);
  });
});
