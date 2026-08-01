import { Location } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { WorkspaceDto } from '../api/dto';
import { EVENT_SOURCE_FACTORY, type EventSourceLike } from '../api/event-source';
import { routes } from '../app.routes';
import { WorkspaceDetailPage } from './workspace-detail-page';

class FakeStream implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  closed = false;
  constructor(readonly url: string) {}
  close(): void {
    this.closed = true;
  }
}

const REPOSITORY = {
  id: 'qits-ci',
  url: 'https://example.invalid/qits-ci.git',
  mainBranch: 'main',
  archetype: 'SERVICE',
  projectId: 'p1',
};

const workspace = (id: number, label: string, over: Partial<WorkspaceDto> = {}): WorkspaceDto => ({
  id,
  workspaceId: label,
  parent: 'main',
  branch: `task/${label}`,
  ahead: 1,
  behind: 0,
  conflictsWithParent: false,
  status: 'ACTIVE',
  runtimeStatus: 'RUNNING',
  runtimeError: null,
  clean: true,
  agentActivity: null,
  preamble: null,
  result: null,
  resolvedAt: null,
  daemonConnectedAt: '2026-08-01T09:00:00Z',
  daemonVersion: '1.4.0',
  daemonBuildTime: null,
  daemonOutdated: null,
  ...over,
});

/**
 * The shell: what it costs to open, what the URL means, and what it refuses to open at all.
 *
 * **The load budget is asserted, not just written down.** A budget that lives only in a comment grows
 * a fourth request the first time somebody needs one, and nobody notices until an idle workspace is
 * making traffic. Three reads and one stream, named, in a test that fails the moment a fourth appears
 * — and the same three sentences are on the component, so the two have to move together.
 *
 * **A tab change reuses the page and a workspace change does not.** Angular reuses a component across
 * a path-parameter change, which is right for one and a bug for the other: the page reads its
 * identity into a dozen signals and a live channel, and a reused instance would go on showing the
 * previous workspace.
 *
 * **A resolved workspace does not get a detail view.** It is not in the active list at all, its
 * container is gone, and six tabs that every one of them 502s would be worse than an honest record.
 */
