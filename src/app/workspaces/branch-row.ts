import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { QitsButton } from '@qits/ui-components';
import type { BranchDto } from '../api/dto';
import { driftLabel } from '../ui/format';

/**
 * A branch nobody is working on, and the one thing worth offering it: a workspace.
 *
 * The row is thin on purpose. A branch with no workspace has no runtime, no daemon, no working tree
 * and no preamble — there is no container to report any of it — so the row is a name and a button,
 * and a workspace row beside it is visibly richer because it genuinely knows more.
 *
 * **The drift is drawn only when it was measured.** `parent`, `ahead` and `behind` come back null
 * from the deployed service, which has no enrichment bean for them; a null rendered as "up to date"
 * would be a claim nobody made. So the clause is absent instead, and appears by itself the day the
 * server starts computing it.
 */
@Component({
  selector: 'app-branch-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [QitsButton],
  template: `
    <div class="row">
      <div class="identity">
        <p class="name">
          <code>{{ branch().name }}</code>
          @if (branch().parent) {
            <span class="sep">·</span>
            <span
              >off <code>{{ branch().parent }}</code></span
            >
          }
          @if (drift()) {
            <span class="sep">·</span>
            <span>{{ drift() }}</span>
          }
        </p>
        @if (error()) {
          <p class="failed" role="alert">⚠ {{ error() }}</p>
        }
      </div>
      <div class="action">
        <qits-button
          variant="secondary"
          size="sm"
          [busy]="busy()"
          (pressed)="create.emit(branch().name)"
        >
          {{ busy() ? 'Creating…' : 'Create workspace' }}
        </qits-button>
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
      align-items: baseline;
      justify-content: space-between;
      padding: 0.5rem 0;
      border-top: 1px solid #e5e7eb;
    }
    .identity {
      flex: 1 1 20rem;
      min-width: 0;
    }
    .name {
      margin: 0;
      color: #374151;
      font-size: 0.9rem;
      overflow-wrap: anywhere;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
    }
    .sep {
      margin: 0 0.35rem;
      color: #9ca3af;
    }
    .failed {
      margin: 0.2rem 0 0;
      color: #b91c1c;
      font-size: 0.85rem;
    }
  `,
})
export class BranchRow {
  readonly branch = input.required<BranchDto>();

  /** A create is out for this branch. The button says so and refuses a second press. */
  readonly busy = input(false);

  /** Why the last create here failed, or empty. Kept on the row that caused it. */
  readonly error = input('');

  /** Make a workspace over this branch. The page owns what that costs. */
  readonly create = output<string>();

  protected readonly drift = computed(() => {
    const branch = this.branch();
    return driftLabel(branch.ahead, branch.behind);
  });
}
