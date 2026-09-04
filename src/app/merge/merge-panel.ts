import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { QitsButton } from '@qits/ui-components';
import type { WorkspaceDto } from '../api/dto';
import { SUMMARY_MAX_LENGTH } from '../api/dto';
import { WorkspacesApi } from '../api/workspaces-api';
import { shortSha } from '../ui/format';
import {
  classifyMergeFailure,
  integrateResult,
  integrateSubject,
  type MergeFailure,
  type MergeResult,
  type MergeState,
} from './merge-outcome';

/**
 * One workspace's way home: the button, the summary it asks for, and every answer the service can
 * give — each drawn as its own surface.
 *
 * **There is one door here now, and some rows have none.** qits-workspaces used to own a release
 * door beside the integrate — work branched off the default branch was *released* into it, with a
 * version stamped — and that door has left the service: the default branch is written by a release
 * request in qits-projects, which folds the request's sources, releases a tag and merges the default
 * branch once the deployment is live. So this panel integrates, and a workspace whose parent *is*
 * the default branch is told where releasing happens instead of being offered a button that would
 * 404. Drawing a dead button would be worse than drawing none: it would read as the platform being
 * broken rather than as the work belonging somewhere else.
 *
 * **The service is still the authority on the target**, and says so with `RELEASE_REQUIRED` when a
 * row's reading of its parent is stale. That surface is a sentence rather than a hand-over now, for
 * the same reason: there is no other door in this application to hand anybody to.
 *
 * **The panel owns its request.** Merging one workspace is genuinely independent of merging
 * another: one row's conflict says nothing about the next row, and a page-level "the merge failed"
 * would not even name which one. So the state lives here, one instance per row, and the page is
 * told only what outlives the row — the result itself, through `(merged)`.
 *
 * **The affordance is a button until it is asked to be more.** A list of eight workspaces with
 * eight open text fields is a form, not a list, so the summary input appears on the press and the
 * row is otherwise one line.
 *
 * **The summary survives every failure.** Half the outcomes are retried by pressing a button
 * again — `moved` is resolved by nothing but a second attempt — and a person who has to retype
 * their sentence to retry will write a worse one.
 */
@Component({
  selector: 'app-merge-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [QitsButton],
  templateUrl: './merge-panel.html',
  styleUrl: './merge-panel.css',
})
export class MergePanel {
  private readonly api = inject(WorkspacesApi);

  /** The workspace this panel merges. */
  readonly workspace = input.required<WorkspaceDto>();

  /**
   * The repository's default branch, from qits-projects' `Repository.mainBranch`.
   *
   * It is what decides whether this row has a door at all, and it is displayed rather than assumed:
   * every repository on this platform says "main" today and none of them promises to, so the word is
   * read from the service that owns it.
   */
  readonly mainBranch = input.required<string>();

  /** A merge landed. The page records it, because this row is about to stop existing. */
  readonly merged = output<MergeResult>();

  /** The list is out of date and the user asked for it back — the "already integrated" way out. */
  readonly refresh = output<void>();

  protected readonly state = signal<MergeState>({ kind: 'closed' });
  protected readonly summary = signal('');

  protected readonly maxLength = SUMMARY_MAX_LENGTH;
  protected readonly shortSha = shortSha;

  /**
   * The workspace's parent branch, or the default branch when the service reports no parent.
   *
   * A parentless workspace is treated as branched off the default branch, which is what it is: the
   * field is nullable because qits-workspaces cannot always name a parent, not because the work
   * belongs nowhere.
   */
  private readonly parentBranch = computed(() => this.workspace().parent ?? this.mainBranch());

  /** Where this press will land: the parent branch, which is the only place an integrate goes. */
  protected readonly target = this.parentBranch;

  /**
   * Whether this row has a way home from here at all.
   *
   * <p>False for work parented on the default branch: that branch is written by a release request in
   * qits-projects and by nothing in this application, so the row draws where to go rather than a
   * button. The reading can be stale — the service's `RELEASE_REQUIRED` is the authority — but a
   * stale reading here costs a person one refusal, where offering the press would cost them a 404.
   */
  protected readonly hasDoor = computed(() => this.parentBranch() !== this.mainBranch());

  /** The branch being merged — the subject's scope on an integrate, and the label everywhere. */
  protected readonly sourceBranch = computed(
    () => this.workspace().branch ?? this.workspace().workspaceId,
  );

  /** The trimmed summary — what is validated, what is sent, and what the preview shows. */
  protected readonly trimmed = computed(() => this.summary().trim());

  /** A blank summary is refused here as well as by the service, so the press is never wasted. */
  protected readonly submittable = computed(() => this.trimmed().length > 0);

  /** How much of the cap is left, counted down rather than up — the budget is the useful number. */
  protected readonly remaining = computed(() => SUMMARY_MAX_LENGTH - this.summary().length);

  /**
   * The commit this will write, exactly — the scope is the source branch, which this client already
   * knows. What the preview is really for is the *sentence*: the scope is prepended for you, so
   * "integrate the new explorer" reads as a stutter and the preview is where you notice.
   */
  protected readonly preview = computed(() =>
    integrateSubject(this.sourceBranch(), this.trimmed() || '…'),
  );

  protected readonly failure = computed<MergeFailure | null>(() => {
    const state = this.state();
    return state.kind === 'failed' ? state.failure : null;
  });

  protected readonly result = computed<MergeResult | null>(() => {
    const state = this.state();
    return state.kind === 'done' ? state.result : null;
  });

  protected open(): void {
    this.state.set({ kind: 'editing' });
  }

  protected close(): void {
    this.state.set({ kind: 'closed' });
  }

  /** Back to the field with the text still in it — the way out of a conflict or a refusal. */
  protected edit(): void {
    this.state.set({ kind: 'editing' });
  }

  protected onSummaryInput(event: Event): void {
    this.summary.set((event.target as HTMLInputElement).value);
  }

  /**
   * One press, one attempt, never re-issued automatically — the retry is always a person's, because
   * a lost answer and a refusal look the same from here and only one of them is worth repeating.
   *
   * <p>It concludes on this call: an integrate is a merge, and when it answers the work is on its
   * parent. Nothing is polled afterwards — the panel used to follow a release request through its
   * gates, and that whole loop left with the release door.
   */
  protected async submit(): Promise<void> {
    if (!this.submittable() || this.state().kind === 'working') {
      return;
    }
    const id = this.workspace().id;
    const summary = this.trimmed();
    this.state.set({ kind: 'working' });
    try {
      const result = integrateResult(await this.api.integrate(id, summary));
      this.state.set({ kind: 'done', result });
      this.merged.emit(result);
    } catch (error) {
      this.state.set({ kind: 'failed', failure: classifyMergeFailure(error) });
    }
  }

  /** The list is stale, not this component — say so upward and stand down. */
  protected askRefresh(): void {
    this.state.set({ kind: 'closed' });
    this.refresh.emit();
  }
}
