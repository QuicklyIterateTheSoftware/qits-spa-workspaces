import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
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
  gateFailure,
  gateOutcome,
  integrateResult,
  integrateSubject,
  releaseResult,
  releaseSubject,
  requestedView,
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
 * button on every row that answers 409 every time it is pressed. The reading can be out of date,
 * and the service says so with `RELEASE_REQUIRED`: that surface hands over the other door, which is
 * the only thing that ever changes a row's door.
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
 * **The summary survives every failure.** Three of the six outcomes are retried by pressing a
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
   * The repository the workspace belongs to — what a release request is filed under, and therefore
   * the first half of the poll's address. An input rather than a field on {@link workspace}
   * because `WorkspaceDto` does not carry it; the page that mounted this panel came in through the
   * repository and has it to give.
   */
  readonly repositoryId = input.required<string>();

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
   * The door the service told this row to use, once it has said so. Null until then.
   *
   * The only writer is the `RELEASE_REQUIRED` way out: qits-workspaces' main-target guard says this
   * work goes through the release door, and the service outranks the row's own reading.
   */
  private readonly chosenDoor = signal<MergeAction | null>(null);

  /**
   * The workspace's parent branch, or the default branch when the service reports no parent.
   *
   * A parentless workspace is treated as branched off the default branch, which is what it is: the
   * field is nullable because qits-workspaces cannot always name a parent, not because the work
   * belongs nowhere.
   */
  private readonly parentBranch = computed(() => this.workspace().parent ?? this.mainBranch());

  /**
   * Release or integrate, read from where the work goes rather than chosen by the person pressing.
   *
   * This is the client's reading of the row and never the authority: an integrate aimed at the
   * default branch comes back `RELEASE_REQUIRED`, and {@link releaseInstead} then lets the service's
   * answer overrule the reading — which is what makes a stale `parent` a button rather than a
   * dead end.
   */
  protected readonly action = computed<MergeAction>(
    () =>
      this.chosenDoor() ?? (this.parentBranch() === this.mainBranch() ? 'release' : 'integrate'),
  );

  /** Where this press will land. It follows the door, so every surface names the right branch. */
  protected readonly target = computed(() =>
    this.isRelease() ? this.mainBranch() : this.parentBranch(),
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

  /** The in-flight release request, while the gates hold it. Null in every other state. */
  protected readonly request = computed(() => {
    const state = this.state();
    return state.kind === 'requested' ? state.request : null;
  });

  /** The gating sentence for the state on hand — the words are this screen's, not the wire's. */
  protected readonly requestProgress = computed(() => {
    const request = this.request();
    if (request === null) {
      return '';
    }
    return request.state === 'READY'
      ? 'The gates passed — landing now.'
      : 'Waiting for the build to go green — the gates release it then.';
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

  /**
   * Take the door the service named, and stop at the summary rather than sending it.
   *
   * The switch changes what the commit will be — `integrate(<branch>)` becomes
   * `release(<version>)`, and this press will stamp a version and publish — so it goes back to the
   * form with the sentence intact and the new preview showing. One more press sends it. Firing
   * straight through would turn one press on the wrong door into a release nobody confirmed.
   */
  protected releaseInstead(): void {
    this.chosenDoor.set('release');
    this.state.set({ kind: 'editing' });
  }

  protected onSummaryInput(event: Event): void {
    this.summary.set((event.target as HTMLInputElement).value);
  }

  /**
   * One press, one attempt, never re-issued automatically. An integrate is a merge and the old
   * rule holds verbatim. A release is an *ask* now — the door creates (or converges on) the
   * branch's open request and the gates land it — so this press concludes with the request on
   * screen and {@link followRequest} polling it to its end. `merged` is emitted only when the
   * request reads RELEASED, because that is when this row actually stops existing.
   */
  protected async submit(): Promise<void> {
    const busy = this.state().kind;
    if (!this.submittable() || busy === 'working' || busy === 'requested') {
      return;
    }
    const id = this.workspace().id;
    const summary = this.trimmed();
    this.state.set({ kind: 'working' });
    try {
      if (this.isRelease()) {
        const request = requestedView(await this.api.release(id, summary));
        this.state.set({ kind: 'requested', request });
        void this.followRequest(request.id);
        return;
      }
      const result = integrateResult(await this.api.integrate(id, summary));
      this.state.set({ kind: 'done', result });
      this.merged.emit(result);
    } catch (error) {
      this.state.set({ kind: 'failed', failure: classifyMergeFailure(error) });
    }
  }

  private readonly destroyRef = inject(DestroyRef);
  private destroyed = false;
  private readonly stopOnDestroy = this.destroyRef.onDestroy(() => (this.destroyed = true));

  /** How long between polls of an in-flight request — CI is minutes, so seconds are plenty. A
   * field rather than a constant so the suite can shorten it to milliseconds. */
  protected pollEveryMs = 3_000;

  /**
   * Poll the request until it concludes. A poll that fails is skipped, not fatal — the request is
   * server-side state and the next tick reads it again; only a terminal state ends the loop. The
   * loop also ends when this panel stops showing that request (closed, destroyed, or a newer
   * press), so a stale loop can never overwrite a newer state.
   */
  private async followRequest(requestId: string): Promise<void> {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, this.pollEveryMs));
      const current = this.state();
      if (this.destroyed || current.kind !== 'requested' || current.request.id !== requestId) {
        return;
      }
      let request;
      try {
        request = await this.api.releaseRequest(this.repositoryId(), requestId);
      } catch {
        continue;
      }
      const still = this.state();
      if (this.destroyed || still.kind !== 'requested' || still.request.id !== requestId) {
        return;
      }
      const outcome = gateOutcome(request);
      if (outcome === 'released') {
        const result = releaseResult(request, this.mainBranch());
        this.state.set({ kind: 'done', result });
        this.merged.emit(result);
        return;
      }
      if (outcome === 'refused') {
        this.state.set({ kind: 'failed', failure: gateFailure(request) });
        return;
      }
      this.state.set({ kind: 'requested', request });
    }
  }

  /** The list is stale, not this component — say so upward and stand down. */
  protected askRefresh(): void {
    this.state.set({ kind: 'closed' });
    this.refresh.emit();
  }
}
