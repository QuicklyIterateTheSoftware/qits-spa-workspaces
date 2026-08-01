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
 * It is shown here and never gated on. **Both merges read the durable branch, not the container** —
 * qits-workspaces merges from the bare origin's refs — so a STOPPED workspace releases and
 * integrates exactly as well as a RUNNING one, and disabling the button on one would be a fiction.
 */
export type WorkspaceRuntimeStatus = 'RUNNING' | 'STOPPED' | 'PROVISIONING' | 'FAILED';

/**
 * The coding-agent activity rollup, as last reported by the in-container `workspace-daemon`.
 *
 * **`ENDED` is here before the host can send it, deliberately.** The registry evicts a workspace's
 * entry the moment a session ends, so the rollup answers `BUSY | WAITING | IDLE` or null today and
 * `ENDED` never arrives. It is declared anyway because the activity bar's whole ordering rule — a
 * session that has just stopped bubbles to the far left, since that is the workspace wanting your
 * next prompt — is decoration without it. The host change that stops the eviction is in flight; a
 * client that already renders the value needs no second pass when it lands, and until then the
 * branch is simply never taken.
 */
export type AgentActivityState = 'IDLE' | 'BUSY' | 'WAITING' | 'ENDED';

/**
 * One workspace, as qits-workspaces lists it.
 *
 * `id` is the identifier every route addresses — including the two merge ones. `workspaceId` is the
 * branch-derived *label*: unique only per repository and reusable once the workspace resolves, so
 * it is displayed and never used to address anything.
 *
 * `parent` is the branch this work goes home to, and it is what picks the door: a workspace whose
 * parent is the repository's default branch is **released**, any other workspace is **integrated**
 * into that parent. So this field is not decoration on the row — it decides which action the row
 * offers.
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
 * What the single-workspace read answers.
 *
 * **This endpoint is not deployed yet** — `GET /workspaces/api/workspaces/{id}` answers 404 on the
 * platform as this is written, and lands with the host workstream running beside this one. The
 * shape is frozen in the plan, so the client is written to it and asserted against a mock; nothing
 * on the detail shell depends on it, because the shell reads the repository-scoped list it needs
 * for the activity bar anyway and finds itself in it.
 */
export interface WorkspaceResponse {
  readonly workspace: WorkspaceDto;
}

/**
 * The workspace's currently-running technical process, or null when nothing is running.
 *
 * This is the Starting tab's discovery lookup: an id here means "open the payload-bearing stream at
 * `/technical-processes/{id}/events`", and null means the transient tab is simply not present.
 */
export interface ActiveProcessResponse {
  readonly technicalProcessId: string | null;
}

/**
 * What `ensure-container` and `recreate-container` answer: the workspace as it now stands, plus the
 * process that is doing the work.
 *
 * The two verbs differ in what they do and not in what they return, which is why one type covers
 * both. The process id is what the Starting tab attaches to without waiting for the `process` hint
 * to come round.
 */
export interface ContainerProcessResponse {
  readonly workspace: WorkspaceDto;
  readonly technicalProcessId: string | null;
}

/** What `discard` answers. One boolean, and the workspace is resolved by the time it arrives. */
export interface DiscardResponse {
  readonly success: boolean;
}

/** One entry in a resolved workspace's narrative: what happened to the branch, and when. */
export interface WorkspaceHistoryEventDto {
  readonly type: string;
  readonly branch: string | null;
  readonly parent: string | null;
  readonly target: string | null;
  readonly commit: string | null;
  readonly note: string | null;
  readonly at: string;
}

/**
 * A resolved workspace, as the history surface serves it.
 *
 * It is the narrative record and **not** a detail view's data: there is no branch state, no runtime
 * status, no clean flag and no daemon. `commands` is always empty — the host's command-history port
 * has no implementation anywhere — so it is declared and never drawn.
 */
export interface WorkspaceHistoryDetailDto {
  readonly id: number;
  readonly workspaceId: string;
  readonly parent: string | null;
  readonly status: WorkspaceStatus;
  readonly preamble: string | null;
  readonly result: string | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly events: readonly WorkspaceHistoryEventDto[];
}

/** The history read's envelope. */
export interface WorkspaceHistoryDetailResponse {
  readonly workspace: WorkspaceHistoryDetailDto;
}

/**
 * One frame of a technical process's replayable stream, copied field-for-field from
 * `TechnicalProcessFrame`.
 *
 * Every field but `kind` and `seq` is nullable because one record carries five frame shapes.
 * `segment` is null on `done` and `ping`; `line` is set only on `line`; `status` only on
 * `segment-settled` and `done`; `hint`/`hintTarget` only on a *failed* settle.
 *
 * `seq` is per-subscription and a reconnect replays everything with fresh ordinals — so it orders
 * one connection's frames and is never a resume token. The client rebuilds from scratch on every
 * connect, which is the intended contract rather than a fallback.
 */
export interface TechnicalProcessFrame {
  readonly segment: string | null;
  readonly kind: 'segment-open' | 'line' | 'segment-settled' | 'done' | 'ping';
  readonly seq: number;
  readonly line: string | null;
  readonly status: 'ok' | 'failed' | null;
  readonly hint: string | null;
  readonly hintTarget: string | null;
}

/**
 * The one documented failure classification: the verb hit a remote's auth wall.
 *
 * `hintTarget` names the repository to sign into, and **for a submodule child that is not the root
 * repository** — so a UI acting on it must use the target it is given rather than the workspace's
 * own repository.
 */
export const HINT_REMOTE_AUTH = 'remote-auth';

/**
 * What both `POST …/{id}/release` and `POST …/{id}/integrate` take. One field, and no target.
 *
 * **The target is not a parameter in either call: it is derived from the workspace.** Release always
 * lands on the repository's default branch, integrate always lands on the workspace's parent branch,
 * and both are facts the service already holds — so a client that could name a target would be
 * describing an API that does not exist.
 *
 * The summary becomes the merge commit's subject, as `release(<version>): <summary>` or
 * `integrate(<branch>): <summary>`. It is capped at 100 characters on both sides: the conventional
 * 72-character subject budget minus roughly the 24 a scope costs, rounded to a number a person can
 * be told.
 */
export interface MergeRequest {
  readonly summary: string;
}

/** The summary cap, server-side `@Size(max = 100)` and the input's `maxlength` alike. */
export const SUMMARY_MAX_LENGTH = 100;

/**
 * What a successful release answers.
 *
 * All three fields are worth showing and none is derivable from the others: `version` is the stamp
 * that was just minted (`2026.731.193059` — year, month+day, time, as integers), `commitSha` is the
 * merge commit that carries both the merge and the version bump, and `branch` is the source branch
 * that was released, which the merge's parents record as a sha but never as a name.
 */
export interface ReleaseResponse {
  readonly version: string;
  readonly commitSha: string;
  readonly branch: string;
}

/**
 * What a successful integrate answers. **No version** — an integrate stamps none, because it is a
 * merge and not a release.
 *
 * `targetBranch` is the parent the work landed on. It is answered rather than assumed: the client
 * picked this door from the workspace's `parent`, and the service is the one that decides where an
 * integrate goes.
 */
export interface IntegrateResponse {
  readonly commitSha: string;
  readonly branch: string;
  readonly targetBranch: string;
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

/**
 * One repository, read by id.
 *
 * The list page reaches a repository through its project, because a person picking one starts from
 * the projects. The detail route has only the repository id in its URL and no project at all — so
 * it reads the repository directly, which is one request instead of two and works on a deep link
 * from anywhere.
 */
export interface RepositoryResponse {
  readonly repository: RepositoryDto;
}
