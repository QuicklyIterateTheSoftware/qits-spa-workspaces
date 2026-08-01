import { Injectable, inject } from '@angular/core';
import { WorkspaceDaemonApi } from './workspace-daemon-api';

/**
 * The daemon's service surface, hand-written from
 * `daemons/qits-workspace-daemon/docs/openapi.yml`.
 *
 * **The container owns the service lifecycle; the host projects it.** Every spawn, restart, backoff
 * and kill decision is made by the in-container supervisor, so a service keeps crash-restarting
 * while the platform is down. Host-side supervision was deleted — a socket blip used to put host and
 * daemon into a port fight over one port — and none of it may come back anywhere, including here.
 */

/**
 * The supervisor's state vocabulary, verbatim from `ServiceTransition.State`.
 *
 * **`DEGRADED` is not a member and must not become one.** It was derived host-side from per-line log
 * observers that were deleted upstream.
 *
 * **`CRASHED` is in the type and never arrives on this route.** A service that reaches a terminal
 * state leaves the supervisor's live map, so a later list reads `STOPPED` whether it was stopped or
 * it died — the `CRASHED` transition rides the control socket, which no browser can see. The value
 * is declared because it is part of the vocabulary, and the panel says the ambiguity out loud rather
 * than letting `STOPPED` quietly mean two things.
 */
export type ServiceState = 'STARTING' | 'READY' | 'RESTARTING' | 'CRASHED' | 'STOPPED';

/**
 * A service's web-view declaration, exactly as the checkout wrote it.
 *
 * The daemon deliberately does not build the served URL from this: that path is
 * `/workspaces/service/{workspaceRowId}/{serviceId}/` plus `basePath`, which is qits-workspaces'
 * shape over ids the daemon is not the authority on. The Web view tab builds it; this is the
 * declaration and nothing more.
 */
export interface WebViewDto {
  readonly port?: number;
  readonly entryPath?: string;
  readonly basePath?: string;
}

/**
 * One declared service and the state this supervisor holds for it.
 *
 * **There is no `health` field, and its absence is the contract rather than an omission.** The
 * checkout's `health-checks:` are parsed by the daemon and published only on the control socket's
 * `ConfigView` — *nothing runs them*. There is no prober in the daemon and none on the host. A
 * `health` key here would be a verdict nobody has formed, so the document leaves it out and this
 * type does too. The panel therefore renders health as unknown, in words, and never invents a
 * verdict from `state`: a process that is up is not a service that is working.
 *
 * A declared service that has never run answers `STOPPED` rather than being absent — the caller's
 * next move is to start it, and a missing entry would read as "no such service".
 */
export interface ServiceDto {
  readonly name: string;
  readonly id?: string;
  readonly description?: string;
  readonly state: ServiceState;
  /** How many times *this* supervisor relaunched it, in this container. Resets with the container. */
  readonly restartCount: number;
  /** Derived from `webView` being present, and always sent, so the picker filters rather than infers. */
  readonly webViewable: boolean;
  readonly webView?: WebViewDto;
}

interface ServiceListResponse {
  readonly services: readonly ServiceDto[];
}

@Injectable({ providedIn: 'root' })
export class ServicesApi {
  private readonly daemon = inject(WorkspaceDaemonApi);

  /**
   * Every service the checkout declares, running or not.
   *
   * Unfiltered, because the convention on this screen is that everything is visible and rules do the
   * narrowing — and because one entry feeds the panel, the tab's aggregate dot and (later) the Web
   * view's picker, which only stays one entry while the key and the shape stay identical.
   */
  async services(workspaceRowId: number): Promise<readonly ServiceDto[]> {
    const answer = await this.daemon.get<ServiceListResponse>(workspaceRowId, '/services');
    return answer.services ?? [];
  }

  /**
   * Start a service, by the name the declaration gives it.
   *
   * **The answer is a `202` and says nothing about the outcome**: the transitions arrive on the
   * control socket, which reaches this page as a `services` hint and a refetch. So a caller waits
   * for the request to settle and then re-reads — it must not treat the resolution as "it started".
   *
   * Idempotent per name: starting a running service leaves it alone.
   */
  async start(workspaceRowId: number, name: string): Promise<void> {
    await this.daemon.post<unknown>(
      workspaceRowId,
      `/services/${encodeURIComponent(name)}/start`,
      {},
    );
  }

  /**
   * Stop a service: mark it stop-requested so the restart policy does not resurrect it, signal its
   * whole session group, and force-kill after the grace.
   *
   * Signalling a service that is not running is still a `202`, so a stale button costs nothing. The
   * signal itself is left to the daemon's default, which is its own stop signal — naming one here
   * would be this client deciding a policy the supervisor owns.
   */
  async stop(workspaceRowId: number, name: string): Promise<void> {
    await this.daemon.post<unknown>(
      workspaceRowId,
      `/services/${encodeURIComponent(name)}/signal`,
      {},
    );
  }
}
