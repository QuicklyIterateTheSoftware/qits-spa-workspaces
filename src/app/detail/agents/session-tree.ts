import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { QitsButton } from '@qits/ui-components';
import type { AgentSessionNodeDto } from '../../api/agents-api';
import { Empty } from '../../ui/empty';

/**
 * The accents a lineage is told apart by.
 *
 * One per root, reused around the ring. They exist because **sibling branches are the hard thing to
 * read**: a fork and its origin are the same conversation twice, and a tree of dates alone makes
 * them indistinguishable at a glance. Every descendant of a root carries the root's colour, so the
 * colour means "this line of work" rather than "this depth".
 */
export const LINEAGE_ACCENTS: readonly string[] = [
  '#2563eb',
  '#16a34a',
  '#d97706',
  '#9333ea',
  '#0891b2',
  '#dc2626',
];

/** One row of the flattened tree: a session, or one of its side-chains. */
export interface SessionRow {
  readonly kind: 'session' | 'subagent';
  /** The session id, or the sub-agent's own id. Unique per row, so it is the track key. */
  readonly id: string;
  readonly depth: number;
  readonly accent: string;
  readonly at?: string;
  /** Absent means "not swept yet", which is a different thing from a swept zero. */
  readonly messageCount?: number;
  readonly forked: boolean;
  /** Free text the agent wrote about a side-chain. Rendered as what it is, never matched. */
  readonly label?: string;
}

/**
 * Flatten the daemon's nested tree into rows a template can draw without recursing.
 *
 * Angular has no recursive component without a self-reference or a template outlet, and a tree this
 * shallow does not earn either. Flattening also puts the two orderings in one testable place:
 * **newest roots first**, and children in the order the daemon reported them, which is the order the
 * forks were made.
 */
export function sessionRows(nodes: readonly AgentSessionNodeDto[]): readonly SessionRow[] {
  const roots = [...nodes].sort((left, right) => when(right) - when(left));
  const rows: SessionRow[] = [];
  roots.forEach((root, index) => {
    walk(root, 0, LINEAGE_ACCENTS[index % LINEAGE_ACCENTS.length], rows);
  });
  return rows;
}

function walk(node: AgentSessionNodeDto, depth: number, accent: string, rows: SessionRow[]): void {
  rows.push({
    kind: 'session',
    id: node.sessionId,
    depth,
    accent,
    at: node.firstRecordedAt,
    messageCount: node.messageCount,
    forked: node.forkedFromSessionId !== undefined,
  });
  for (const subagent of node.subagents ?? []) {
    rows.push({
      kind: 'subagent',
      id: subagent.agentId,
      depth: depth + 1,
      accent,
      at: subagent.firstTimestamp,
      messageCount: subagent.messageCount,
      forked: false,
      label: subagent.description ?? subagent.agentType,
    });
  }
  for (const child of node.children ?? []) {
    walk(child, depth + 1, accent, rows);
  }
}

function when(node: AgentSessionNodeDto): number {
  const at = node.firstRecordedAt ? Date.parse(node.firstRecordedAt) : NaN;
  return Number.isFinite(at) ? at : 0;
}

/**
 * The session history: one node per session, resumes collapsed onto what they continued, forks
 * nested under their origin.
 *
 * **Resume disappears while anything owns the conversation.** Not disabled — gone. It is the same
 * collision the whole resolution order exists to prevent, and a greyed button invites a click that
 * cannot be honoured. When the run ends the rows grow their buttons back.
 *
 * **A missing message count is not zero.** The count is filled in by the transcript sweep when a run
 * exits, so a live session honestly has none yet, and printing "0 messages" over a conversation
 * happening right now would be the one number on this panel that is simply wrong.
 *
 * Side-chains have the same shape of honesty: they join **only after the exit sweep**, so a live
 * session shows its main thread and gains its sub-agents when it ends. The panel says so rather than
 * looking like it lost them.
 */
