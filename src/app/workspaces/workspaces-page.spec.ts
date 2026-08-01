import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from '../app.routes';
import type { WorkspaceDto } from '../api/dto';

/**
 * The page's states, driven through `HttpTestingController` and the real router.
 *
 * Two assertions carry more than their length. **Nothing is requested from qits-workspaces until a
 * repository is resolved**, because its listing takes a mandatory `repositoryId` and a speculative
 * call would be a guaranteed 4xx per page load. And **what landed survives the reload that removes
 * the workspace** — a merge resolves the workspace, so the very next listing does not contain it,
 * and a success surface living in that row would take the version and the merge sha off screen a
 * few hundred milliseconds after producing them. Those strings are the whole output of the action.
 */
describe('WorkspacesPage', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;

  const PROJECTS_URL = '/projects/api/projects';
  const REPOSITORIES_URL = '/projects/api/projects/p1/repositories';
  const WORKSPACES_URL = '/workspaces/api/workspaces';
  const RELEASE_URL = '/workspaces/api/workspaces/7/release';
  const INTEGRATE_URL = '/workspaces/api/workspaces/8/integrate';

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
   * The page's requests chain: the repositories arrive, an effect notices the repository is now
   * resolved, and only then is the workspace listing asked for. A single `whenStable()` can return
   * before that chain has finished, so the next request would not exist yet — which is a flaky
   * spec, not a real one.
   */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.fixture.whenStable();
  }

  function page(): HTMLElement {
    return harness.fixture.nativeElement as HTMLElement;
  }

  function flushProjects(): void {
    http
      .expectOne(PROJECTS_URL)
      .flush({ entries: [{ project: { id: 'p1', name: 'qits', slug: 'qits' } }] });
  }

  function flushRepositories(mainBranch = 'main'): void {
    http.expectOne(REPOSITORIES_URL).flush({
      entries: [
        {
          repository: {
            id: 'qits-ci',
            url: 'ssh://git@example/qits-ci.git',
            mainBranch,
            archetype: 'SERVICE',
            projectId: 'p1',
          },
        },
      ],
    });
  }

  function flushWorkspaces(workspaces: readonly WorkspaceDto[]): void {
    http
      .expectOne((candidate) => candidate.url === WORKSPACES_URL)
      .flush({ entries: workspaces.map((entry) => ({ workspace: entry })) });
  }

  /** Land on the page with a repository already chosen, everything flushed. */
  async function openAt(workspaces: readonly WorkspaceDto[], mainBranch = 'main'): Promise<void> {
    harness = await RouterTestingHarness.create('/?project=p1&repository=qits-ci');
    flushProjects();
    await settle();
    flushRepositories(mainBranch);
    await settle();
    flushWorkspaces(workspaces);
    await settle();
  }

  function button(label: string): HTMLButtonElement {
    const found = [...page().querySelectorAll('button')].find((candidate) =>
      (candidate.textContent ?? '').trim().includes(label),
    );
    if (!found) {
      throw new Error(`no button labelled "${label}"`);
    }
    return found;
  }

  it('reads the projects and asks qits-workspaces for nothing until a repository is chosen', async () => {
    harness = await RouterTestingHarness.create('/');
    flushProjects();
    await settle();

    // A workspace listing without a repositoryId is a guaranteed refusal, so it is not attempted.
    http.expectNone((candidate) => candidate.url === WORKSPACES_URL);
    expect(page().textContent).toContain('Pick a repository');
  });

  it('loads a project’s repositories when the project select changes', async () => {
    harness = await RouterTestingHarness.create('/');
    flushProjects();
    await settle();

    const select = page().querySelectorAll('select')[0];
    select.value = 'p1';
    select.dispatchEvent(new Event('change'));
    await settle();

    flushRepositories();
    await settle();
    http.expectNone((candidate) => candidate.url === WORKSPACES_URL);
    expect(page().textContent).toContain('qits-ci');
  });

  it('lists a repository’s workspaces from a deep link', async () => {
    await openAt([workspace(7, 'explorer-grouping'), workspace(8, 'dns-records')]);

    const rows = page().querySelectorAll('app-workspace-row');
    expect(rows.length).toBe(2);
    expect(page().textContent).toContain('explorer-grouping');
    expect(page().textContent).toContain('2 live workspaces in qits-ci');
  });

  it('names the repository’s own default branch rather than assuming “main”', async () => {
    // Every repository here says main and none of them promises to; the destination is read from
    // qits-projects, so a repository on `trunk` is described correctly — and a workspace parented
    // on `trunk` is the one that gets the release door.
    await openAt([workspace(7, 'explorer-grouping', { parent: 'trunk' })], 'trunk');
    expect(page().textContent).toContain('merges into');
    expect(page().textContent).toContain('trunk');
    expect(button('Release…')).toBeTruthy();
  });

  it('gives each row the door its parent branch calls for', async () => {
    await openAt([
      workspace(7, 'explorer-grouping'),
      workspace(8, 'group-runs', { parent: 'epic/explorer', branch: 'task/group-runs' }),
    ]);

    const doors = [...page().querySelectorAll('app-merge-panel button')].map((candidate) =>
      (candidate.textContent ?? '').trim(),
    );
    expect(doors).toEqual(['Release…', 'Integrate…']);
  });

  it('says a repository has no live workspaces rather than drawing nothing', async () => {
    await openAt([]);
    expect(page().textContent).toContain('No live workspaces');
  });

  it('offers a retry when the workspace listing fails', async () => {
    harness = await RouterTestingHarness.create('/?project=p1&repository=qits-ci');
    flushProjects();
    await settle();
    flushRepositories();
    await settle();
    http
      .expectOne((candidate) => candidate.url === WORKSPACES_URL)
      .flush({ message: 'no such repository' }, { status: 404, statusText: 'Not Found' });
    await settle();

    expect(page().textContent).toContain('Could not load the workspaces');

    button('Retry').click();
    await settle();
    flushWorkspaces([workspace(7, 'explorer-grouping')]);
    await settle();

    expect(page().textContent).toContain('explorer-grouping');
  });

  /** Open a row's door, write a summary and submit it. */
  async function sendThroughTheDoor(door: string, summary: string): Promise<void> {
    button(door).click();
    await settle();

    const input = page().querySelector<HTMLInputElement>('input.summary');
    if (!input) {
      throw new Error('the summary field is not on screen');
    }
    input.value = summary;
    input.dispatchEvent(new Event('input'));
    await settle();

    page()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
  }

  it('keeps the version and the merge sha after the reload drops the released workspace', async () => {
    await openAt([workspace(7, 'explorer-grouping')]);
    await sendThroughTheDoor('Release…', 'teach the explorer to group runs by repository');

    http.expectOne(RELEASE_URL).flush({
      version: '2026.731.193059',
      commitSha: '9f2c1ab3d4e5f60718293a4b5c6d7e8f90123456',
      branch: 'explorer-grouping',
    });
    await settle();

    // The success resolves the workspace, so the list it came from no longer holds it.
    flushWorkspaces([]);
    await settle();

    const landed = page().querySelector('.landed');
    expect(landed?.textContent).toContain('2026.731.193059');
    expect(landed?.textContent).toContain('9f2c1ab3d4e5f60718293a4b5c6d7e8f90123456');
    expect(landed?.textContent).toContain('explorer-grouping');
    expect(page().querySelectorAll('app-workspace-row').length).toBe(0);
    expect(page().textContent).toContain('No live workspaces');
  });

  it('records an integrate by where it landed, with no version to show for it', async () => {
    await openAt([
      workspace(8, 'group-runs', { parent: 'epic/explorer', branch: 'task/group-runs' }),
    ]);
    await sendThroughTheDoor('Integrate…', 'land the task on its epic');

    http.expectOne(INTEGRATE_URL).flush({
      commitSha: '4b5c6d7e8f90123456789abcdef0123456789abc',
      branch: 'task/group-runs',
      targetBranch: 'epic/explorer',
    });
    await settle();

    flushWorkspaces([]);
    await settle();

    const landed = page().querySelector('.landed');
    expect(landed?.textContent).toContain('task/group-runs');
    expect(landed?.textContent).toContain('epic/explorer');
    expect(landed?.textContent).toContain('4b5c6d7e8f90123456789abcdef0123456789abc');
    // No version was stamped, so the record shows none rather than a blank where one would be.
    expect(landed?.querySelector('strong')).toBeNull();
  });

  it('re-reads the list when a row reports it is already integrated', async () => {
    await openAt([workspace(7, 'explorer-grouping')]);
    await sendThroughTheDoor('Release…', 'anything');

    http
      .expectOne(RELEASE_URL)
      .flush({ message: 'already integrated' }, { status: 409, statusText: 'Conflict' });
    await settle();

    button('Refresh the list').click();
    await settle();

    // Nothing is recorded — nothing landed — and the list is simply read again.
    flushWorkspaces([]);
    await settle();
    expect(page().querySelector('.landed')).toBeNull();
    expect(page().textContent).toContain('No live workspaces');
  });
});
