import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { QitsButton } from '@qits/ui-components';
import type { BranchDto, ProjectDto, RepositoryDto, WorkspaceDto } from '../api/dto';
import { ProjectsApi } from '../api/projects-api';
import { WorkspacesApi } from '../api/workspaces-api';
import { Async } from '../ui/async';
import { Empty } from '../ui/empty';
import { LOADING, describeError, failed, ready, type Loadable } from '../ui/loadable';
import {
  childRows,
  deriveWorkspaceId,
  newestWorkspaceAt,
  sortRoots,
  type RepositoryNode,
} from './overview-tree';
import { RepositoryNodeView } from './repository-node';

/** One project's repository listing, while it is still out or once it has failed. */
export interface ProjectReadState {
  readonly projectId: string;
  readonly projectName: string;
  readonly state: Loadable<readonly RepositoryDto[]>;
}

/**
 * Everything in flight, across every project, as one tree.
 *
 * **A repository is a root and a piece of work is a child.** That is a deliberate simplification of
 * a larger model — project, then epic, then workspace — and it is the smallest thing that answers
 * the question people open this page with: what am I in the middle of. Projects survive as a label
 * beside a repository name, because a repository name alone does not always place it.
 *
 * **The picker is gone.** It existed because qits-workspaces' listing takes a mandatory
 * `repositoryId` and the service owns no repository listing of its own, so somebody had to name
 * one. The tree pays that price differently: every project's repositories are read, and every
 * repository's workspaces are asked for at once. Which is why —
 *
 * **every repository loads on its own.** The workspace listing is the expensive call on this
 * platform — it refreshes the repository's mirror and then asks docker what is running — so one
 * all-or-nothing barrier would hold the page at the speed of its worst repository. Each root owns
 * its own two `Loadable`s and draws whatever has landed.
 *
 * **A branch with no workspace is a row with an offer.** The join is by branch name, and the trunk
 * is left out of it: the repository's default branch is what everything here forked from rather
 * than a piece of work, so it is never a child and is never offered a workspace.
 *
 * **No stream.** Refresh is a button, as it was before. Live updates here would mean one SSE
 * channel per repository, which is a connection budget nobody has agreed to spend.
 */
@Component({
  selector: 'app-workspaces-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, Empty, QitsButton, RepositoryNodeView],
  templateUrl: './workspaces-page.html',
  styleUrl: './workspaces-page.css',
})
export class WorkspacesPage {
  private readonly projectsApi = inject(ProjectsApi);
  private readonly workspacesApi = inject(WorkspacesApi);

  protected readonly projects = signal<Loadable<readonly ProjectDto[]>>(LOADING);

  private readonly repositoriesByProject = signal<
    ReadonlyMap<string, Loadable<readonly RepositoryDto[]>>
  >(new Map());
  private readonly workspacesByRepository = signal<
    ReadonlyMap<string, Loadable<readonly WorkspaceDto[]>>
  >(new Map());
  private readonly branchesByRepository = signal<
    ReadonlyMap<string, Loadable<readonly BranchDto[]>>
  >(new Map());

  /**
   * Creates in flight, and creates that failed — keyed by repository and branch together.
   *
   * One flat key rather than a map of maps: a branch name means nothing without its repository (four
   * of them hold a `fix-lint`), and a single string is what makes "is this row busy" a lookup.
   */
  private readonly creating = signal<ReadonlySet<string>>(new Set());
  private readonly createErrors = signal<ReadonlyMap<string, string>>(new Map());

