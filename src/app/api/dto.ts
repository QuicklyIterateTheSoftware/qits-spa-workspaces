/**
 * The wire shapes this client reads and writes, hand-written and copied field-for-field from the
 * Java records on the other side (`WorkspaceDto` and `WorkspaceController`'s nested request records
 * in qits-workspaces; `ProjectDto` and `RepositoryDto` in qits-projects).
 *
 * Hand-written rather than generated, deliberately (the explorer plan's Decision 1). The platform
 * generates OpenAPI *documents*, not clients, and every controller nests its request and response
 * records inside the request type, so a generator names them positionally — qits-projects'
 * committed document already calls the list-projects response `Response19` and one entry `Entry4`.
 *
 * The envelopes are genuinely inconsistent across the two services — `{entries: [{workspace: …}]}`
 * for the workspace list, `{entries: [{project: …}]}` and `{entries: [{repository: …}]}` for
 * projects — and the interfaces say so rather than pretending otherwise.
 *
 * `Instant` arrives as an ISO-8601 string; every timestamp below is typed as one.
 */

/** A workspace's resolution state. `ACTIVE` is the only one an integrate can be offered on. */
export type WorkspaceStatus = 'ACTIVE' | 'INTEGRATED' | 'ABANDONED';

/**
 * The container's runtime state, independent of {@link WorkspaceStatus}: the branch is the source
 * of truth and the container is a recreatable cache of it.
 *
 * It is shown here and never gated on. **Integrate reads the durable branch, not the container** —
 * qits-workspaces merges from the bare origin's refs — so a STOPPED workspace integrates exactly
 * as well as a RUNNING one, and disabling the button on one would be a fiction.
 */
export type WorkspaceRuntimeStatus = 'RUNNING' | 'STOPPED' | 'PROVISIONING' | 'FAILED';

/** The coding-agent activity rollup, as last reported by the in-container `workspace-daemon`. */
export type AgentActivityState = 'IDLE' | 'BUSY' | 'WAITING';

/**
 * One workspace, as qits-workspaces lists it.
 *
 * `id` is the identifier every route addresses — including the integrate one. `workspaceId` is the
 * branch-derived *label*: unique only per repository and reusable once the workspace resolves, so
 * it is displayed and never used to address anything.
 */
export interface WorkspaceDto {
  readonly id: number;
  readonly workspaceId: string;
  readonly parent: string | null;
  readonly branch: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly conflictsWithParent: boolean;
  readonly status: WorkspaceStatus;
  readonly runtimeStatus: WorkspaceRuntimeStatus | null;
  readonly runtimeError: string | null;
  readonly clean: boolean | null;
  readonly agentActivity: AgentActivityState | null;
  readonly preamble: string | null;
  readonly result: string | null;
  readonly resolvedAt: string | null;
  readonly daemonConnectedAt: string | null;
  readonly daemonVersion: string | null;
  readonly daemonBuildTime: string | null;
  readonly daemonOutdated: boolean | null;
}

/** The workspace list envelope: entries, each wrapping the thing it lists. */
export interface WorkspaceEntriesResponse {
  readonly entries: readonly { readonly workspace: WorkspaceDto }[];
}

/**
 * What `POST /workspaces/api/workspaces/{id}/integrate` takes. One field, and no target.
 *
 * **The target is not a parameter: it is always the repository's default branch by construction.**
 * That is the feature — integrate is the one door into `main` — so a client that could name a
 * target would be describing an API that does not exist.
 *
 * The summary becomes the merge commit's subject, as `release(<version>): <summary>`. It is capped
 * at 100 characters on both sides: the conventional 72-character subject budget minus roughly the
 * 24 the version scope costs, rounded to a number a person can be told.
 */
export interface IntegrateRequest {
  readonly summary: string;
}

/** The summary cap, server-side `@Size(max = 100)` and the input's `maxlength` alike. */
export const SUMMARY_MAX_LENGTH = 100;

/**
 * What a successful integrate answers.
 *
 * All three fields are worth showing and none is derivable from the others: `version` is the stamp
 * that was just minted (`2026.731.193059` — year, month+day, time, as integers), `commitSha` is the
 * merge commit that carries both the merge and the version bump, and `branch` is the source branch
 * that was integrated, which the merge's parents record as a sha but never as a name.
 */
export interface IntegrateResponse {
  readonly version: string;
  readonly commitSha: string;
  readonly branch: string;
}

/** A project's dns record, or the whole object is null when it registers no domain. */
export interface ProjectDnsRecordDto {
  readonly domain: string;
  readonly type: string;
  readonly value: string;
}

/** A project. The spine of the repository picker and nothing more here. */
export interface ProjectDto {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly dns: ProjectDnsRecordDto | null;
}

/** projects' list envelope: entries, each wrapping the thing it lists. */
export interface ProjectEntriesResponse {
  readonly entries: readonly { readonly project: ProjectDto }[];
}

/** What kind of thing a repository is. Shown beside its name; nothing branches on it. */
export type RepositoryArchetype =
  'PROJECT' | 'SERVICE' | 'LIBRARY' | 'INTEGRATION' | 'APPLICATION' | 'SERVICE_TEMPLATE' | 'FORK';

/**
 * A repository.
 *
 * `id` is the git-host directory name, and it is the string qits-workspaces scopes its workspace
 * list by. `mainBranch` is the branch an integrate targets — displayed so the page can name the
 * destination rather than assuming the string "main".
 */
export interface RepositoryDto {
  readonly id: string;
  readonly url: string;
  readonly mainBranch: string;
  readonly archetype: RepositoryArchetype;
  readonly projectId: string;
}

/** projects' repository list envelope. */
export interface RepositoryEntriesResponse {
  readonly entries: readonly { readonly repository: RepositoryDto }[];
}
