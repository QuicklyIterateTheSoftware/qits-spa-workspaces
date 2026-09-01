import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { QITS_API_BASE } from './api-base';
import type {
  ActiveProcessResponse,
  BootstrapRunDto,
  BootstrapRunsResponse,
  ContainerProcessResponse,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  DiscardResponse,
  IntegrateResponse,
  MergeRequest,
  ReleaseRequestView,
  ReleaseRequestedResponse,
  ServiceEventDto,
  ServiceEventsResponse,
  WorkspaceDto,
  WorkspaceEntriesResponse,
  WorkspaceHistoryDetailDto,
  WorkspaceHistoryDetailResponse,
  WorkspaceResponse,
} from './dto';

/**
 * One page of the service-event feed, which is what the panel shows.
 *
 * Twenty rather than the service's default fifty, because the feed is a recent-history strip under a
 * list and not a log viewer. It is also the number the client-side row-id filter is applied *to* —
 * see {@link WorkspacesApi.serviceEvents} — so a page that contains a recycled label's events shows
 * fewer than twenty rows, and the feed says so rather than quietly looking short.
 */
export const SERVICE_EVENT_PAGE_SIZE = 20;

/**
 * The calls this app makes against qits-workspaces: read a repository's workspaces, read one
 * workspace's running process and its history record, drive a container, and send work home.
 *
 * Release and integrate are **two processes, not one call with a flag**, and this client says so
 * with two methods against two routes. Release is the door into the default branch and stamps a
 * version; integrate merges a workspace into its parent and stamps nothing. Their answers differ in
 * the field that matters — a release has a version, an integrate has none — so folding them
 * together would produce a response type whose most useful field is optional for no reason a reader
 * could see.
 *
 * `HttpClient` on the fetch backend rather than bare `fetch()`, for two reasons that both cash out
 * elsewhere: `HttpTestingController` is the only request-mocking story Angular ships, and every
 * state this page draws is "given this response, render that"; and `withFetch()` routes through
 * `window.fetch`, which is what the platform's OTel browser instrumentation hooks. The observable
 * is unwrapped with `firstValueFrom` immediately — these are one-shot calls, and a promise is what
 * the page's `async` methods want.
 */
