import { Location } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { ProjectDto, RepositoryDto, WorkspaceDto } from '../api/dto';
import { routes } from '../app.routes';
import { WorkspacesPage } from './workspaces-page';

const PROJECT: ProjectDto = {
  id: 'p1',
  name: 'qits',
  slug: 'qits',
  description: null,
  dns: null,
};

const repository = (id: string, over: Partial<RepositoryDto> = {}): RepositoryDto => ({
  id,
  name: id,
  backupUrl: `https://example.invalid/${id}.git`,
  mainBranch: 'main',
  archetype: 'SERVICE',
  projectId: 'p1',
  ...over,
});

const workspace = (over: Partial<WorkspaceDto> = {}): WorkspaceDto => ({
  id: 12,
  workspaceId: 'adhoc-changes',
  parent: 'main',
  branch: 'adhoc-changes',
  ahead: 0,
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

/**
 * The front door: what it offers to branch, and what one press actually sends.
 *
 * **The picker is filtered by name, and that is asserted.** An aggregate workspace forks a wrapper
 * and everything registered under it, so offering an ordinary service repository would offer a
 * create the service refuses. The filter is the whole of the rule, so a second repository in the
 * same project has to stay out of the dropdown.
 *
 * **`branchTree` is the flag the whole feature hangs on.** Without it qits-workspaces makes the
 * plain single-repository workspace it always made, on the wrapper alone — a create that looks
 * successful and leaves every submodule unbranched. So the payload is asserted field by field.
 *
 * **The container is started before the page navigates.** The detail view watches a starting
 * process; navigating first and starting after would leave the container unstarted whenever the
 * second request never went out.
 */
describe('WorkspacesPage', () => {
  let http: HttpTestingController;

  const PROJECTS_URL = '/projects/api/projects';
  const REPOSITORIES_URL = '/projects/api/projects/p1/repositories';
  const WORKSPACES_URL = '/workspaces/api/workspaces?repositoryId=qits-qits';

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

  /** Let the request chain land, then render. One `whenStable` can return mid-chain. */
  const settle = async (fixture: ComponentFixture<WorkspacesPage>): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
    fixture.detectChanges();
  };

  /**
   * Open the page over one project holding the wrapper and one ordinary repository.
   *
   * `repositories` is answered per project because qits-projects has no all-repositories endpoint;
   * `workspaces` is only asked for once a repository is admitted, which is why the caller can leave
   * it out.
   */
  const open = async (
    options: { repositories?: readonly RepositoryDto[]; workspaces?: readonly WorkspaceDto[] } = {},
  ): Promise<ComponentFixture<WorkspacesPage>> => {
    const repositories = options.repositories ?? [repository('qits-qits'), repository('qits-ci')];
    const fixture = TestBed.createComponent(WorkspacesPage);
    await settle(fixture);

    http.expectOne(PROJECTS_URL).flush({ entries: [{ project: PROJECT }] });
    await settle(fixture);

    http
      .expectOne(REPOSITORIES_URL)
      .flush({ entries: repositories.map((entry) => ({ repository: entry })) });
    await settle(fixture);

    if (repositories.some((entry) => entry.name === 'qits-qits')) {
      http
        .expectOne(WORKSPACES_URL)
        .flush({ entries: (options.workspaces ?? []).map((entry) => ({ workspace: entry })) });
      await settle(fixture);
    }
    return fixture;
  };

  const text = (fixture: ComponentFixture<WorkspacesPage>): string =>
    (fixture.nativeElement as HTMLElement).textContent ?? '';

  const submit = async (fixture: ComponentFixture<WorkspacesPage>): Promise<void> => {
    (fixture.nativeElement as HTMLElement)
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle(fixture);
  };

  it('offers the wrapper alone and lists the workspaces it already has', async () => {
    const fixture = await open({ workspaces: [workspace({ branch: 'adhoc-changes' })] });

    const options = (fixture.nativeElement as HTMLElement).querySelectorAll('option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain('qits-qits');
    expect(text(fixture)).toContain('adhoc-changes');
    expect(text(fixture)).toContain('running');
  });

  it('says a workspace with no runtime state is unknown rather than stopped', async () => {
    const fixture = await open({ workspaces: [workspace({ runtimeStatus: null })] });

    expect(text(fixture)).toContain('runtime unknown');
    expect(text(fixture)).not.toContain('stopped');
  });

  it('asks for no workspaces at all when the project holds no wrapper', async () => {
    const fixture = await open({ repositories: [repository('qits-ci')] });

    // No repository, no listing: qits-workspaces' listing takes a mandatory `repositoryId`, and
    // `http.verify()` in the teardown is what proves nothing was asked for anyway.
    expect(text(fixture)).toContain('No active workspaces yet');
  });

  it('creates the branch tree, starts the container, and then opens the workspace', async () => {
    const fixture = await open();

    await submit(fixture);

    const create = http.expectOne('/workspaces/api/workspaces');
    expect(create.request.body).toEqual({
      repositoryId: 'qits-qits',
      id: 'adhoc-changes',
      parent: 'main',
      branch: 'adhoc-changes',
      preamble: '',
      adoptExisting: false,
      branchTree: true,
    });
    create.flush({ workspace: workspace() });
    await settle(fixture);

    http.expectOne('/workspaces/api/workspaces/12/ensure-container').flush({});
    await settle(fixture);

    expect(TestBed.inject(Location).path()).toBe('/repositories/qits-qits/workspaces/12');
  });

  it('keeps the service’s own words when a create is refused, and re-reads the list', async () => {
    const fixture = await open();

    await submit(fixture);

    http
      .expectOne('/workspaces/api/workspaces')
      .flush(
        { message: 'Branch already exists in qits-ci: adhoc-changes' },
        { status: 409, statusText: 'Conflict' },
      );
    await settle(fixture);

    http.expectOne(WORKSPACES_URL).flush({ entries: [] });
    await settle(fixture);

    expect(text(fixture)).toContain('Branch already exists in qits-ci: adhoc-changes');
    expect(TestBed.inject(Location).path()).toBe('');
  });
});
