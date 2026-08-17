import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { ProjectDto, RepositoryDto, WorkspaceDto } from '../api/dto';
import { ProjectsApi } from '../api/projects-api';
import { WorkspacesApi } from '../api/workspaces-api';
import { serverMessage } from '../ui/loadable';

/** One project's wrapper repository, named as the picker shows it. */
interface Choice {
  readonly project: ProjectDto;
  readonly repository: RepositoryDto;
}

/**
 * The root view: the aggregate workspaces that exist, and the one form that makes another.
 *
 * **Every project's wrapper is offered, and only its wrapper.** An aggregate workspace branches a
 * wrapper and every registered submodule under it, so an ordinary component repository would offer
 * a create the service refuses. The rule is the service's own answer and not a derivation of it:
 * the repositories read carries a `wrapper` view whose `repositoryId` names the row, and this page
 * admits that row. It used to filter on the literal name `qits-qits`, which offered the platform's
 * own wrapper and no other project's.
 *
 * **`?repository=<id>` preselects one.** The projects SPA links here from a project's own page, and
 * an id naming no admitted wrapper is ignored — a stale link lands on the ordinary first choice
 * rather than on an empty picker.
 *
 * **The list needs a repository before it can be read.** qits-workspaces' listing takes a mandatory
 * `repositoryId`, so with no choice admitted there is nothing to ask for and the page shows an empty
 * list rather than a failed request.
 *
 * **Create is three steps in a fixed order**: the service forks the branch tree, the container is
 * then asked to start, and only then does the page navigate to the detail view — which is where the
 * starting process is actually watched. Navigating first would leave the container unstarted if the
 * second request never went out.
 */
@Component({
  selector: 'app-workspaces-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink],
  templateUrl: './workspaces-page.html',
  styleUrl: './workspaces-page.css',
})
export class WorkspacesPage implements OnInit {
  private readonly projectsApi = inject(ProjectsApi);
  private readonly workspacesApi = inject(WorkspacesApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly choices = signal<readonly Choice[]>([]);
  protected readonly workspaces = signal<readonly WorkspaceDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly creating = signal(false);
  protected readonly error = signal<string | null>(null);
  protected branch = 'adhoc-changes';
  protected selectedRepositoryId = '';

  async ngOnInit(): Promise<void> {
    try {
      const projects = await this.projectsApi.projects();
      const candidates = await Promise.all(
        projects.map(async (project) => ({
          project,
          components: await this.projectsApi.components(project.id),
        })),
      );
      const choices = candidates.flatMap(({ project, components }) => {
        const wrapperId = components.wrapper?.repositoryId;
        const repository = components.repositories.find((entry) => entry.id === wrapperId);
        // A wrapper the row list does not hold is drift the projects SPA reconciles; there is no
        // repository here to branch, so the project simply offers no choice.
        return repository ? [{ project, repository }] : [];
      });
      this.choices.set(choices);
      this.selectedRepositoryId = this.preselected(choices) ?? choices[0]?.repository.id ?? '';
      await this.reload();
    } catch (failure) {
      this.error.set(this.message(failure, 'Could not load workspaces.'));
    } finally {
      this.loading.set(false);
    }
  }

  protected async selectionChanged(): Promise<void> {
    try {
      await this.reload();
    } catch (failure) {
      this.error.set(this.message(failure, 'Could not load workspaces.'));
    }
  }

  protected async create(): Promise<void> {
    const choice = this.choices().find(
      (entry) => entry.repository.id === this.selectedRepositoryId,
    );
    const branch = this.branch.trim();
    if (!choice || !branch || this.creating()) return;
    // The service accepts `[A-Za-z0-9_-]{1,64}` as a workspace id and refuses anything else with a
    // 400, so a branch name that carries no such character has no id to send at all.
    const id = this.slug(branch);
    if (!id) {
      this.error.set('The branch name needs a letter or a number.');
      return;
    }
    this.creating.set(true);
    this.error.set(null);
    try {
      const created = await this.workspacesApi.createWorkspace({
        repositoryId: choice.repository.id,
        id,
        parent: choice.repository.mainBranch,
        branch,
        preamble: '',
        adoptExisting: false,
        branchTree: true,
      });
      await this.workspacesApi.ensureContainer(created.id);
      await this.router.navigate(['/repositories', choice.repository.id, 'workspaces', created.id]);
    } catch (failure) {
      this.error.set(this.message(failure, 'Could not create the workspace.'));
      // The list is re-read because a 409 usually means the workspace is already there. A failure
      // of that read must not overwrite the message that explains the press.
      await this.reload().catch(() => undefined);
    } finally {
      this.creating.set(false);
    }
  }

  /**
   * The wrapper `?repository=` asks for, when the picker actually holds it.
   *
   * An id that names nothing admitted answers null and the first choice stands. A link carried over
   * from a deleted project, or to a repository that is not a wrapper, is a stale link and not an
   * error worth stopping on.
   */
  private preselected(choices: readonly Choice[]): string | null {
    const asked = this.route.snapshot.queryParamMap.get('repository');
    return choices.some((choice) => choice.repository.id === asked) ? asked : null;
  }

  private async reload(): Promise<void> {
    if (!this.selectedRepositoryId) {
      this.workspaces.set([]);
      return;
    }
    this.workspaces.set(await this.workspacesApi.workspaces(this.selectedRepositoryId));
  }

  private slug(branch: string): string {
    return branch
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }

  /** The service's own words when it sent any, and this page's sentence when it did not. */
  private message(failure: unknown, fallback: string): string {
    const body = failure instanceof HttpErrorResponse ? failure.error : null;
    return serverMessage(body) ?? fallback;
  }
}
