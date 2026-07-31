import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { QitsButton } from '@qits/ui-components';
import type { IntegrateResponse, ProjectDto, RepositoryDto, WorkspaceDto } from '../api/dto';
import { ProjectsApi } from '../api/projects-api';
import { WorkspacesApi } from '../api/workspaces-api';
import { IntegratePanel } from '../integrate/integrate-panel';
import { Async } from '../ui/async';
import { Empty } from '../ui/empty';
import { IDLE, LOADING, failed, ready, type Loadable } from '../ui/loadable';
import { WorkspaceRow } from './workspace-row';

/** A release made on this screen: the workspace it came from, and what the service answered. */
export interface ReleaseRecord {
  readonly workspaceLabel: string;
  readonly result: IntegrateResponse;
}

/**
 * A repository's live workspaces, and the one action that turns one of them into a release.
 *
 * **Why a repository has to be picked at all.** qits-workspaces' listing takes a mandatory
 * `repositoryId` and the service owns no repository listing of its own — it holds the id as an
 * opaque string, in a different database, with no join. So the picker is two reads against
 * qits-projects, and it is the price of the service boundary rather than a screen someone wanted.
 * The choice rides in the query parameters (`/workspaces/?project=…&repository=…`) so a repository
 * a person works in every day is a bookmark, and so the back button means "the previous one".
 *
 * **Releases are recorded above the list, not in the row that made them.** A successful integrate
 * resolves its workspace, so the next listing does not contain it — a success surface living in
 * that row would flash and vanish, taking the version and the merge sha with it. Those two strings
 * are the entire useful output of the action, so they are lifted to the page, where they outlive
 * both the row and the reload.
 */