  /** The tree, most recently worked in first, rebuilt from whatever has landed so far. */
  protected readonly roots = computed<readonly RepositoryNode[]>(() => {
    const projects = this.projects();
    if (projects.kind !== 'ready') {
      return [];
    }
    const repositoriesByProject = this.repositoriesByProject();
    const workspacesByRepository = this.workspacesByRepository();
    const branchesByRepository = this.branchesByRepository();
    const creating = this.creating();
    const createErrors = this.createErrors();

    const nodes: RepositoryNode[] = [];
    for (const project of projects.value) {
      const repositories = repositoriesByProject.get(project.id);
      if (repositories?.kind !== 'ready') {
        continue;
      }
      for (const repository of repositories.value) {
        // Absent means the request is out but has not been recorded yet, which is loading — not
        // idle. Nothing on this page is unasked-for.
        const workspaces = workspacesByRepository.get(repository.id) ?? LOADING;
        const branches = branchesByRepository.get(repository.id) ?? LOADING;
        nodes.push({
          repository,
          projectName: project.name,
          workspaces,
          branches,
          children: childRows(
            workspaces.kind === 'ready' ? workspaces.value : [],
            branches.kind === 'ready' ? branches.value : [],
            repository.mainBranch,
          ),
          settled: answered(workspaces) && answered(branches),
          newestAt: workspaces.kind === 'ready' ? newestWorkspaceAt(workspaces.value) : null,
          creating: scoped(creating, repository.id),
          createErrors: scopedMessages(createErrors, repository.id),
        });
      }
    }
    return sortRoots(nodes);
  });

  /** The repository listings still out or failed, so that neither is silent. */
  protected readonly projectReads = computed<readonly ProjectReadState[]>(() => {
    const projects = this.projects();
    if (projects.kind !== 'ready') {
      return [];
    }
    const byProject = this.repositoriesByProject();
    return projects.value
      .map((project) => ({
        projectId: project.id,
        projectName: project.name,
        state: byProject.get(project.id) ?? LOADING,
      }))
      .filter((read) => read.state.kind !== 'ready');
  });

  protected readonly summary = computed(() => {
    const projects = this.projects();
    if (projects.kind !== 'ready') {
      return 'Everything in flight, across every project.';
    }
    const repositories = this.roots().length;
    const count = projects.value.length;
    return (
      `${repositories} ${repositories === 1 ? 'repository' : 'repositories'} across ` +
      `${count} ${count === 1 ? 'project' : 'projects'}. Most recently worked in first; ` +
      'a branch with no workspace can be given one.'
    );
  });

  constructor() {
    void this.load();
  }

  /** The whole page, from the projects down. First paint and the Refresh button share it. */
  protected async load(): Promise<void> {
    this.projects.set(LOADING);
    this.repositoriesByProject.set(new Map());
    this.workspacesByRepository.set(new Map());
    this.branchesByRepository.set(new Map());
    this.createErrors.set(new Map());
    let projects: readonly ProjectDto[];
    try {
      projects = await this.projectsApi.projects();
    } catch (error) {
      this.projects.set(failed(error));
      return;
    }
    this.projects.set(ready(projects));
    // Fanned out rather than awaited in turn: there is no all-repositories endpoint, so this is one
    // request per project, and a slow project must not hold up the ones behind it.
    for (const project of projects) {
      void this.loadRepositories(project.id);
    }
  }

  /** One project's repositories, and then the two reads under each of them. */
  protected async loadRepositories(projectId: string): Promise<void> {
    this.putRepositories(projectId, LOADING);
    let repositories: readonly RepositoryDto[];
    try {
      repositories = await this.projectsApi.repositories(projectId);
    } catch (error) {
      this.putRepositories(projectId, failed(error));
      return;
    }
    this.putRepositories(projectId, ready(repositories));
    for (const repository of repositories) {
      void this.loadWorkspaces(repository.id);
      void this.loadBranches(repository.id);
    }
  }

  /**
   * One repository's workspaces.
   *
   * `keepShowing` is what a re-read after a create asks for: the rows stay put while the new list is
   * fetched. Blanking them to a shimmer would take the failed row — and the message explaining why
   * it failed — off screen a moment after producing it.
   */
  protected async loadWorkspaces(repositoryId: string, keepShowing = false): Promise<void> {
    if (!keepShowing) {
      this.putWorkspaces(repositoryId, LOADING);
    }
    try {
      this.putWorkspaces(repositoryId, ready(await this.workspacesApi.workspaces(repositoryId)));
    } catch (error) {
      this.putWorkspaces(repositoryId, failed(error));
    }
  }

  protected async loadBranches(repositoryId: string): Promise<void> {
    this.putBranches(repositoryId, LOADING);
    try {
      this.putBranches(repositoryId, ready(await this.projectsApi.branches(repositoryId)));
    } catch (error) {
      this.putBranches(repositoryId, failed(error));
    }
  }