@Injectable({ providedIn: 'root' })
export class WorkspacesApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(QITS_API_BASE);

  /**
   * One repository's live workspaces.
   *
   * `repositoryId` is a **required** filter and is sent as a query parameter rather than a path
   * segment on purpose: qits-workspaces does not own repositories — it holds the id as a string,
   * with no foreign key and no join, in a different database — so a workspace is not a sub-resource
   * of one. The repository is scope on the collection, which is what it actually is.
   *
   * The service answers only ACTIVE workspaces here; resolved ones live in its history view.
   */
  async workspaces(repositoryId: string): Promise<readonly WorkspaceDto[]> {
    const params = new HttpParams().set('repositoryId', repositoryId);
    const response = await firstValueFrom(
      this.http.get<WorkspaceEntriesResponse>(`${this.base}/workspaces/api/workspaces`, { params }),
    );
    return response.entries.map((entry) => entry.workspace);
  }

  /**
   * Create a workspace, and — as the overview always does — over a branch that already exists.
   *
   * `repositoryId` is in the body and not in the query string, which is the one thing about this
   * route worth remembering: the listing above scopes by a query parameter, the create does not.
   * The service reads the field from the payload and answers 400 without it.
   *
   * Rejects with the `HttpErrorResponse`. A 409 here means the branch already has an active
   * workspace, which is the race a second press produces — so the caller re-reads the list rather
   * than retrying.
   */
  async createWorkspace(request: CreateWorkspaceRequest): Promise<WorkspaceDto> {
    const response = await firstValueFrom(
      this.http.post<CreateWorkspaceResponse>(`${this.base}/workspaces/api/workspaces`, request),
    );
    return response.workspace;
  }

  /**
   * Ask for one workspace's release — **a release request, not a merge**. The door creates (or
   * converges on, merge-request-shaped) the branch's open request in qits-projects; the quality
   * gates settle it off the commit ledger and the release lands when the build goes green. Nothing
   * has merged when this answers: poll {@link releaseRequest} until the request concludes.
   *
   * Still one call per press: a second press converges on the same open request rather than
   * minting a second one, but this screen keeps the person in the loop rather than re-asking.
   *
   * Rejects with the `HttpErrorResponse`, which is what {@link
   * ../merge/merge-outcome#classifyMergeFailure} reads to tell the guards' answers apart.
   */
  async release(workspaceId: number, summary: string): Promise<ReleaseRequestedResponse> {
    const body: MergeRequest = { summary };
    return firstValueFrom(
      this.http.post<ReleaseRequestedResponse>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}/release`,
        body,
      ),
    );
  }

  /**
   * One release request, straight from qits-projects — a same-origin absolute path for the reason
   * {@link ../api/api-base} records: the gateway serves `/projects/api/…` beside this app, so the
   * browser's session reaches both services with no machine token and no pre-flight.
   */
  async releaseRequest(repositoryId: string, requestId: string): Promise<ReleaseRequestView> {
    const answer = await firstValueFrom(
      this.http.get<{ request: ReleaseRequestView }>(
        `${this.base}/projects/api/repositories/${encodeURIComponent(repositoryId)}` +
          `/release-requests/${encodeURIComponent(requestId)}`,
      ),
    );
    return answer.request;
  }

  /**
   * Integrate one workspace: merge its branch into its **parent** branch and push. No version is
   * stamped and nothing is released — a task workspace lands on its epic, and the epic is what is
   * released later.
   *
   * The target is not sent, for the same reason the release target is not: the parent is the
   * service's own fact about the workspace. A workspace whose parent *is* the default branch is
   * refused here with a 409 pointing at {@link release} — the server guarding the one door into the
   * default branch, rather than trusting this client's reading of the row.
   *
   * Rejects with the `HttpErrorResponse` exactly as {@link release} does; the 409 family is shared.
   */
  async integrate(workspaceId: number, summary: string): Promise<IntegrateResponse> {
    const body: MergeRequest = { summary };
    return firstValueFrom(
      this.http.post<IntegrateResponse>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}/integrate`,
        body,
      ),
    );
  }

  /**
   * One workspace, by the id every route addresses.
   *
   * **Nothing on the detail shell calls this yet, and that is the point.** The shell needs the
   * repository-scoped list regardless — it is the single cache entry that feeds the header, the
   * status strip and the activity bar at once — so reading one workspace on top of it would be a
   * second request for data already in hand. The method exists because the endpoint is landing
   * beside this work and the panels that mount later (a resolved workspace's read, a deep link that
   * arrives without a repository) are its callers.
   */
  async workspace(workspaceId: number): Promise<WorkspaceDto> {
    const response = await firstValueFrom(
      this.http.get<WorkspaceResponse>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}`,
      ),
    );
    return response.workspace;
  }

  /**
   * The technical process running against this workspace, or null.
   *
   * This is the Starting tab's discovery lookup and one of the shell's two workspace reads on load.
   * It is asked again whenever the `process` hint fires, which is how a container start begun from
   * another screen still opens the tab here.
   */
  async activeProcess(workspaceId: number): Promise<string | null> {
    const response = await firstValueFrom(
      this.http.get<ActiveProcessResponse>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}/active-process`,
      ),
    );
    return response.technicalProcessId;
  }

  /** Start the container if it is not up. Answers the process that is doing it. */
  async ensureContainer(workspaceId: number): Promise<ContainerProcessResponse> {
    return firstValueFrom(
      this.http.post<ContainerProcessResponse>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}/ensure-container`,
        {},
      ),
    );
  }

  /** Stop the container. The branch is untouched: the container is a cache of it. */
  async stopContainer(workspaceId: number): Promise<WorkspaceDto> {
    return firstValueFrom(
      this.http.post<WorkspaceDto>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}/stop-container`,
        {},
      ),
    );
  }

  /**
   * Throw the container away and build a fresh one.
   *
   * **The service refuses this with a 400 unless the working tree is provably clean**, because a
   * recreate discards whatever is only in the container. A client that offers the press anyway
   * turns a guard into an error message, so the button that calls this is disabled with the reason
   * whenever `clean` is not exactly `true` — and "unknown", which is what a disconnected daemon
   * reports, counts as not clean.
   */
  async recreateContainer(workspaceId: number): Promise<ContainerProcessResponse> {
    return firstValueFrom(
      this.http.post<ContainerProcessResponse>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}/recreate-container`,
        {},
      ),
    );
  }

  /**
   * Abandon the work: the workspace resolves, unmerged, with an optional markdown note saying why.
   *
   * The note is the whole record of what was tried, so it is worth asking for — after this call the
   * workspace leaves the active list and only the history record remains.
   *
   * **`ignoreChanges` is the confirmed override of the clean-working-tree guard**, sent as
   * `?ignore-changes=true` on the URL — deliberately never part of the body, so the ordinary call
   * cannot carry it by accident. The first press always goes without it; only after the service has
   * refused with "uncommitted changes" and the person has confirmed that exact loss does a second
   * call spell it out.
   */
  async discard(
    workspaceId: number,
    result: string,
    ignoreChanges = false,
  ): Promise<DiscardResponse> {
    const suffix = ignoreChanges ? '?ignore-changes=true' : '';
    return firstValueFrom(
      this.http.post<DiscardResponse>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}/discard${suffix}`,
        { result },
      ),
    );
  }

  /**
   * One page of the durable service-event feed, newest first.
   *
   * **The server filters by the workspace *label*, and that is the trap this method exists to name.**
   * `service_event.workspace_id` is the branch-derived string — unique only among ACTIVE workspaces
   * and **reusable the moment one resolves** — so a workspace that inherits a retired name is served
   * its predecessor's events by a filter that is behaving exactly as documented. There is no row-id
   * parameter to ask for instead.
   *
   * So the narrowing happens twice: `repoId` and `workspaceId` go to the server because they cut the
   * page down to something worth transferring, and the caller then keeps only the rows whose
   * `workspaceRowId` is this workspace's. The DTO carries the row id for precisely this reason. That
   * second filter is the caller's rather than this method's, because dropping rows silently inside a
   * transport would hide the very ambiguity the panel has to report.
   */
  async serviceEvents(
    repositoryId: string,
    workspaceLabel: string,
  ): Promise<readonly ServiceEventDto[]> {
    const params = new HttpParams()
      .set('repoId', repositoryId)
      .set('workspaceId', workspaceLabel)
      .set('pageSize', SERVICE_EVENT_PAGE_SIZE);
    const response = await firstValueFrom(
      this.http.get<ServiceEventsResponse>(`${this.base}/workspaces/api/service-events`, {
        params,
      }),
    );
    return response.events ?? [];
  }

  /**
   * When each of this workspace's bootstrap steps last ran, and how it went.
   *
   * **Host-owned state, and not a forwarder.** The run *verbs* are the daemon's; this reads a host
   * table that has to outlive the container, and it is the only place that table is readable from.
   * The declared chain — what the steps *are* — comes from the daemon's own `GET /bootstrap-commands`
   * and the two are joined on `bootstrapCommandId`.
   *
   * Empty rather than 404 when the chain has never run here: a freshly created workspace has no rows
   * yet, and that is a state to render.
   */
  async bootstrapRuns(workspaceId: number): Promise<readonly BootstrapRunDto[]> {
    const response = await firstValueFrom(
      this.http.get<BootstrapRunsResponse>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}/bootstrap-runs`,
      ),
    );
    return response.runs ?? [];
  }

  /**
   * A workspace's history record — the narrative, for a workspace that has already resolved.
   *
   * The detail view reads this in exactly one situation: the id is not in its repository's active
   * list. That means the work is finished (or the id is wrong), and the record is what there is to
   * show. It carries no branch state, no runtime and no commands, which is precisely why a resolved
   * workspace does not get a detail view.
   */
  async history(workspaceId: number): Promise<WorkspaceHistoryDetailDto> {
    const response = await firstValueFrom(
      this.http.get<WorkspaceHistoryDetailResponse>(
        `${this.base}/workspaces/api/history/${encodeURIComponent(workspaceId)}`,
      ),
    );
    return response.workspace;
  }
}
