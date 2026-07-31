import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { QitsBadge, type QitsBadgeTone } from '@qits/ui-components';
import type { WorkspaceDto } from '../api/dto';
import { driftLabel } from '../ui/format';

/** One badge to draw: what it says and how loud it is. */
interface RowBadge {
  readonly label: string;
  readonly tone: QitsBadgeTone;
}

/**
 * One workspace, as a line: what it is, where its branch stands, and a slot for the action.
 *
 * Presentational and request-free. The integrate affordance is projected in rather than rendered
 * here, which keeps "what a workspace looks like" separate from "what integrating one does" — the
 * second is a state machine with five failure surfaces and the first is a heading and some badges.
 *
 * The badges are **reported state, never gates.** A STOPPED workspace integrates exactly as well as
 * a RUNNING one, because integrate reads the durable branch from the bare origin and never the
 * container; the runtime badge is there to explain the row, not to justify a disabled button.
 * `conflictsWithParent` is the one that predicts trouble, and it is a warning rather than a block:
 * it is measured against the workspace's *parent*, which for a stacked workspace is not the branch
 * an integrate targets, so treating it as an answer would be wrong in exactly the case it matters.
 */
@Component({
  selector: 'app-workspace-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [QitsBadge],
  template: `
    <div class="row">
      <div class="identity">
        <h3>{{ workspace().workspaceId }}</h3>
        <p class="meta">
          <code>{{ workspace().branch ?? workspace().workspaceId }}</code>
          @if (workspace().parent) {
            <span class="sep">·</span>
            <span
              >off <code>{{ workspace().parent }}</code></span
            >
          }
          @if (drift()) {
            <span class="sep">·</span>
            <span>{{ drift() }}</span>
          }
        </p>
        @if (badges().length > 0) {
          <p class="badges">
            @for (badge of badges(); track badge.label) {
              <qits-badge [label]="badge.label" [tone]="badge.tone" />
            }
          </p>
        }
        @if (workspace().preamble) {
          <p class="preamble">{{ workspace().preamble }}</p>
        }
      </div>
      <div class="action">
        <ng-content />
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .row {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      justify-content: space-between;
      padding: 0.85rem 0;
      border-top: 1px solid #e5e7eb;
    }
    .identity {
      flex: 1 1 20rem;
      min-width: 0;
    }
    .action {
      flex: 1 1 22rem;
      min-width: 0;
    }
    h3 {
      margin: 0;
      font-size: 1rem;
    }
    .meta {
      margin: 0.1rem 0 0;
      color: #6b7280;
      font-size: 0.85rem;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
    }
    .sep {
      margin: 0 0.35rem;
    }
    .badges {
      display: flex;
      gap: 0.35rem;
      flex-wrap: wrap;
      margin: 0.35rem 0 0;
    }
    .preamble {
      margin: 0.35rem 0 0;
      color: #374151;
      font-size: 0.88rem;
      overflow-wrap: anywhere;
    }
  `,
})
export class WorkspaceRow {
  readonly workspace = input.required<WorkspaceDto>();

  protected readonly drift = computed(() => {
    const workspace = this.workspace();
    return driftLabel(workspace.ahead, workspace.behind);
  });

  /**
   * Only what is known. Every one of these fields is nullable because qits-workspaces only learns
   * it from a live in-container daemon, and a null drawn as a confident word ("clean", "idle")
   * would be the list's one outright lie.
   */
  protected readonly badges = computed<readonly RowBadge[]>(() => {
    const workspace = this.workspace();
    const badges: RowBadge[] = [];
    if (workspace.runtimeStatus) {
      badges.push({
        label: workspace.runtimeStatus.toLowerCase(),
        tone: RUNTIME_TONES[workspace.runtimeStatus],
      });
    }
    if (workspace.clean === false) {
      badges.push({ label: 'uncommitted changes', tone: 'warning' });
    }
    if (workspace.agentActivity) {
      badges.push({ label: `agent ${workspace.agentActivity.toLowerCase()}`, tone: 'info' });
    }
    if (workspace.conflictsWithParent) {
      badges.push({ label: 'conflicts with parent', tone: 'warning' });
    }
    return badges;
  });
}

const RUNTIME_TONES: Readonly<Record<string, QitsBadgeTone>> = {
  RUNNING: 'success',
  STOPPED: 'neutral',
  PROVISIONING: 'info',
  FAILED: 'danger',
};
