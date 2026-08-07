import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ProjectsApi } from './projects-api';

/**
 * qits-projects wraps every list in `entries`, and every entry in the name of the thing it holds.
 * That is genuinely different from the workspace listing's own envelope, so the client unwraps
 * rather than pretending the two services agree.
 */
describe('ProjectsApi', () => {
  let api: ProjectsApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(ProjectsApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('unwraps the project entries', async () => {
    const projects = api.projects();
    http.expectOne('/projects/api/projects').flush({
      entries: [
        { project: { id: 'p1', name: 'qits', slug: 'qits', description: null, dns: null } },
      ],
    });
    await expect(projects).resolves.toMatchObject([{ id: 'p1', name: 'qits' }]);
  });

  it('unwraps one project’s repository entries, keeping the default branch', async () => {
    // `mainBranch` is the field this app came for: it is what an integrate lands on, and it is
    // named on screen rather than assumed to be "main".
    const repositories = api.repositories('p1');
    http.expectOne('/projects/api/projects/p1/repositories').flush({
      entries: [
        {
          repository: {
            id: 'qits-ci',
            name: 'qits-ci',
            backupUrl: 'ssh://git@example/QuicklyIterate/qits-ci.git',
            mainBranch: 'main',
            archetype: 'SERVICE',
            projectId: 'p1',
          },
        },
      ],
    });
    await expect(repositories).resolves.toMatchObject([{ id: 'qits-ci', mainBranch: 'main' }]);
  });

  it('reads a repository’s branches from its own path, not the project’s', async () => {
    // The branch list is the overview's other half: it is the only place a branch with no workspace
    // can be found, because qits-workspaces knows nothing about refs it did not create.
    const branches = api.branches('qits-ci');
    http.expectOne('/projects/api/repositories/qits-ci/branches').flush({
      branches: [
        { name: 'main', canCleanup: false, parent: null, ahead: null, behind: null },
        { name: 'fix-lint', canCleanup: false, parent: null, ahead: null, behind: null },
      ],
    });
    await expect(branches).resolves.toMatchObject([{ name: 'main' }, { name: 'fix-lint' }]);
  });

  it('reads a branch-free repository as no branches rather than as a crash', async () => {
    const branches = api.branches('qits-ci');
    http.expectOne('/projects/api/repositories/qits-ci/branches').flush({});
    await expect(branches).resolves.toEqual([]);
  });
});
