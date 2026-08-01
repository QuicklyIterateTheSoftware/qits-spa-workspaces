import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { QITS_API_BASE } from './api-base';
import type {
  IntegrateResponse,
  MergeRequest,
  ReleaseResponse,
  WorkspaceDto,
  WorkspaceEntriesResponse,
} from './dto';

/**
 * The three calls this app makes against qits-workspaces: read a repository's workspaces, release
 * one of them, and integrate one of them.
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
}
