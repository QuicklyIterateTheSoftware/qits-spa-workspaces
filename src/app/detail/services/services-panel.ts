import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { QitsBadge, QitsButton, type QitsBadgeTone } from '@qits/ui-components';
import type { WorkspaceRuntimeStatus } from '../../api/dto';
import type { ServiceDto, ServiceState } from '../../api/services-api';
import { ServicesApi } from '../../api/services-api';
import { WorkspaceServices } from '../../api/workspace-services';
import { Async } from '../../ui/async';
import { Empty } from '../../ui/empty';
import { IDLE } from '../../ui/loadable';
import { ServiceEventsFeed } from './service-events-feed';

/** The statuses that mean the container is not answering, as opposed to answering "no". */
const UNREACHABLE: readonly number[] = [0, 502, 503, 504];

/**
 * The services panel: what this checkout declares, what the container's supervisor is doing with it,
 * and what has happened to it — the feed below.
 *
 * ## What it loads
 *
 * **On first open this panel reads `2`**:
 *
 * 1. `GET /services` on the daemon — through the shared services entry, which is also what colours
 *    the tab's aggregate dot and will feed the Web view's picker. First reader pays; later ones are
 *    free.
 * 2. `GET /workspaces/api/service-events` on the host — one page of twenty, in the feed below.
 *
 * The list keeps refreshing on a `services` hint even while this tab is hidden, and that is the one
 * deliberate exception to the panel visibility rule: its aggregate lives on the tab label, which is
 * on screen whichever tab is selected. The feed obeys the ordinary rule and does one catch-up read on
 * becoming visible.
 *
 * ## Health, which is absent, and is drawn as absent
 *
 * **There is no health field on `GET /services`, and this panel must not invent one.** The
 * checkout's `health-checks:` are parsed by the daemon and published only on the control socket's
 * `ConfigView` — and *nothing runs them*. There is no prober in the daemon; the host's supervisor
 * reported every declared check as `UNKNOWN` and said in a comment that health was the daemon's to
 * report, and then host-side supervision was deleted. So no component anywhere has formed a verdict
 * about any check.
 *
 * The consequence for this panel is precise: it says so, once, in words, and it **never derives a
 * verdict from `state`**. A process the supervisor has launched is not a service that is working —
 * that difference is the entire reason health checks exist — and colouring `READY` as "healthy"
 * would be the panel's one outright lie. When a daemon-side prober lands, the check rows have a
 * place to appear and this note has a place to go.
 *
 * ## `STOPPED` means two things and the panel says which
 *
 * A service that reaches a terminal state **leaves the supervisor's live map**, so a later list reads
 * `STOPPED` whether it was stopped on purpose or it crashed. The `CRASHED` transition exists, and it
 * rides the control socket, which no browser can attach to. What a browser *can* read is the durable
 * `service_event` row the host wrote when it happened — which is in the feed below. So the ambiguity
 * is stated on the chip and the reader is pointed at the one place that resolves it.
 */
@Component({
  selector: 'app-services-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, Empty, QitsBadge, QitsButton, ServiceEventsFeed],
  templateUrl: './services-panel.html',
  styleUrl: './services-panel.css',
})
export class ServicesPanel {
  private readonly api = inject(ServicesApi);
  private readonly entry = inject(WorkspaceServices);

  /** Which workspace's container to read. The row id, which is what the proxy addresses. */
  readonly workspaceRowId = input.required<number>();

  /** The repository, for the feed's server-side narrowing. */
  readonly repositoryId = input.required<string>();

  /** The branch-derived label, which is the only handle the feed's server-side filter takes. */
  readonly workspaceLabel = input.required<string>();

  /** Whether this tab is showing. The feed gates on it; the list deliberately does not. */
  readonly visible = input(false);

  /**
   * The container's runtime state.
   *
   * Read to say *why* the list is unavailable before the request fails, rather than after: a stopped
   * container's `/services` is a 502 from the proxy, and "the service list lives in the container"
   * is a better sentence than a status code.
   */
  readonly runtimeStatus = input<WorkspaceRuntimeStatus | null>(null);

