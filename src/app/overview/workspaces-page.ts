import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { ProjectDto, RepositoryDto, WorkspaceDto } from '../api/dto';
import { ProjectsApi } from '../api/projects-api';
import { WorkspacesApi } from '../api/workspaces-api';
import { serverMessage } from '../ui/loadable';

/** One project's aggregate repository, named as the picker shows it. */
interface Choice {
  readonly project: ProjectDto;
  readonly repository: RepositoryDto;
}

/**
 * The root view: the aggregate workspaces that exist, and the one form that makes another.
 *
 * **Only a repository named `qits-qits` is offered.** An aggregate workspace branches a wrapper and
 * every registered submodule under it, and this platform has exactly one such wrapper today. The
 * picker is a dropdown anyway, because the name is the only thing that limits it — the day a second
 * aggregate exists, this filter widens and nothing else on the page moves.
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
          repositories: await this.projectsApi.repositories(project.id),
        })),
      );
      const choices = candidates.flatMap(({ project, repositories }) =>
        repositories
          .filter((repository) => repository.name === 'qits-qits')
          .map((repository) => ({ project, repository })),
      );
      this.choices.set(choices);
      this.selectedRepositoryId = choices[0]?.repository.id ?? '';
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
