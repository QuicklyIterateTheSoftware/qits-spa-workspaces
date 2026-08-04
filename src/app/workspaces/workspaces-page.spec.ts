import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { WorkspaceDto } from '../api/dto';
import { routes } from '../app.routes';

/**
 * The overview, driven through `HttpTestingController` and the real router.
 *
 * Three assertions carry more than their length. **A repository that is still loading does not hold
 * up the one beside it** — the workspace listing refreshes a mirror and asks docker what is running,
 * so a page-wide barrier would make the page only ever as fast as its worst repository. **The create
 * body is frozen**, because `adoptExisting`, the derived label and the parent branch are the whole
 * of what that one press means, and a wrong one of them either forks a branch nobody asked for or
 * is refused outright. And **only the repository that was created in is re-read**, since the
 * expensive call is exactly the one a page-wide refresh would issue once per repository.
 */
describe('WorkspacesPage', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;

  const PROJECTS_URL = '/projects/api/projects';
  const WORKSPACES_URL = '/workspaces/api/workspaces';

  const repositoriesUrl = (projectId: string) => `/projects/api/projects/${projectId}/repositories`;
  const branchesUrl = (repositoryId: string) =>
    `/projects/api/repositories/${repositoryId}/branches`;

  const workspace = (
    id: number,
    label: string,
    over: Partial<WorkspaceDto> = {},
  ): WorkspaceDto => ({
    id,
    workspaceId: label,
    parent: 'main',
    branch: label,
    ahead: 3,
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
    daemonConnectedAt: null,
    daemonVersion: null,
    daemonBuildTime: null,
    daemonOutdated: null,
    ...over,
  });

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  /**
   * Let every pending microtask land, then render.
   *
   * The page's requests chain three deep — the projects, then each project's repositories, then two
   * reads per repository — so a single `whenStable()` can return before the next request exists.
   */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.fixture.whenStable();
  }

  function page(): HTMLElement {
    return harness.fixture.nativeElement as HTMLElement;
  }

  function flushProjects(projects: readonly { id: string; name: string }[]): void {
    http.expectOne(PROJECTS_URL).flush({
      entries: projects.map((project) => ({
        project: { ...project, slug: project.id, description: null, dns: null },
      })),
    });
  }

  function flushRepositories(
    projectId: string,
    repositories: readonly { id: string; mainBranch?: string }[],
  ): void {
    http.expectOne(repositoriesUrl(projectId)).flush({
      entries: repositories.map((repository) => ({
        repository: {
          id: repository.id,
          url: `ssh://git@example/${repository.id}.git`,
          mainBranch: repository.mainBranch ?? 'main',
          archetype: 'SERVICE',
          projectId,
        },
      })),
    });
  }

  function expectWorkspaces(repositoryId: string) {
    return http.expectOne(
      (candidate) =>
        candidate.method === 'GET' &&
        candidate.url === WORKSPACES_URL &&
        candidate.params.get('repositoryId') === repositoryId,
    );
  }

  function flushWorkspaces(repositoryId: string, workspaces: readonly WorkspaceDto[]): void {
    expectWorkspaces(repositoryId).flush({
      entries: workspaces.map((entry) => ({ workspace: entry })),
    });
  }

  function flushBranches(repositoryId: string, names: readonly string[]): void {
    http.expectOne(branchesUrl(repositoryId)).flush({
      branches: names.map((name) => ({
        name,
        canCleanup: false,
        parent: null,
        ahead: null,
        behind: null,
      })),
    });
  }

  function nodes(): readonly HTMLElement[] {
    return [...page().querySelectorAll<HTMLElement>('app-repository-node')];
  }

  function rootNames(): readonly string[] {
    return nodes().map((node) => node.querySelector('h2')?.textContent?.trim() ?? '');
  }

  function button(within: ParentNode, label: string): HTMLButtonElement {
    const found = [...within.querySelectorAll('button')].find((candidate) =>
      (candidate.textContent ?? '').trim().includes(label),
    );
    if (!found) {
      throw new Error(`no button labelled "${label}"`);
    }
    return found;
  }

  /** The common opening: two projects, one repository each, nothing flushed below that. */
  async function openTwoRepositories(): Promise<void> {
    harness = await RouterTestingHarness.create('/');
    flushProjects([
      { id: 'p1', name: 'qits' },
      { id: 'p2', name: 'wohlben' },
    ]);
    await settle();
    flushRepositories('p1', [{ id: 'qits-ci' }]);
    flushRepositories('p2', [{ id: 'qits-spa-home' }]);
    await settle();
  }

  it('draws each repository as a root, with the project it belongs to beside it', async () => {
    await openTwoRepositories();
    flushWorkspaces('qits-ci', [workspace(7, 'fix-lint')]);
    flushBranches('qits-ci', ['main', 'fix-lint']);
    flushWorkspaces('qits-spa-home', []);
    flushBranches('qits-spa-home', ['main']);
    await settle();

    expect(rootNames()).toEqual(['qits-ci', 'qits-spa-home']);
    expect(nodes()[0].textContent).toContain('qits');
    expect(nodes()[1].textContent).toContain('wohlben');
    // Nothing at all under the second one, and it says so rather than drawing a blank band.
    expect(nodes()[1].querySelector('app-empty')).not.toBeNull();
  });

  it('renders the repository that answered while the other is still loading', async () => {
    await openTwoRepositories();
    flushWorkspaces('qits-ci', [workspace(7, 'fix-lint')]);
    flushBranches('qits-ci', ['main', 'fix-lint']);
    flushBranches('qits-spa-home', ['main']);
    await settle();

    // The slow repository is already a root, with its own waiting state — not a page-wide barrier.
    expect(rootNames()).toEqual(['qits-ci', 'qits-spa-home']);
    expect(nodes()[0].querySelector('app-workspace-row')).not.toBeNull();
    expect(nodes()[0].querySelector('.async-loading')).toBeNull();
    expect(nodes()[1].querySelector('.async-loading')).not.toBeNull();
    // "Nothing here" is not yet a fact for a repository that has not answered.
    expect(nodes()[1].querySelector('app-empty')).toBeNull();

    flushWorkspaces('qits-spa-home', []);
    await settle();
    expect(nodes()[1].querySelector('app-empty')).not.toBeNull();
  });

  it('leaves each repository’s own trunk out of the tree', async () => {
    await openTwoRepositories();
    flushWorkspaces('qits-ci', []);
    flushBranches('qits-ci', ['main', 'fix-lint']);
    flushWorkspaces('qits-spa-home', []);
    flushBranches('qits-spa-home', ['main', 'trunk']);
    await settle();

    // One branch row under qits-ci: `main` is the trunk, not work.
    const rows = nodes()[0].querySelectorAll('app-branch-row');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('fix-lint');
    // And the trunk is the repository's *own* default branch: qits-spa-home says main too, so its
    // `trunk` branch is ordinary work and keeps its row.
    expect(nodes()[1].querySelectorAll('app-branch-row').length).toBe(1);
  });

  it('sorts the busiest repository first, and undated work last within it', async () => {
    await openTwoRepositories();
    flushWorkspaces('qits-ci', [workspace(7, 'fix-lint', { createdAt: '2026-08-01T09:00:00Z' })]);
    flushBranches('qits-ci', ['main']);
    flushWorkspaces('qits-spa-home', [
      workspace(8, 'undated'),
      workspace(9, 'newest', { createdAt: '2026-08-04T09:00:00Z' }),
    ]);
    flushBranches('qits-spa-home', ['main']);
    await settle();

    expect(rootNames()).toEqual(['qits-spa-home', 'qits-ci']);
    const labels = [...nodes()[0].querySelectorAll('app-workspace-row h3')].map((heading) =>
      heading.textContent?.trim(),
    );
    expect(labels).toEqual(['newest', 'undated']);
  });

  it('works without createdAt at all, sorting the repository that has none below', async () => {
    await openTwoRepositories();
    flushWorkspaces('qits-ci', [workspace(7, 'fix-lint')]);
    flushBranches('qits-ci', ['main']);
    flushWorkspaces('qits-spa-home', [
      workspace(8, 'dated', { createdAt: '2026-07-01T09:00:00Z' }),
    ]);
    flushBranches('qits-spa-home', ['main']);
    await settle();

    // The page renders either way; it simply cannot claim qits-ci is recent.
    expect(rootNames()).toEqual(['qits-spa-home', 'qits-ci']);
    expect(nodes()[1].querySelector('app-workspace-row')?.textContent).toContain('fix-lint');
  });

  it('offers a workspace on a branch that has none, and posts exactly what adoption means', async () => {
    await openTwoRepositories();
    // The label `feature-fix-lint` is already taken by a workspace on another branch, so the derived
    // one has to step around it.
    flushWorkspaces('qits-ci', [workspace(7, 'feature-fix-lint', { branch: 'something-else' })]);
    flushBranches('qits-ci', ['main', 'feature/fix-lint', 'something-else']);
    flushWorkspaces('qits-spa-home', []);
    flushBranches('qits-spa-home', ['main']);
    await settle();

    const rows = nodes()[0].querySelectorAll('app-branch-row');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('feature/fix-lint');

    button(rows[0], 'Create workspace').click();
    await settle();

    const create = http.expectOne(
      (candidate) => candidate.method === 'POST' && candidate.url === WORKSPACES_URL,
    );
    expect(create.request.body).toEqual({
      repositoryId: 'qits-ci',
      id: 'feature-fix-lint-2',
      parent: 'main',
      branch: 'feature/fix-lint',
      preamble: '',
      adoptExisting: true,
    });
    create.flush({ workspace: workspace(8, 'feature-fix-lint-2', { branch: 'feature/fix-lint' }) });
    await settle();

    // Only this repository is re-read: the workspace listing is the expensive call on the platform,
    // and nothing about the other repository changed.
    http.expectNone(
      (candidate) =>
        candidate.url === WORKSPACES_URL &&
        candidate.params.get('repositoryId') === 'qits-spa-home',
    );
    http.expectNone(branchesUrl('qits-ci'));
    flushWorkspaces('qits-ci', [
      workspace(7, 'feature-fix-lint', { branch: 'something-else' }),
      workspace(8, 'feature-fix-lint-2', { branch: 'feature/fix-lint' }),
    ]);
    await settle();

    expect(nodes()[0].querySelectorAll('app-workspace-row').length).toBe(2);
    expect(nodes()[0].querySelectorAll('app-branch-row').length).toBe(0);
  });

  it('keeps a failed create on the row that caused it, and then shows what is really there', async () => {
    await openTwoRepositories();
    flushWorkspaces('qits-ci', []);
    flushBranches('qits-ci', ['main', 'fix-lint']);
    flushWorkspaces('qits-spa-home', []);
    flushBranches('qits-spa-home', ['main']);
    await settle();

    button(nodes()[0], 'Create workspace').click();
    await settle();

    http
      .expectOne((candidate) => candidate.method === 'POST' && candidate.url === WORKSPACES_URL)
      .flush(
        { message: 'branch already has an active workspace' },
        { status: 409, statusText: 'Conflict' },
      );
    await settle();

    // The reason stays on the row that produced it rather than blanking to a shimmer.
    expect(nodes()[0].querySelector('app-branch-row')?.textContent).toContain(
      'branch already has an active workspace',
    );

    // The list is re-read regardless: a 409 here means the workspace exists, which is worth seeing.
    flushWorkspaces('qits-ci', [workspace(9, 'fix-lint')]);
    await settle();

    expect(nodes()[0].querySelectorAll('app-workspace-row').length).toBe(1);
    expect(nodes()[0].querySelectorAll('app-branch-row').length).toBe(0);
  });

  it('offers a retry for the one repository whose workspaces failed', async () => {
    await openTwoRepositories();
    expectWorkspaces('qits-ci').flush(
      { message: 'no such repository' },
      { status: 404, statusText: 'Not Found' },
    );
    flushBranches('qits-ci', ['main']);
    flushWorkspaces('qits-spa-home', []);
    flushBranches('qits-spa-home', ['main']);
    await settle();

    expect(nodes()[0].textContent).toContain('Could not load the workspaces');

    button(nodes()[0], 'Retry').click();
    await settle();
    flushWorkspaces('qits-ci', [workspace(7, 'fix-lint')]);
    await settle();

    expect(nodes()[0].textContent).toContain('fix-lint');
  });

  it('names the project whose repository listing failed, and retries that one alone', async () => {
    harness = await RouterTestingHarness.create('/');
    flushProjects([
      { id: 'p1', name: 'qits' },
      { id: 'p2', name: 'wohlben' },
    ]);
    await settle();
    http
      .expectOne(repositoriesUrl('p1'))
      .flush({ message: 'gone' }, { status: 503, statusText: 'Service Unavailable' });
    flushRepositories('p2', [{ id: 'qits-spa-home' }]);
    await settle();
    flushWorkspaces('qits-spa-home', []);
    flushBranches('qits-spa-home', ['main']);
    await settle();

    expect(page().textContent).toContain('Could not load the repositories in qits');

    button(page(), 'Retry').click();
    await settle();
    flushRepositories('p1', [{ id: 'qits-ci' }]);
    await settle();
    flushWorkspaces('qits-ci', []);
    flushBranches('qits-ci', ['main']);
    await settle();

    expect(rootNames()).toContain('qits-ci');
  });
});
