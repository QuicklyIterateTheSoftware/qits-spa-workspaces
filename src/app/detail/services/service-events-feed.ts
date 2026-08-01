import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { QitsButton } from '@qits/ui-components';
import type { ServiceEventDto } from '../../api/dto';
import { WorkspaceEvents } from '../../api/workspace-events';
import { WorkspacesApi } from '../../api/workspaces-api';
import { Async } from '../../ui/async';
import { Empty } from '../../ui/empty';
import { IDLE, LOADING, failed, ready, type Loadable } from '../../ui/loadable';

/**
 * The durable service-event feed: what happened to this workspace's services, newest first.
 *
 * ## Why it is worth a section of its own
 *
 * **It is the only place a browser can see that a service crashed.** `GET /services` flattens every
 * terminal state to `STOPPED`, because a service that dies leaves the supervisor's live map — the
 * `CRASHED` transition rides the control socket, which this page cannot attach to. The host does
 * persist it, as a `service_event` row, and this is the reader. So the list above says what is
 * running and this says what happened, and neither is a view of the other.
 *
 * ## The trap, and why the filtering happens twice
 *
 * `GET /service-events` filters by `workspaceId` — **the branch-derived label, not the row id.** That
 * label is unique only among ACTIVE workspaces and is **reused once a workspace resolves**, so a
 * workspace that inherits a retired name is served its predecessor's events by a filter working
 * exactly as documented. There is no row-id parameter to ask for.
 *
 * So the server narrows by repository and label, because that is what makes a page worth
 * transferring, and this component then keeps only the rows whose `workspaceRowId` is this
 * workspace's. **The rows it drops are counted and said out loud.** Dropping them silently would
 * turn a shared-label collision into a feed that is simply and inexplicably short — which is the
 * failure mode that made the trap worth measuring in the first place.
 *
 * A row with no `workspaceRowId` at all is dropped by the same rule and counted the same way. It
 * cannot be attributed to anything, and attributing it here on the strength of a reused name is the
 * exact mistake this guard exists to prevent.
 *
 * ## What it loads
 *
 * **On first open this feed reads `1`**: one page of twenty events, the size
 * `SERVICE_EVENT_PAGE_SIZE` fixes in the transport. It does not poll and it does not refetch while
 * hidden — a `service-events` hint arriving on another tab is recorded and spent as one catch-up
 * read when this tab is next shown.
 */
@Component({
  selector: 'app-service-events-feed',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, Empty, QitsButton],
  template: `
    <header class="head">
      <h3>Events</h3>
      @if (filterService()) {
        <span class="scoped">
          showing <strong>{{ filterService() }}</strong>
          <qits-button variant="ghost" size="sm" (pressed)="clearFilter.emit()"
            >Show all</qits-button
          >
        </span>
      }
    </header>

    <app-async
      [state]="events()"
      loadingLabel="Loading the service events"
      errorLabel="Could not load the service events"
      (retry)="reload()"
    />

    @if (events().kind === 'ready') {
      @if (rows().length === 0) {
        <app-empty [message]="emptyMessage()" />
      } @else {
        <ol class="feed">
          @for (event of rows(); track event.timestamp + event.serviceName + event.status) {
            <li class="event">
              <button
                type="button"
                class="line"
                [attr.aria-expanded]="isOpen(event)"
                (click)="toggle(event)"
              >
                <span
                  class="sev"
                  [class.warning]="event.severity === 'WARNING'"
                  [class.error]="event.severity === 'ERROR'"
                  aria-hidden="true"
                ></span>
                <span class="sr">{{ event.severity.toLowerCase() }}</span>
                <time [attr.datetime]="event.timestamp">{{ event.timestamp }}</time>
                <span class="service">{{ event.serviceName }}</span>
                <span class="source">{{ event.source ?? 'supervisor' }}</span>
                <span class="summary">{{ summaryOf(event) }}</span>
              </button>
              @if (isOpen(event)) {
                @if (event.logExcerpt) {
                  <pre class="excerpt">{{ event.logExcerpt }}</pre>
                } @else {
                  <p class="none">No log excerpt was captured with this event.</p>
                }
              }
            </li>
          }
        </ol>
      }

      @if (foreign() > 0) {
        <p class="foreign">
          {{ foreign() }} further
          {{ foreign() === 1 ? 'event on this name belongs' : 'events on this name belong' }} to a
          different workspace and {{ foreign() === 1 ? 'is' : 'are' }} not shown. The feed filters
          by the branch-derived label, which is reused after a workspace resolves; these rows were
          matched back to their own workspace by id.
        </p>
      }
    }
  `,
  styles: `
    :host {
      display: block;
      margin-top: 1.25rem;
      padding-top: 0.85rem;
      border-top: 1px solid #e5e7eb;
    }
    .head {
      display: flex;
      align-items: baseline;
      gap: 0.6rem;
      flex-wrap: wrap;
    }
    h3 {
      margin: 0;
      font-size: 0.95rem;
    }
    .scoped {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      color: #6b7280;
      font-size: 0.8rem;
    }
    .feed {
      margin: 0.5rem 0 0;
      padding: 0;
      list-style: none;
    }
    .event {
      border-bottom: 1px solid #f3f4f6;
    }
    .line {
      display: flex;
      align-items: center;
      gap: 0.55rem;
      width: 100%;
      padding: 0.35rem 0;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      font-size: 0.83rem;
      text-align: left;
      cursor: pointer;
    }
    .line:hover {
      background: #f9fafb;
    }
    .sev {
      flex: 0 0 auto;
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: #9ca3af;
    }
    .sev.warning {
      background: #d97706;
    }
    .sev.error {
      background: #b91c1c;
    }
    time {
      flex: 0 0 auto;
      color: #6b7280;
      font-variant-numeric: tabular-nums;
    }
    .service {
      flex: 0 0 auto;
      font-weight: 600;
    }
    .source {
      flex: 0 0 auto;
      padding: 0.05rem 0.4rem;
      border-radius: 999px;
      background: #f3f4f6;
      color: #6b7280;
      font-size: 0.72rem;
    }
    .summary {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .excerpt {
      margin: 0 0 0.5rem 1.05rem;
      padding: 0.4rem 0.55rem;
      overflow-x: auto;
      border-radius: 0.3rem;
      background: #f9fafb;
      color: #374151;
      font-size: 0.78rem;
    }
    .none,
    .foreign {
      margin: 0.3rem 0 0.5rem;
      color: #6b7280;
      font-size: 0.78rem;
    }
    .foreign {
      color: #b45309;
    }
    .sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `,
})
export class ServiceEventsFeed {
  private readonly api = inject(WorkspacesApi);
  private readonly hintSource = inject(WorkspaceEvents);