describe('WorkspaceDetailPage', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;
  let streams: FakeStream[];

  const REPOSITORY_URL = '/projects/api/repositories/qits-ci';
  const WORKSPACES_URL = '/workspaces/api/workspaces?repositoryId=qits-ci';
  const ACTIVE_PROCESS_URL = '/workspaces/api/workspaces/7/active-process';

  beforeEach(async () => {
    streams = [];
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: EVENT_SOURCE_FACTORY,
          useValue: (url: string) => {
            const stream = new FakeStream(url);
            streams.push(stream);
            return stream;
          },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => http.verify());

  /** Let the request chain land, then render. One `whenStable` can return mid-chain. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.fixture.whenStable();
    harness.detectChanges();
  }

  function element(): HTMLElement {
    return harness.fixture.nativeElement as HTMLElement;
  }

  function page(): WorkspaceDetailPage {
    return harness.fixture.debugElement.query(By.directive(WorkspaceDetailPage))
      .componentInstance as WorkspaceDetailPage;
  }

  function tabs(): HTMLButtonElement[] {
    return Array.from(element().querySelectorAll('.strip .tab'));
  }

  /** Open the page and answer its three reads. */
  async function open(
    url = '/repositories/qits-ci/workspaces/7',
    workspaces: readonly WorkspaceDto[] = [workspace(7, 'widgets')],
    processId: string | null = null,
  ): Promise<void> {
    await harness.navigateByUrl(url);
    http.expectOne(REPOSITORY_URL).flush({ repository: REPOSITORY });
    http
      .expectOne(WORKSPACES_URL)
      .flush({ entries: workspaces.map((entry) => ({ workspace: entry })) });
    http
      .expectOne((request) => request.url.endsWith('/active-process'))
      .flush({ technicalProcessId: processId });
    await settle();
  }

  /**
   * The Files panel's own budget, paid the first time its tab is selected and never again — the `T`
   * in the page's `3 + T`. Two reads of one workspace's container: the whole eager tree, and the
   * detection that gates the framework footer.
   */
  function answerFilesPanel(workspaceRowId = 7): void {
    http
      .expectOne(`/workspaces/container/${workspaceRowId}/files`)
      .flush({ paths: [], lazyDirs: [], generation: 'gen-1' });
    http
      .expectOne(`/workspaces/container/${workspaceRowId}/detection`)
      .flush({ projects: [], frameworks: [], links: [], generation: 'gen-1' });
  }

  it('reads three things and opens one stream, and nothing else', async () => {
    await harness.navigateByUrl('/repositories/qits-ci/workspaces/7');

    const requests = http.match(() => true);

    expect(requests.map((request) => request.request.urlWithParams).sort()).toEqual(
      [ACTIVE_PROCESS_URL, REPOSITORY_URL, WORKSPACES_URL].sort(),
    );
    expect(streams.map((stream) => stream.url)).toEqual(['/workspaces/api/workspaces/7/events']);

    for (const request of requests) {
      if (request.request.url === REPOSITORY_URL) {
        request.flush({ repository: REPOSITORY });
      } else if (request.request.url.endsWith('/active-process')) {
        request.flush({ technicalProcessId: null });
      } else {
        request.flush({ entries: [{ workspace: workspace(7, 'widgets') }] });
      }
    }
    await settle();
  });

  it('draws the workspace, its branch and where it was forked from', async () => {
    await open();

    expect(element().textContent).toContain('widgets');
    expect(element().textContent).toContain('task/widgets');
    expect(element().textContent).toContain('forked from');
  });

  it('selects the first tab for a bare URL, and does not write the slug into it', async () => {
    await open();

    expect(TestBed.inject(Location).path()).toBe('/repositories/qits-ci/workspaces/7');
    expect(element().querySelector('.tab.active')?.textContent?.trim()).toBe('Chat');
  });

  it('puts the chosen tab in the URL, so every tab is a link', async () => {
    await open();
    const files = tabs().find((tab) => tab.textContent?.trim() === 'Files')!;

    files.click();
    await settle();
    // Selecting a tab that has never been opened costs that tab's requests, which is exactly why the
    // tab is in the URL: it is expensive state, so it is addressable state.
    answerFilesPanel();
    await settle();

    expect(TestBed.inject(Location).path()).toContain('tab=files');
    expect(element().querySelector('.tab.active')?.textContent?.trim()).toBe('Files');
  });

  it('normalises an unknown slug away rather than obeying it', async () => {
    await open('/repositories/qits-ci/workspaces/7?tab=sketch');
    await settle();

    expect(TestBed.inject(Location).path()).toBe('/repositories/qits-ci/workspaces/7');
  });

  it('reuses the page across a tab change and rebuilds it across a workspace change', async () => {
    await open('/repositories/qits-ci/workspaces/7', [
      workspace(7, 'widgets'),
      workspace(8, 'other'),
    ]);
    const detail = page();
    expect(detail.remounts()).toBe(0);

    await harness.navigateByUrl('/repositories/qits-ci/workspaces/7?tab=files');
    await settle();
    answerFilesPanel(7);
    await settle();
    expect(detail.remounts()).toBe(0);

    // A move within one repository re-reads the process lookup and nothing else: the list already
    // holds every workspace in the repository, and re-asking for it would be a second copy.
    await harness.navigateByUrl('/repositories/qits-ci/workspaces/8?tab=files');
    http
      .expectOne((request) => request.url.endsWith('/8/active-process'))
      .flush({ technicalProcessId: null });
    await settle();
    // The remount tore the panel down with the rest of the subtree, so it reads the new container.
    answerFilesPanel(8);
    await settle();

    expect(detail.remounts()).toBe(1);
    expect(element().textContent).toContain('task/other');
  });

  it('does not open a resolved workspace — it shows the record and says why', async () => {
    await open('/repositories/qits-ci/workspaces/9', [workspace(7, 'widgets')]);

    http.expectOne('/workspaces/api/history/9').flush({
      workspace: {
        id: 9,
        workspaceId: 'old-work',
        parent: 'main',
        status: 'INTEGRATED',
        preamble: null,
        result: 'integrate(main): the thing',
        createdAt: '2026-07-31T21:32:23Z',
        resolvedAt: '2026-07-31T21:32:35Z',
        events: [],
      },
    });
    await settle();

    expect(element().textContent).toContain('old-work');
    expect(element().textContent).toContain('the work is finished');
    expect(element().querySelector('app-tab-host')).toBeNull();
  });

  it('says so plainly when there is no such workspace, live or resolved', async () => {
    await open('/repositories/qits-ci/workspaces/9', [workspace(7, 'widgets')]);

    http
      .expectOne('/workspaces/api/history/9')
      .flush({ message: 'Workspace not found: 9' }, { status: 404, statusText: 'Not Found' });
    await settle();

    expect(element().textContent).toContain('No such workspace here');
  });

  it('grows the transient tab when a process is running, pinned to the front and selected', async () => {
    await open('/repositories/qits-ci/workspaces/7', [workspace(7, 'widgets')], 'proc-1');

    expect(tabs()[0].textContent?.trim()).toBe('Starting');
    expect(element().querySelector('.tab.active')?.textContent?.trim()).toBe('Starting');
    // The transient tab is deliberately not in the URL: it unmounts, and a link to it lands nowhere.
    expect(TestBed.inject(Location).path()).toBe('/repositories/qits-ci/workspaces/7');
  });

  it('shows every workspace with agent activity, not only this one', async () => {
    await open('/repositories/qits-ci/workspaces/7', [
      workspace(7, 'widgets', { agentActivity: 'BUSY' }),
      workspace(8, 'other', { agentActivity: 'WAITING' }),
      workspace(9, 'quiet'),
    ]);

    const entries = Array.from(element().querySelectorAll('.bar .entry .name')).map(
      (node) => (node as HTMLElement).textContent,
    );

    expect(entries).toEqual(['task/widgets', 'task/other']);
  });
});