  /**
   * Adopt a branch: create a workspace over the branch that is already there.
   *
   * `adoptExisting` is what makes this one press instead of a dialog. The branch exists, the parent
   * is the repository's own default branch, and the goal is unwritten — so there is nothing to ask
   * for, and the label is derived from the branch name under the server's slug rule.
   *
   * The list is re-read afterwards **whether or not the create succeeded**, and for this repository
   * only. A 409 here means the branch already has an active workspace, which is precisely what a
   * double press produces, so the honest answer to a failure is to show what is actually there.
   */
  protected async createWorkspace(repository: RepositoryDto, branch: string): Promise<void> {
    const key = createKey(repository.id, branch);
    if (this.creating().has(key)) {
      return;
    }
    this.creating.update((keys) => added(keys, key));
    this.createErrors.update((messages) => dropped(messages, key));
    try {
      await this.workspacesApi.createWorkspace({
        repositoryId: repository.id,
        id: deriveWorkspaceId(branch, this.labelsTakenIn(repository.id)),
        parent: repository.mainBranch,
        branch,
        preamble: '',
        adoptExisting: true,
      });
    } catch (error) {
      this.createErrors.update((messages) => new Map(messages).set(key, describeError(error)));
    } finally {
      this.creating.update((keys) => removed(keys, key));
    }
    await this.loadWorkspaces(repository.id, true);
  }

  /** The labels this repository has already handed out — what a new one must not collide with. */
  private labelsTakenIn(repositoryId: string): ReadonlySet<string> {
    const state = this.workspacesByRepository().get(repositoryId);
    const workspaces = state?.kind === 'ready' ? state.value : [];
    return new Set(workspaces.map((workspace) => workspace.workspaceId));
  }

  private putRepositories(projectId: string, state: Loadable<readonly RepositoryDto[]>): void {
    this.repositoriesByProject.update((byProject) => new Map(byProject).set(projectId, state));
  }

  private putWorkspaces(repositoryId: string, state: Loadable<readonly WorkspaceDto[]>): void {
    this.workspacesByRepository.update((byRepository) =>
      new Map(byRepository).set(repositoryId, state),
    );
  }

  private putBranches(repositoryId: string, state: Loadable<readonly BranchDto[]>): void {
    this.branchesByRepository.update((byRepository) =>
      new Map(byRepository).set(repositoryId, state),
    );
  }
}

/** The read is over, one way or the other — which is when "nothing here" becomes sayable. */
function answered(state: Loadable<unknown>): boolean {
  return state.kind === 'ready' || state.kind === 'error';
}

/**
 * Repository and branch in one key.
 *
 * A space is a safe separator rather than a lucky one: git refuses a refname containing one, and a
 * repository id is a directory name on the git host.
 */
function createKey(repositoryId: string, branch: string): string {
  return `${repositoryId} ${branch}`;
}

/** The branch names in this repository, out of a set keyed by {@link createKey}. */
function scoped(keys: ReadonlySet<string>, repositoryId: string): ReadonlySet<string> {
  const prefix = `${repositoryId} `;
  const names = new Set<string>();
  for (const key of keys) {
    if (key.startsWith(prefix)) {
      names.add(key.slice(prefix.length));
    }
  }
  return names;
}

/** The same narrowing for the failure messages, which the row draws beside its button. */
function scopedMessages(
  messages: ReadonlyMap<string, string>,
  repositoryId: string,
): ReadonlyMap<string, string> {
  const prefix = `${repositoryId} `;
  const scopedTo = new Map<string, string>();
  for (const [key, message] of messages) {
    if (key.startsWith(prefix)) {
      scopedTo.set(key.slice(prefix.length), message);
    }
  }
  return scopedTo;
}

function added(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  return new Set(keys).add(key);
}

function removed(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(keys);
  next.delete(key);
  return next;
}

function dropped(messages: ReadonlyMap<string, string>, key: string): ReadonlyMap<string, string> {
  const next = new Map(messages);
  next.delete(key);
  return next;
}
