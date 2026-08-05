import type { BranchDto, RepositoryDto, WorkspaceDto } from '../api/dto';
import type { Loadable } from '../ui/loadable';

/**
 * The shape of the overview, worked out in plain functions so the page can be about rendering.
 *
 * The screen is a deliberate simplification: repositories are roots, the work inside them is
 * children, and there is no project layer and no epic layer between the two. Projects survive only
 * as a label on a root row, because a repository name is not always enough to place it.
 */

/** A child row that has a workspace: something is being worked on. */
export interface WorkspaceChild {
  readonly kind: 'workspace';
  readonly key: string;
  readonly workspace: WorkspaceDto;
}

/** A child row that has only a branch: work exists, but nothing is set up to do it in. */
export interface BranchChild {
  readonly kind: 'branch';
  readonly key: string;
  readonly branch: BranchDto;
}

export type TreeChild = WorkspaceChild | BranchChild;

/** One repository, its two reads, and the rows they make between them. */
export interface RepositoryNode {
  readonly repository: RepositoryDto;
  readonly projectName: string;
  readonly workspaces: Loadable<readonly WorkspaceDto[]>;
  readonly branches: Loadable<readonly BranchDto[]>;
  readonly children: readonly TreeChild[];
  /** Both reads have answered — ready or failed. Until then "no children" is not yet a fact. */
  readonly settled: boolean;
  /** The newest workspace's creation instant, in milliseconds, or null when there is none to know. */
  readonly newestAt: number | null;
  /** Branches here with a create in flight, by name. Carried on the node so the row can say so. */
  readonly creating: ReadonlySet<string>;
  /** Branches here whose last create failed, by name, with the reason. */
  readonly createErrors: ReadonlyMap<string, string>;
}

/**
 * When a workspace was created, in milliseconds — or null, which covers two cases on purpose.
 *
 * A service that does not send `createdAt` yet and a value that will not parse are the same fact to
 * a sort: the age is unknown. Neither is turned into a number, because a workspace ordered as
 * epoch-zero would sit at the bottom claiming to be the oldest thing on the platform.
 */
export function createdAtMillis(workspace: WorkspaceDto): number | null {
  if (!workspace.createdAt) {
    return null;
  }
  const at = Date.parse(workspace.createdAt);
  return Number.isNaN(at) ? null : at;
}

/** Newest first, unknown last. Ties keep the order the service sent, because `sort` is stable. */
function byNewest(left: WorkspaceDto, right: WorkspaceDto): number {
  const a = createdAtMillis(left);
  const b = createdAtMillis(right);
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return b - a;
}

/**
 * The rows under one repository: its workspaces, newest first, then the branches nobody is working
 * on yet, alphabetically.
 *
 * **The join is by branch name and the workspace wins.** A workspace whose branch has vanished from
 * the branch list still gets a row — the work is real whether or not the mirror has caught up — and
 * a branch that a workspace has claimed never gets a second, workspace-less row beside it.
 *
 * **The main branch is not a child.** It is the trunk every one of these branches forked from, not
 * a piece of work, and offering to create a workspace on it would be offering to work on the
 * release branch directly.
 */
export function childRows(
  workspaces: readonly WorkspaceDto[],
  branches: readonly BranchDto[],
  mainBranch: string,
): readonly TreeChild[] {
  const claimed = new Set<string>();
  const workspaceRows: TreeChild[] = [...workspaces].sort(byNewest).map((workspace) => {
    claimed.add(workspace.branch ?? workspace.workspaceId);
    return { kind: 'workspace', key: `workspace:${workspace.id}`, workspace };
  });

  const branchRows: TreeChild[] = branches
    .filter((branch) => branch.name !== mainBranch && !claimed.has(branch.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((branch) => ({ kind: 'branch', key: `branch:${branch.name}`, branch }));

  return [...workspaceRows, ...branchRows];
}

/** The newest thing going on in a repository, or null when nothing there dates itself. */
export function newestWorkspaceAt(workspaces: readonly WorkspaceDto[]): number | null {
  let newest: number | null = null;
  for (const workspace of workspaces) {
    const at = createdAtMillis(workspace);
    if (at !== null && (newest === null || at > newest)) {
      newest = at;
    }
  }
  return newest;
}

/**
 * Roots in the order they are worth reading: most recently worked in first.
 *
 * Everything else — a repository still loading, one with no workspaces, one whose service does not
 * date them — goes below, alphabetically. That is a single rule with a single reason: the top of
 * this page is for what somebody is in the middle of, and a repository that cannot prove it is
 * recent does not get to sit there.
 */
export function sortRoots(nodes: readonly RepositoryNode[]): readonly RepositoryNode[] {
  return [...nodes].sort((left, right) => {
    if (left.newestAt !== null && right.newestAt !== null) {
      return right.newestAt - left.newestAt;
    }
    if (left.newestAt !== null) {
      return -1;
    }
    if (right.newestAt !== null) {
      return 1;
    }
    return repositoryLabel(left.repository).localeCompare(repositoryLabel(right.repository));
  });
}

/**
 * The name a person knows the repository by.
 *
 * The listing carries no name field: platform-seeded repositories use the name as their id, while
 * user-registered ones get a UUID id — so the id alone renders half the page as hex. The clone
 * url's last segment is the human name in both cases; the id stays the fallback for a url the
 * rule cannot read.
 */
export function repositoryLabel(repository: RepositoryDto): string {
  const tail = repository.url?.split('/').filter(Boolean).pop();
  if (!tail) {
    return repository.id;
  }
  return tail.endsWith('.git') ? tail.slice(0, -'.git'.length) : tail;
}

/** The most a workspace label may be, server-side and here. */
export const WORKSPACE_ID_MAX_LENGTH = 64;

/**
 * A branch name turned into a workspace label the service will accept.
 *
 * The rule is the server's: `[A-Za-z0-9_-]` only, no more than {@link WORKSPACE_ID_MAX_LENGTH}
 * characters, and never dash-leading — a label becomes a directory and a container name, so
 * `feature/add-thing` is `feature-add-thing`. A name that survives none of that (`///`) falls back
 * to `workspace` rather than being posted as something the service will refuse.
 *
 * Collisions are then suffixed `-2`, `-3`, … against the labels the repository already has, because
 * a label is unique only among a repository's *active* workspaces and is handed out again once one
 * resolves. The stem is trimmed to make room for the suffix, so no candidate can exceed the cap —
 * the monolith's version trimmed to a fixed 62 and produced a 65-character label at `-10`.
 */
export function deriveWorkspaceId(branch: string, taken: ReadonlySet<string>): string {
  let stem = branch.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, WORKSPACE_ID_MAX_LENGTH);
  if (stem === '' || stem.startsWith('-')) {
    stem = 'workspace';
  }
  if (!taken.has(stem)) {
    return stem;
  }
  for (let ordinal = 2; ; ordinal++) {
    const suffix = `-${ordinal}`;
    const candidate = `${stem.slice(0, WORKSPACE_ID_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}