@Component({
  selector: 'app-session-tree',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Empty, QitsButton],
  template: `
    @if (rows().length === 0) {
      <app-empty message="No sessions have been recorded in this container yet." />
    } @else {
      <ul class="tree">
        @for (row of rows(); track row.kind + row.id) {
          <li
            class="row"
            [class.subagent]="row.kind === 'subagent'"
            [class.live]="row.id === liveSessionId()"
            [style.margin-left.rem]="row.depth * 1.1"
            [style.border-left-color]="row.accent"
          >
            <div class="what">
              <code class="id">{{ short(row.id) }}</code>
              @if (row.forked) {
                <span class="tag">fork</span>
              }
              @if (row.kind === 'subagent') {
                <span class="tag">sub-agent</span>
              }
              @if (row.id === liveSessionId()) {
                <span class="tag now">live</span>
              }
              @if (row.label) {
                <span class="label">{{ row.label }}</span>
              }
            </div>
            <div class="meta">
              <span class="at">{{ row.at ? at(row.at) : 'no recorded date' }}</span>
              <span class="count">{{ count(row) }}</span>
            </div>
            @if (row.kind === 'session' && !owned()) {
              <div class="verbs">
                <qits-button variant="secondary" size="sm" (pressed)="resumeSession.emit(row.id)">
                  Resume
                </qits-button>
                <qits-button variant="ghost" size="sm" (pressed)="forkSession.emit(row.id)">
                  Fork
                </qits-button>
              </div>
            }
          </li>
        }
      </ul>
      @if (owned()) {
        <p class="note">
          Resume is hidden while a run or a chat owns this workspace's conversation — two of them on
          one session is the collision session-pinning exists to prevent.
        </p>
      }
      <p class="note">
        Sub-agent side-chains are recorded when a run ends, so a live session shows its main thread
        only.
      </p>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .tree {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      flex-wrap: wrap;
      padding: 0.35rem 0.5rem;
      border-left: 3px solid transparent;
      background: #fff;
    }
    .row + .row {
      border-top: 1px solid #f3f4f6;
    }
    .row.live {
      background: #eff6ff;
    }
    .row.subagent {
      color: #6b7280;
      font-size: 0.85rem;
    }
    .what {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      min-width: 12rem;
    }
    .id {
      font-size: 0.8rem;
    }
    .tag {
      padding: 0 0.35rem;
      border-radius: 0.2rem;
      background: #f3f4f6;
      color: #4b5563;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .tag.now {
      background: #dbeafe;
      color: #1d4ed8;
    }
    .label {
      color: #4b5563;
      font-size: 0.8rem;
    }
    .meta {
      display: flex;
      gap: 0.75rem;
      color: #6b7280;
      font-size: 0.8rem;
    }
    .verbs {
      display: flex;
      gap: 0.25rem;
      margin-left: auto;
    }
    .note {
      margin: 0.5rem 0 0;
      color: #6b7280;
      font-size: 0.8rem;
    }
  `,
})
export class SessionTree {
  readonly sessions = input.required<readonly AgentSessionNodeDto[]>();

  /** The session the embedded terminal is driving, highlighted so the tree says where you are. */
  readonly liveSessionId = input<string | null>(null);

  /** Whether a run or a chat owns the conversation. While true, no row offers a resume. */
  readonly owned = input(false);

  /**
   * Named for what they do rather than for the verb on the button: `resume` collides with a standard
   * DOM event name, and an output that shadows one is a listener nobody can be sure of.
   */
  readonly resumeSession = output<string>();
  readonly forkSession = output<string>();

  protected readonly rows = computed(() => sessionRows(this.sessions()));

  protected short(id: string): string {
    return id.length > 12 ? `${id.slice(0, 8)}…` : id;
  }

  protected at(value: string): string {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
  }

  /** "Not swept yet" and "swept, and empty" are different sentences on purpose. */
  protected count(row: SessionRow): string {
    if (row.messageCount === undefined) {
      return 'messages counted when the run ends';
    }
    return `${row.messageCount} message${row.messageCount === 1 ? '' : 's'}`;
  }
}
