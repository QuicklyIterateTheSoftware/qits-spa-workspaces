import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { FilesApi } from './files-api';

/**
 * The two reads the file browser is built from, and the one thing about their addressing that is
 * easy to get wrong.
 *
 * The container proxy **rewrites nothing**: `/files` on the daemon is `/workspaces/container/{id}/files`
 * from the browser, and the daemon is *told* the base path rather than deriving it. So a client that
 * helpfully normalised, or that sent `path=` on the root read, would be describing a different route
 * from the one the contract documents.
 */
describe('FilesApi', () => {
  let api: FilesApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(FilesApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('reads the whole eager tree with no path at all', async () => {
    const answer = api.files(7);
    const request = http.expectOne('/workspaces/container/7/files');
    request.flush({ paths: ['src/main.ts'], lazyDirs: [], generation: 'gen-1' });

    // Absent rather than blank: the daemon reads both as "the root", and `path=` would make the
    // request that fetches everything look like a request for a directory called nothing.
    expect(request.request.urlWithParams).toBe('/workspaces/container/7/files');
    expect((await answer).paths).toEqual(['src/main.ts']);
  });

  it('asks for one lazy directory by path', async () => {
    const answer = api.files(7, 'node_modules');
    const request = http.expectOne(
      (candidate) =>
        candidate.url === '/workspaces/container/7/files' &&
        candidate.params.get('path') === 'node_modules',
    );
    request.flush({
      paths: ['node_modules/.package-lock.json'],
      lazyDirs: [{ path: 'node_modules/rxjs', childCount: 21 }],
      generation: 'gen-1',
    });

    expect((await answer).lazyDirs[0].childCount).toBe(21);
  });

  it('reads the detection and its token, which is the point of it', async () => {
    const answer = api.detection(7);
    http.expectOne('/workspaces/container/7/detection').flush({
      projects: [{ root: 'webui', frameworkId: 'angular', label: 'Angular' }],
      frameworks: [
        {
          frameworkId: 'angular',
          root: 'webui',
          label: 'Angular',
          memberPaths: ['webui/src/main.ts'],
        },
      ],
      links: [],
      generation: 'gen-1',
    });

    expect((await answer).generation).toBe('gen-1');
  });
});
