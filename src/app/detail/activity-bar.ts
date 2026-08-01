import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import type { AgentActivityState, WorkspaceDto } from '../api/dto';
import { AgentActivityMemory } from './agent-activity-memory';

/** How each activity state is said and drawn. */
const STATES: Readonly<Record<AgentActivityState, { label: string; tone: string }>> = {
  BUSY: { label: 'Cooking…', tone: 'busy' },
  WAITING: { label: 'Waiting on you', tone: 'waiting' },
  IDLE: { label: 'Idle', tone: 'idle' },
  ENDED: { label: 'Ended', tone: 'ended' },
};

/** One button in the row. */
interface ActivityButton {
  readonly id: number;
  readonly name: string;
  readonly label: string;
  readonly tone: string;
  readonly current: boolean;
}

/**
 * Which workspaces in this repository have a coding agent doing something, ordered by who needs you.
 *
 * **Recency, not name and not state.** {@link AgentActivityMemory} records when each workspace's
 * activity value last moved and the row is sorted by that, most recent first, ties broken by
 * identifier so the order is stable. The consequence worth stating: a session that has just stopped
 * sorts to the far left, because stopping is a change.
 *
 * **It is a "who needs me" queue, not a liveness indicator.** A button stays while its session is
 * idle, waiting or ended, and drops off only when activity clears entirely — the container stopped,
 * or the session was reaped. Clicking one opens that workspace's Chat tab, which is where the next
 * prompt goes.
 *
 * **With nothing to say it renders nothing at all** — not an empty strip. A row that is always there
 * and usually empty is a row people stop looking at.
 *
 * `ENDED` arrives and then ages out: the host keeps a workspace's entry when its session ends and
 * expires it after thirty minutes. That window is why a just-stopped workspace can hold the front
 * of the row across a reload, and why it leaves on its own afterwards.
 */
@Component({
  selector: 'app-activity-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (buttons().length > 0) {
      <div class="bar" role="group" aria-label="Workspaces with agent activity">
        @for (button of buttons(); track button.id) {
          <button
            type="button"
            class="entry"
            [class.current]="button.current"
            [attr.aria-current]="button.current ? 'page' : null"
            [title]="button.name + ' — ' + button.label"
            (click)="open.emit(button.id)"
          >
            <span class="dot" [class]="button.tone" aria-hidden="true"></span>
            <span class="name">{{ button.name }}</span>
            <span class="sr">{{ button.label }}</span>
          </button>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .bar {
      position: sticky;
      top: 0;
      z-index: 1;
      display: flex;
      gap: 0.35rem;
      overflow-x: auto;
      padding: 0.35rem 0;
      background: #ffffff;
      border-bottom: 1px solid #f3f4f6;
    }
    .entry {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      flex: 0 0 auto;
      padding: 0.25rem 0.6rem;
      border: 1px solid #e5e7eb;
      border-radius: 1rem;
      background: #ffffff;
      color: #374151;
      font: inherit;
      font-size: 0.82rem;
      cursor: pointer;
    }
    .entry:hover {
      background: #f9fafb;
    }
    .entry.current {
      border-color: #2563eb;
      color: #1d4ed8;
    }
    .name {
      max-width: 14rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dot {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: #9ca3af;
    }
    .dot.busy {
      background: #2563eb;
      animation: activity-pulse 1.4s ease-in-out infinite;
    }
    .dot.waiting {
      background: #d97706;
    }
    .dot.idle {
      background: #9ca3af;
    }
    .dot.ended {
      background: #d1d5db;
    }
    .sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    @keyframes activity-pulse {
      50% {
        opacity: 0.35;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .dot.busy {
        animation: none;
      }
    }
  `,
})
export class ActivityBar {
  /** Every workspace in this repository. The bar picks the ones with activity out of it. */
  readonly workspaces = input.required<readonly WorkspaceDto[]>();

  /** The workspace this page is showing, highlighted in the row. */
  readonly currentId = input.required<number>();

  /** Open a workspace's Chat tab. */
  readonly open = output<number>();

  private readonly memory = inject(AgentActivityMemory);

  protected readonly buttons = computed<readonly ActivityButton[]>(() => {
    const current = this.currentId();
    return this.workspaces()
      .filter((workspace) => workspace.agentActivity !== null)
      .map((workspace) => {
        const state = STATES[workspace.agentActivity!];
        return {
          id: workspace.id,
          name: workspace.branch ?? workspace.workspaceId,
          label: state.label,
          tone: state.tone,
          current: workspace.id === current,
          at: this.memory.changedAt(workspace.id),
        };
      })
      .sort((left, right) => right.at - left.at || left.id - right.id)
      .map(({ id, name, label, tone, current: isCurrent }) => ({
        id,
        name,
        label,
        tone,
        current: isCurrent,
      }));
  });
}
