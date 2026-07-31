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
import type { IntegrateResponse, WorkspaceDto } from '../api/dto';
import { SUMMARY_MAX_LENGTH } from '../api/dto';
import { WorkspacesApi } from '../api/workspaces-api';
import { shortSha } from '../ui/format';
import {
  VERSION_PLACEHOLDER,
  classifyIntegrateFailure,
  commitSubject,
  type IntegrateFailure,
  type IntegrateState,
} from './integrate-outcome';

/**
 * One workspace's Integrate affordance: the button, the summary it asks for, and every answer the
 * service can give — each drawn as its own surface.
 *
 * **The panel owns its request.** Integrating one workspace is genuinely independent of integrating
 * another: one row's conflict says nothing about the next row, and a page-level "the integrate
 * failed" would not even name which one. So the state lives here, one instance per row, and the
 * page is told only what outlives the row — the release itself, through `(integrated)`.
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
  selector: 'app-integrate-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [QitsButton],
  templateUrl: './integrate-panel.html',
  styleUrl: './integrate-panel.css',
})
export class IntegratePanel {
  private readonly api = inject(WorkspacesApi);

  /** The workspace this panel integrates. */
  readonly workspace = input.required<WorkspaceDto>();

  /**
   * The branch an integrate lands on, from qits-projects' `Repository.mainBranch`.
   *
   * Shown, never sent: the request carries no target, because **the target is always the
   * repository's default branch by construction** — that is the feature. It is displayed so the
   * page names the destination rather than hardcoding the word "main", which is true of every
   * repository here and guaranteed by none of them.
   */
  readonly targetBranch = input.required<string>();

  /** A release happened. The page records it, because this row is about to stop existing. */
  readonly integrated = output<IntegrateResponse>();

  /** The list is out of date and the user asked for it back — the "already integrated" way out. */
  readonly refresh = output<void>();

  protected readonly state = signal<IntegrateState>({ kind: 'closed' });
  protected readonly summary = signal('');

  protected readonly maxLength = SUMMARY_MAX_LENGTH;
  protected readonly shortSha = shortSha;

  /** The trimmed summary — what is validated, what is sent, and what the preview shows. */
  protected readonly trimmed = computed(() => this.summary().trim());

  /** A blank summary is refused here as well as by the service, so the press is never wasted. */
  protected readonly submittable = computed(() => this.trimmed().length > 0);

  /** How much of the cap is left, counted down rather than up — the budget is the useful number. */
  protected readonly remaining = computed(() => SUMMARY_MAX_LENGTH - this.summary().length);

  /**
   * The commit this will write, with the version left as a placeholder.
   *
   * The stamp comes from the server's clock at the start of the integrate, so the browser cannot
   * know it and must not invent a plausible-looking one. What the preview is for is the *sentence*:
   * `release(…): ` is prepended for you, so "release the new explorer" reads as a stutter and the
   * preview is where you notice.
   */
  protected readonly preview = computed(() =>
    commitSubject(VERSION_PLACEHOLDER, this.trimmed() || '…'),
  );

  protected readonly failure = computed<IntegrateFailure | null>(() => {
    const state = this.state();
    return state.kind === 'failed' ? state.failure : null;
  });

  protected readonly result = computed<IntegrateResponse | null>(() => {
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
   * One press, one attempt. Never re-issued automatically: an integrate is not idempotent — each
   * call stamps a new version, because two integrates are two releases — so an automatic retry
   * could publish a second release nobody asked for.
   */
  protected async submit(): Promise<void> {
    if (!this.submittable() || this.state().kind === 'working') {
      return;
    }
    this.state.set({ kind: 'working' });
    try {
      const result = await this.api.integrate(this.workspace().id, this.trimmed());
      this.state.set({ kind: 'done', result });
      this.integrated.emit(result);
    } catch (error) {
      this.state.set({ kind: 'failed', failure: classifyIntegrateFailure(error) });
    }
  }

  /** The list is stale, not this component — say so upward and stand down. */
  protected askRefresh(): void {
    this.state.set({ kind: 'closed' });
    this.refresh.emit();
  }
}
