import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { WorkspaceDaemonApi } from './workspace-daemon-api';

/**
 * The transport every daemon-backed panel will be written against: the path it builds, and the one
 * inference it draws from a failure.
 *
 * **The proxy rewrites nothing.** `/files` on the daemon is `/workspaces/container/{id}/files` from
 * the browser, and a client that helpfully normalised a path would be describing a different route.
 *
 * **Only "nothing answered" means the daemon is gone.** The reverse tunnel made the daemon's control
 * socket load-bearing for this proxy, so a reconnect blip 502s the file browser, every terminal and
 * the whole agent surface at once — and the status strip needs to say that in one sentence rather
 * than leave seven panels each showing their own copy of it. But a 404 from the same path is the
 * daemon answering that a file does not exist, which is a working daemon; treating it as an outage
 * would make every missing file look like a dead container.
 */
describe('WorkspaceDaemonApi', () => {
  let api: WorkspaceDaemonApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(WorkspaceDaemonApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('appends the daemon path to the container proxy verbatim', async () => {
    const answer = api.get<{ paths: string[] }>(7, '/files');
    const request = http.expectOne('/workspaces/container/7/files');
    request.flush({ paths: [] });

    expect((await answer).paths).toEqual([]);
    expect(request.request.method).toBe('GET');
  });

  it('carries query parameters through to the daemon', async () => {
    const answer = api.get<unknown>(7, '/files/content', { path: 'src/main.ts' });
    const request = http.expectOne(
      (candidate) =>
        candidate.url === '/workspaces/container/7/files/content' &&
        candidate.params.get('path') === 'src/main.ts',
    );
    request.flush({});
    await answer;
  });

  it('starts out saying nothing about a daemon it has not tried', () => {
    expect(api.reachability()).toBe('unknown');
  });

  it('reads any answer at all as a daemon that is there — including its own 404', async () => {
    const answer = api.get(7, '/files/content').catch(() => null);
    http
      .expectOne('/workspaces/container/7/files/content')
      .flush({ message: 'no such file' }, { status: 404, statusText: 'Not Found' });
    await answer;

    expect(api.reachability()).toBe('reachable');
  });

  it('reads the proxy failing to reach anything as a daemon that is gone', async () => {
    const answer = api.get(7, '/files').catch(() => null);
    http
      .expectOne('/workspaces/container/7/files')
      .flush({ message: 'No workspace here.' }, { status: 502, statusText: 'Bad Gateway' });
    await answer;

    expect(api.reachability()).toBe('unreachable');
  });

  it('says the daemon is back on the next answer, without being told to', async () => {
    const failing = api.get(7, '/files').catch(() => null);
    http
      .expectOne('/workspaces/container/7/files')
      .flush({}, { status: 502, statusText: 'Bad Gateway' });
    await failing;

    const succeeding = api.get(7, '/files');
    http.expectOne('/workspaces/container/7/files').flush({ paths: [] });
    await succeeding;

    expect(api.reachability()).toBe('reachable');
  });

  it('forgets what it observed when the shell moves to another workspace', async () => {
    const answer = api.get(7, '/files').catch(() => null);
    http.expectOne('/workspaces/container/7/files').flush({}, { status: 0, statusText: 'Unknown' });
    await answer;
    expect(api.reachability()).toBe('unreachable');

    api.resetReachability();

    expect(api.reachability()).toBe('unknown');
  });

  it('builds an absolute socket URL, because WebSocket takes no relative one', () => {
    expect(api.socketUrl(7, '/terminal/commands/c-1')).toMatch(
      /^wss?:\/\/[^/]+\/workspaces\/container\/7\/terminal\/commands\/c-1$/,
    );
  });
});