  /** The identity to attribute rows by. The whole point of the second filter. */
  readonly workspaceRowId = input.required<number>();

  /** Scopes the server-side read. A repository is what makes a reused label merely likely, not certain. */
  readonly repositoryId = input.required<string>();

  /** The branch-derived label the server filters by, warts and all. */
  readonly workspaceLabel = input.required<string>();

  /** Whether the Services tab is showing. Hidden means no refetch and one catch-up read on return. */
  readonly visible = input(false);

  /** Narrow to one service, set by a press on a row above. Null shows everything. */
  readonly filterService = input<string | null>(null);

  /** The scope chip was cleared. The panel owns the filter, this owns the button. */
  readonly clearFilter = output<void>();

  protected readonly events = signal<Loadable<readonly ServiceEventDto[]>>(IDLE);

  private readonly open = signal<ReadonlySet<string>>(new Set<string>());

  private readonly hints = this.hintSource.invalidations('service-events');

  private loadedFor: number | null = null;
  private seenHint = -1;
  private missedHint = false;

  constructor() {
    effect(() => {
      const workspaceRowId = this.workspaceRowId();
      const repositoryId = this.repositoryId();
      const label = this.workspaceLabel();
      const hint = this.hints();
      const visible = this.visible();
      untracked(() => this.decideRead(workspaceRowId, repositoryId, label, hint, visible));
    });
  }

  // ---- what is on screen -------------------------------------------------------------------

  /** Only this workspace's rows, and then only the scoped service if one is chosen. */
  protected readonly rows = computed<readonly ServiceEventDto[]>(() => {
    const mine = this.mine();
    const service = this.filterService();
    return service ? mine.filter((event) => event.serviceName === service) : mine;
  });

  private readonly mine = computed<readonly ServiceEventDto[]>(() => {
    const state = this.events();
    if (state.kind !== 'ready') {
      return [];
    }
    const workspaceRowId = this.workspaceRowId();
    return state.value.filter((event) => event.workspaceRowId === workspaceRowId);
  });

  /**
   * How many rows on this page were somebody else's.
   *
   * Reported rather than swallowed: a short feed with no explanation is exactly how a recycled label
   * hides, and this number is the one thing that names it.
   */
  protected readonly foreign = computed(() => {
    const state = this.events();
    return state.kind === 'ready' ? state.value.length - this.mine().length : 0;
  });

  protected readonly emptyMessage = computed(() =>
    this.filterService()
      ? `No recorded events for ${this.filterService()} in this workspace.`
      : 'No service events have been recorded for this workspace.',
  );

  protected summaryOf(event: ServiceEventDto): string {
    return event.summary ?? (event.status ? event.status.toLowerCase() : event.kind.toLowerCase());
  }

  protected isOpen(event: ServiceEventDto): boolean {
    return this.open().has(keyOf(event));
  }

  protected toggle(event: ServiceEventDto): void {
    const key = keyOf(event);
    this.open.update((open) => {
      const next = new Set(open);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  }

  protected reload(): void {
    void this.load(this.workspaceRowId(), this.repositoryId(), this.workspaceLabel());
  }

  // ---- reads -------------------------------------------------------------------------------

  private decideRead(
    workspaceRowId: number,
    repositoryId: string,
    label: string,
    hint: number,
    visible: boolean,
  ): void {
    if (workspaceRowId <= 0 || !repositoryId || !label) {
      return;
    }
    if (hint !== this.seenHint) {
      this.seenHint = hint;
      this.missedHint = true;
    }
    if (!visible) {
      return;
    }
    if (this.loadedFor === workspaceRowId && !this.missedHint) {
      return;
    }
    this.missedHint = false;
    this.loadedFor = workspaceRowId;
    void this.load(workspaceRowId, repositoryId, label);
  }

  private async load(workspaceRowId: number, repositoryId: string, label: string): Promise<void> {
    if (workspaceRowId <= 0) {
      return;
    }
    this.events.set(LOADING);
    try {
      const events = await this.api.serviceEvents(repositoryId, label);
      if (this.workspaceRowId() === workspaceRowId) {
        this.events.set(ready(events));
      }
    } catch (error) {
      if (this.workspaceRowId() === workspaceRowId) {
        this.events.set(failed(error));
      }
    }
  }
}

/**
 * What makes one event row distinct on screen.
 *
 * The feed has no row id on the wire, so expansion is keyed on the fields that identify an
 * occurrence. Two events of one service at one instant in one state are the same line, which is what
 * a reader means by "this one".
 */
function keyOf(event: ServiceEventDto): string {
  return `${event.timestamp}|${event.serviceName}|${event.status ?? ''}`;
}
