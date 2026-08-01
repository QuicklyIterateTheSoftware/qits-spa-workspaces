import { Injectable, inject } from '@angular/core';
import { WorkspaceDaemonApi } from './workspace-daemon-api';

/**
 * The daemon's bootstrap surface, hand-written from
 * `daemons/qits-workspace-daemon/docs/openapi.yml`.
 *
 * **This is the declaration and the verbs; the history is somewhere else.** The chain a checkout
 * declares lives in the container, and so does the ability to run it. When each step last ran *in
 * this workspace* is a host table (`workspace_bootstrap_run`, read through
 * `WorkspacesApi.bootstrapRuns`), because it has to outlive the container that produced it. The two
 * are joined by the client — see `bootstrap-section.ts` — which is why the id is on both sides.
 */

/**
 * One declared step.
 *
 * `id` defaults to `name` in the daemon and is omitted when the declaration carries neither, so the
 * join key is `id ?? name`. The `execute` and `check` scripts are deliberately absent: they come
 * from an untrusted checkout and the caller's use for this list is to *name* a step.
 */
export interface BootstrapStepDto {
  readonly name: string;
  readonly id?: string;
  readonly description?: string;
}

interface BootstrapChainResponse {
  readonly steps: readonly BootstrapStepDto[];
}

@Injectable({ providedIn: 'root' })
export class BootstrapApi {
  private readonly daemon = inject(WorkspaceDaemonApi);

  /** The chain this checkout declares, in the order it runs. */
  async chain(workspaceRowId: number): Promise<readonly BootstrapStepDto[]> {
    const answer = await this.daemon.get<BootstrapChainResponse>(
      workspaceRowId,
      '/bootstrap-commands',
    );
    return answer.steps ?? [];
  }

  /**
   * Run the whole chain.
   *
   * **A `202` and nothing else.** The run streams itself home on the *control socket* — a channel no
   * browser can attach to — and it is bounded only by the daemon's bootstrap timeout, an hour by
   * default. So this page learns that a chain progressed only when a `bootstrap` hint fires and the
   * host's run rows are re-read. Returning immediately is the point, and pretending otherwise would
   * mean inventing progress the client cannot see.
   */
  async runChain(workspaceRowId: number): Promise<void> {
    await this.daemon.post<unknown>(workspaceRowId, '/bootstrap-commands/run', {});
  }

  /**
   * Run one named step alone. Same `202` contract as the whole chain.
   *
   * `run` is a reserved step name — the collection form is matched first by the daemon's dispatcher —
   * so a step called `run` cannot be addressed individually. Nothing here works around that: it is
   * the server's routing and a client-side escape would only disagree with it.
   */
  async runStep(workspaceRowId: number, name: string): Promise<void> {
    await this.daemon.post<unknown>(
      workspaceRowId,
      `/bootstrap-commands/${encodeURIComponent(name)}/run`,
      {},
    );
  }
}