  protected readonly services = this.entry.services;

  /** Which service the feed below is scoped to. A free level: it dies with the panel, so it is local. */
  protected readonly scoped = signal<string | null>(null);

  /** Rows with a start or a stop in flight, keyed by name so one press spins one row. */
  protected readonly pending = signal<ReadonlySet<string>>(new Set<string>());

  constructor() {
    // Driven off the id, never off a click. The entry is idempotent for the same id, so this may run
    // as often as it likes.
    effect(() => this.entry.use(this.workspaceRowId()));
  }

  // ---- what is on screen -------------------------------------------------------------------

  protected readonly rows = computed<readonly ServiceDto[]>(() => {
    const state = this.services();
    return state.kind === 'ready' ? state.value : [];
  });

  /**
   * Whether the failure to read the list is the container being gone rather than a broken request.
   *
   * Two ways in, and they are the same state: the workspace row already says the container is not
   * running, or the proxy answered that nothing is listening for it.
   */
  protected readonly containerGone = computed(() => {
    const runtime = this.runtimeStatus();
    if (runtime !== null && runtime !== 'RUNNING') {
      return true;
    }
    const state = this.services();
    return state.kind === 'error' && UNREACHABLE.includes(state.status);
  });

  /**
   * The error banner is suppressed for the one failure the panel explains better itself.
   *
   * A 502 rendered as "502" beside a sentence that already says the container is stopped is two
   * accounts of one fact, and the shorter one is wrong.
   */
  protected readonly listProblem = computed(() => {
    const state = this.services();
    return state.kind === 'error' && this.containerGone() ? IDLE : state;
  });

  protected readonly showList = computed(
    () => this.services().kind === 'ready' && !this.containerGone(),
  );

  protected toneOf(state: ServiceState): QitsBadgeTone {
    switch (state) {
      case 'READY':
        return 'success';
      case 'STARTING':
        return 'info';
      case 'RESTARTING':
        return 'warning';
      case 'CRASHED':
        return 'danger';
      default:
        return 'neutral';
    }
  }

  protected labelOf(state: ServiceState): string {
    return state.toLowerCase();
  }

  /** The one place `STOPPED`'s ambiguity is spelled out; every other state means exactly itself. */
  protected chipTitle(state: ServiceState): string {
    return state === 'STOPPED'
      ? 'Stopped, or crashed: a service that reaches a terminal state leaves the supervisor’s live map, so both read “stopped” here. The events below record which it was.'
      : '';
  }

  protected isPending(name: string): boolean {
    return this.pending().has(name);
  }

  protected isRunning(state: ServiceState): boolean {
    return state === 'STARTING' || state === 'READY' || state === 'RESTARTING';
  }

  // ---- what the panel does -----------------------------------------------------------------

  protected scopeTo(name: string): void {
    this.scoped.update((current) => (current === name ? null : name));
  }

  protected clearScope(): void {
    this.scoped.set(null);
  }

  protected reload(): void {
    void this.entry.refresh();
  }

  /**
   * Start or stop one service.
   *
   * **The truth is refetched when the call settles, not when it succeeds.** Both verbs answer `202`
   * and say nothing about the outcome — the transitions arrive on the control socket, reach the host,
   * and come back here as a `services` hint — so there is no success to patch a row from. A refused
   * start has changed what is true just as much as an accepted one, which is why the refresh is in
   * the `finally` and not in the happy path.
   */
  protected async act(service: ServiceDto): Promise<void> {
    const name = service.name;
    const workspaceRowId = this.workspaceRowId();
    const stopping = this.isRunning(service.state);
    this.pending.update((pending) => new Set(pending).add(name));
    try {
      if (stopping) {
        await this.api.stop(workspaceRowId, name);
      } else {
        await this.api.start(workspaceRowId, name);
      }
    } catch {
      // Swallowed on purpose: the refresh below is what tells the user what happened, and a 202 that
      // never arrived is indistinguishable to them from a start that failed to take.
    } finally {
      this.pending.update((pending) => {
        const next = new Set(pending);
        next.delete(name);
        return next;
      });
      await this.entry.refresh();
    }
  }
}