@Component({
  selector: 'app-workspaces-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, Empty, IntegratePanel, QitsButton, WorkspaceRow],
  templateUrl: './workspaces-page.html',
  styleUrl: './workspaces-page.css',
})
export class WorkspacesPage {
  private readonly projectsApi = inject(ProjectsApi);
  private readonly workspacesApi = inject(WorkspacesApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly projects = signal<Loadable<readonly ProjectDto[]>>(LOADING);
  protected readonly repositories = signal<Loadable<readonly RepositoryDto[]>>(IDLE);
  protected readonly workspaces = signal<Loadable<readonly WorkspaceDto[]>>(IDLE);

  /** Every release made since this page was opened, newest first. */
  protected readonly releases = signal<readonly ReleaseRecord[]>([]);

  private loadedProjectId: string | null = null;
  private loadedRepositoryId: string | null = null;

  private readonly queryParams = toSignal(this.route.queryParamMap, {
    initialValue: convertToParamMap({}),
  });

  protected readonly selectedProjectId = computed(() => this.queryParams().get('project') ?? '');
  protected readonly selectedRepositoryId = computed(
    () => this.queryParams().get('repository') ?? '',
  );

  protected readonly projectList = computed(() => {
    const state = this.projects();
    return state.kind === 'ready' ? state.value : [];
  });

  protected readonly repositoryList = computed(() => {
    const state = this.repositories();
    return state.kind === 'ready' ? state.value : [];
  });

  protected readonly workspaceList = computed(() => {
    const state = this.workspaces();
    return state.kind === 'ready' ? state.value : [];
  });

  /**
   * The chosen repository, resolved against the listing rather than trusted from the URL.
   *
   * This is what makes the destination branch a fact instead of an assumption: `mainBranch` comes
   * from qits-projects, and the panel names it. Every repository in this platform says "main"
   * today, and none of them promises to.
   */
  protected readonly repository = computed<RepositoryDto | null>(
    () =>
      this.repositoryList().find((repository) => repository.id === this.selectedRepositoryId()) ??
      null,
  );

  /** The branch an integrate lands on. Empty until the repository is known — and then it is real. */
  protected readonly targetBranch = computed(() => this.repository()?.mainBranch ?? '');

  protected readonly summary = computed(() => {
    const repository = this.repository();
    if (!repository) {
      return 'Pick a repository to see its workspaces.';
    }
    const state = this.workspaces();
    if (state.kind !== 'ready') {
      return `Live workspaces in ${repository.id}.`;
    }
    const count = state.value.length;
    return (
      `${count} live ${count === 1 ? 'workspace' : 'workspaces'} in ${repository.id}, ` +
      `each one integrable into ${repository.mainBranch}.`
    );
  });

  constructor() {
    void this.loadProjects();

    // What the URL says is chosen, is loaded — on first paint, on a deep link, and on the back
    // button. Each guard is what keeps a re-render from re-issuing a request that is already out.
    effect(() => {
      const projectId = this.selectedProjectId();
      if (projectId !== this.loadedProjectId) {
        this.loadedProjectId = projectId;
        this.loadedRepositoryId = null;
        this.workspaces.set(IDLE);
        void this.loadRepositories(projectId);
      }
    });

    // Keyed on the *resolved* repository, not the parameter: the workspace list is only fetched
    // once the repository is known to exist, which is also when its default branch is known. A
    // parameter naming a repository this project does not hold therefore loads nothing and says so,
    // rather than 404ing against qits-workspaces with a repository id it was never going to accept.
    effect(() => {
      const repositoryId = this.repository()?.id ?? '';
      if (repositoryId !== this.loadedRepositoryId) {
        this.loadedRepositoryId = repositoryId;
        void this.loadWorkspaces(repositoryId);
      }
    });
  }

  protected async loadProjects(): Promise<void> {
    this.projects.set(LOADING);
    try {
      this.projects.set(ready(await this.projectsApi.projects()));
    } catch (error) {
      this.projects.set(failed(error));
    }
  }

  protected async loadRepositories(projectId: string): Promise<void> {
    if (!projectId) {
      this.repositories.set(IDLE);
      return;
    }
    this.repositories.set(LOADING);
    try {
      this.repositories.set(ready(await this.projectsApi.repositories(projectId)));
    } catch (error) {
      this.repositories.set(failed(error));
    }
  }

  protected async loadWorkspaces(repositoryId: string): Promise<void> {
    if (!repositoryId) {
      this.workspaces.set(IDLE);
      return;
    }
    this.workspaces.set(LOADING);
    try {
      this.workspaces.set(ready(await this.workspacesApi.workspaces(repositoryId)));
    } catch (error) {
      this.workspaces.set(failed(error));
    }
  }

  /** Re-read the list. The one button in the header, and the way out of a stale "already in". */
  protected reloadWorkspaces(): void {
    void this.loadWorkspaces(this.repository()?.id ?? '');
  }

  /** Retry for the repository picker, which has no `repository()` to key on yet. */
  protected reloadRepositories(): void {
    void this.loadRepositories(this.selectedProjectId());
  }

  /**
   * A release landed: record it, then re-read the list.
   *
   * The record comes first and deliberately does not depend on the reload succeeding. The version
   * and the merge sha exist whether or not the next request does, and losing them to a failed
   * refresh would lose the only copy the user has.
   */
  protected onIntegrated(workspace: WorkspaceDto, result: IntegrateResponse): void {
    this.releases.update((releases) => [
      { workspaceLabel: workspace.workspaceId, result },
      ...releases,
    ]);
    this.reloadWorkspaces();
  }

  protected chooseProject(event: Event): void {
    const projectId = (event.target as HTMLSelectElement).value;
    // The repository parameter is dropped rather than kept: repositories belong to one project, so
    // carrying the old id across would name something the new project does not hold.
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { project: projectId || null, repository: null },
      queryParamsHandling: 'merge',
    });
  }

  protected chooseRepository(event: Event): void {
    const repositoryId = (event.target as HTMLSelectElement).value;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { repository: repositoryId || null },
      queryParamsHandling: 'merge',
    });
  }
}
