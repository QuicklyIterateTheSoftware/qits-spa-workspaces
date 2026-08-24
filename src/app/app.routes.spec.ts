import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideQitsRepositoryList, provideQitsScope } from '@qits/ui-components';
import { EVENT_SOURCE_FACTORY, type EventSourceLike } from './api/event-source';
import { routes } from './app.routes';
import { WorkspaceDetailPage } from './detail/workspace-detail-page';
import { NotFound } from './not-found/not-found';
import { WorkspacesPage } from './overview/workspaces-page';

/**
 * One page, three spellings of every address.
 *
 * This application is served at the root of its own host, so `/repositories/r1/workspaces/12`,
 * `/qits/repositories/r1/workspaces/12` and `/qits/services/qits-ci/repositories/r1/workspaces/12`
 * are the same workspace seen unscoped, under a project and under the repository the reader came in
 * through. All three have to reach the same component.
 *
 * The trap the guard exists for is the other direction: `repositories` is not a project slug, and
 * without `canMatch` on the category the repository branch would claim this application's own three
 * leading segments as a project, a category and a repository.
 */
describe('routes', () => {
  let harness: RouterTestingHarness;

  /** The detail page opens a stream on arrival, and jsdom has no `EventSource`. */
  const noStream: EventSourceLike = {
    onopen: null,
    onmessage: null,
    onerror: null,
    readyState: 1,

    close: () => undefined,
  };

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideQitsRepositoryList([]),
        provideQitsScope('repository'),
        { provide: EVENT_SOURCE_FACTORY, useValue: () => noStream },
      ],
    });
    harness = await RouterTestingHarness.create();
  });

  /**
   * The component the URL activated. The harness hands back the component of the route it mounted,
   * which here is always the layout; the page is the leaf below it.
   */
  async function activated(url: string): Promise<unknown> {
    await harness.navigateByUrl(url);
    let route = TestBed.inject(Router).routerState.snapshot.root;
    while (route.firstChild) route = route.firstChild;
    return route.component;
  }

  it('serves the overview bare', async () => {
    expect(await activated('/')).toBe(WorkspacesPage);
  });

  it('serves the overview under a repository', async () => {
    expect(await activated('/qits/services/qits-ci')).toBe(WorkspacesPage);
  });

  it('serves a workspace bare', async () => {
    expect(await activated('/repositories/r1/workspaces/12')).toBe(WorkspaceDetailPage);
  });

  it('serves the same workspace under a repository', async () => {
    expect(await activated('/qits/services/qits-ci/repositories/r1/workspaces/12')).toBe(
      WorkspaceDetailPage,
    );
  });

  it('lets its own literal segments win over the scoped form', async () => {
    // `repositories` would otherwise read as a project slug and `r1` as a category.
    expect(await activated('/repositories/r1/nope')).toBe(NotFound);
  });

  it('serves the overview under a project', async () => {
    // Where the chrome's project picker sends this app when a reader picks `qits`.
    expect(await activated('/qits')).toBe(WorkspacesPage);
  });

  it('serves a workspace under a project', async () => {
    expect(await activated('/qits/repositories/r1/workspaces/12')).toBe(WorkspaceDetailPage);
  });

  it('lets its own literal segments win over the project form', async () => {
    // `/repositories/r1/workspaces/12` is this app's detail page, never a project called
    // `repositories`.
    expect(await activated('/repositories/r1/workspaces/12')).toBe(WorkspaceDetailPage);
  });

  it('refuses a middle segment that is not a category', async () => {
    expect(await activated('/qits/nonsense/qits-ci')).toBe(NotFound);
  });

  it('serves every category', async () => {
    for (const category of ['services', 'daemons', 'libs', 'frontends', 'cli', 'images']) {
      expect(await activated(`/qits/${category}/qits-ci`)).toBe(WorkspacesPage);
    }
  });
});
