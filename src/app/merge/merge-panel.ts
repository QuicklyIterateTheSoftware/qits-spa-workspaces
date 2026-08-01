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
  VERSION_PLACEHOLDER,
  classifyMergeFailure,
  integrateResult,
  integrateSubject,
  releaseResult,
  releaseSubject,
  type MergeAction,
  type MergeFailure,
  type MergeResult,
  type MergeState,
} from './merge-outcome';

/**
 * One workspace's way home: the button, the summary it asks for, and every answer the service can
 * give — each drawn as its own surface.
 *
 * **One door per row, not two buttons.** Release and integrate are two processes and a workspace is
 * only ever eligible for one of them: work off the default branch is *released* into it, and work
 * off any other branch is *integrated* into that parent. Which one a row offers is therefore read
 * from the workspace's `parent`, not chosen by the person pressing — offering both would put a
 * button on every row that answers 409 every time it is pressed.
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
 * **The summary survives every failure.** Two of the five outcomes are retried by pressing the same
 * button again — `moved` is resolved by nothing but a second attempt — and a person who has to
 * retype their sentence to retry will write a worse one.
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
   * It is what decides which door this row offers, and it is displayed rather than assumed: every
   * repository on this platform says "main" today and none of them promises to, so the word is read
   * from the service that owns it.
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
   * Where this workspace's work goes: its parent branch, or the default branch when the service
   * reports no parent.
   *
   * A parentless workspace is treated as branched off the default branch, which is what it is: the
   * field is nullable because qits-workspaces cannot always name a parent, not because the work
   * belongs nowhere.
   */
  protected readonly target = computed(() => this.workspace().parent ?? this.mainBranch());

  /**
   * Release or integrate, decided by where the work goes rather than by the person pressing.
   *
   * This is the client's reading of the row and never the authority: the service refuses an
   * integrate aimed at the default branch with a 409 naming the release door, so a stale list
   * produces a clear refusal instead of a wrong merge.
   */
  protected readonly action = computed<MergeAction>(() =>
    this.target() === this.mainBranch() ? 'release' : 'integrate',
  );

  protected readonly isRelease = computed(() => this.action() === 'release');

  /** The word for this row's door, capitalised for a heading or a button. */
  protected readonly actionLabel = computed(() => (this.isRelease() ? 'Release' : 'Integrate'));

  /** The branch being merged — the subject's scope on an integrate, and the label everywhere. */
  protected readonly sourceBranch = computed(
    () => this.workspace().branch ?? this.workspace().workspaceId,
  );

  /**
   * What a lost race cost, in this row's terms. A release spends a version and an integrate does
   * not, and saying "no version was spent" under a door that stamps none would be noise.
   */
  protected readonly nothingLanded = computed(() =>
    this.isRelease() ? 'Nothing landed here and no version was spent.' : 'Nothing landed here.',
  );

  /** The same distinction, for a branch that turns out to be in already. */
  protected readonly nothingSecond = computed(() =>
    this.isRelease() ? 'no second release was made.' : 'nothing was merged a second time.',
  );

  /** The trimmed summary — what is validated, what is sent, and what the preview shows. */
  protected readonly trimmed = computed(() => this.summary().trim());

  /** A blank summary is refused here as well as by the service, so the press is never wasted. */
  protected readonly submittable = computed(() => this.trimmed().length > 0);

  /** How much of the cap is left, counted down rather than up — the budget is the useful number. */
  protected readonly remaining = computed(() => SUMMARY_MAX_LENGTH - this.summary().length);

  /**
   * The commit this will write.
   *
   * A release's version comes from the server's clock at the start of the call, so the browser
   * cannot know it and must not invent a plausible-looking one — the placeholder stands in its
   * place. An integrate's scope is the source branch, which is already known, so that preview is
   * the exact subject. What the preview is really for is the *sentence*: the scope is prepended for
   * you, so "release the new explorer" reads as a stutter and the preview is where you notice.
   */
  protected readonly preview = computed(() => {
    const summary = this.trimmed() || '…';
    return this.isRelease()
      ? releaseSubject(VERSION_PLACEHOLDER, summary)
      : integrateSubject(this.sourceBranch(), summary);
  });

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
   * One press, one attempt. Never re-issued automatically: a release is not idempotent — each call
   * stamps a new version, because two releases are two releases — so an automatic retry could
   * publish a version nobody asked for.
   */
  protected async submit(): Promise<void> {
    if (!this.submittable() || this.state().kind === 'working') {
      return;
    }
    const id = this.workspace().id;
    const summary = this.trimmed();
    this.state.set({ kind: 'working' });
    try {
      const result = this.isRelease()
        ? releaseResult(await this.api.release(id, summary), this.mainBranch())
        : integrateResult(await this.api.integrate(id, summary));
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
