import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { QITS_API_BASE } from './api-base';
import type {
  ActiveProcessResponse,
  ContainerProcessResponse,
  DiscardResponse,
  IntegrateResponse,
  MergeRequest,
  ReleaseResponse,
  WorkspaceDto,
  WorkspaceEntriesResponse,
  WorkspaceHistoryDetailDto,
  WorkspaceHistoryDetailResponse,
  WorkspaceResponse,
} from './dto';

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
   * Release one workspace: merge its branch into the repository's default branch, stamped with a
   * fresh version, as one commit that is then pushed.
   *
   * **Not idempotent, by design** — each call stamps a new version from the clock, because two
   * releases are two releases. Retry safety comes from the flow's shape instead: a failed release
   * moved no ref, and a succeeded one whose answer was lost is refused on the retry with "already
   * integrated" rather than producing an empty second release. So this method is called once per
   * press and never automatically re-issued; every retry on this screen is a person pressing a
   * button again.
   *
   * Rejects with the `HttpErrorResponse`, which is what {@link
   * ../merge/merge-outcome#classifyMergeFailure} reads to tell the 409s apart.
   */
  async release(workspaceId: number, summary: string): Promise<ReleaseResponse> {
    const body: MergeRequest = { summary };
    return firstValueFrom(
      this.http.post<ReleaseResponse>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}/release`,
        body,
      ),
    );
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
   */
  async discard(workspaceId: number, result: string): Promise<DiscardResponse> {
    return firstValueFrom(
      this.http.post<DiscardResponse>(
        `${this.base}/workspaces/api/workspaces/${encodeURIComponent(workspaceId)}/discard`,
        { result },
      ),
    );
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
