import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { QitsButton } from '@qits/ui-components';
import { CommandsApi, type CommandDto } from '../../api/commands-api';
import { PromptDraftApi } from '../../api/prompt-draft-api';
import { SpeechApi } from '../../api/speech-api';
import { WorkspaceEvents } from '../../api/workspace-events';
import { relativeSince } from '../../ui/format';
import { describeError } from '../../ui/loadable';
import { LevelMeter } from './level-meter';
import {
  PickedContext,
  elementText,
  parseComposition,
  referenceLabel,
  referenceText,
  serializePrompt,
  type CodeReference,
  type DraftComposition,
} from './picked-context';
import { SpeechRecorder } from './recorder';
import { SPEECH_RUNTIME } from './speech-runtime';

/** How long typing has to stop before the draft is saved. */
export const DRAFT_DEBOUNCE_MS = 750;

/** Where the composition is in its life. */
type SaveState = 'clean' | 'pending' | 'saving' | 'dirty';

/**
 * Compose the next thing to ask the agent.
 *
 * ## What it loads
 *
 * **One request**: `GET /workspaces/api/workspaces/{id}/prompt-draft`. A 404 means nothing was ever
 * composed here, which is a different screen from an empty one — it is why the restored-draft hint
 * can be honest.
 *
 * ## Four inputs, one draft
 *
 * Speech, refinement, picked context and typed text all feed the same box. The original kept the
 * transcript and the prompt in two boxes and promoted between them; there is one box here, and the
 * two promotion buttons act on it — "Refine into prompt" replaces its contents with the rewrite,
 * "Use transcript as-is" keeps what is there and puts the offer away.
 *
 * ## The draft is the one optimistic thing on the page
 *
 * You type, the box is already right, and a debounced save follows. A failed save leaves the draft
 * marked dirty so the next edit retries — losing a keystroke to a 500 is not a thing a text box may
 * do. Everything else on this screen waits for the server and refetches.
 *
 * The `prompt-draft` hint fires on the client's own saves as well as another device's, so the echo
 * is deduped on `updatedAt`: the value a save answers with is byte-identical to the one a later read
 * gives, which is the whole reason the save's response is used rather than discarded. A hint that is
 * *not* our echo is another device, and it is adopted only when there is nothing local to lose.
 *
 * ## Flush-then-launch, and a failed flush aborts
 *
 * The draft is written synchronously before the launch, and a failure stops the launch with a
 * visible error. Two reasons to keep this even now, while the prompt is delivered inline and the
 * race it defends against is temporarily absent: the moment image attachments land, delivery
 * inverts back to *fetch* and the discipline has to already be there; and a draft that failed to
 * save is work about to be lost, which is worth aborting for on its own. **Launching with the wrong
 * prompt is worse than not launching.**
 */
@Component({
  selector: 'app-prompt-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LevelMeter, QitsButton],
  templateUrl: './prompt-panel.html',
  styleUrl: './prompt-panel.css',
})
export class PromptPanel {
  private readonly drafts = inject(PromptDraftApi);
  private readonly commandsApi = inject(CommandsApi);
  private readonly speech = inject(SpeechApi);
  private readonly events = inject(WorkspaceEvents);
  protected readonly picked = inject(PickedContext);

  /** Which workspace's container to launch in, and whose draft to hold. */
  readonly workspaceRowId = input.required<number>();

  /** The workspace's stated goal. Host-side metadata the refinement request has to carry. */
  readonly preamble = input<string | null>(null);

  /** A chat was launched. The panel does not swap itself; the tab decides what it shows. */
  readonly launched = output<CommandDto>();

  protected readonly text = signal('');
  protected readonly save = signal<SaveState>('clean');
  protected readonly saveProblem = signal<string | null>(null);

  /** The draft that was on the server when this panel opened, if any. */
  protected readonly restoredAt = signal<string | null>(null);

  /** Whether the refinement offer is still on the table. "Use as-is" is what takes it off. */
  protected readonly offerRefine = signal(true);
  protected readonly refining = signal(false);
  protected readonly refineProblem = signal<string | null>(null);

  protected readonly launching = signal(false);
  protected readonly launchProblem = signal<string | null>(null);

  private readonly runtime = inject(SPEECH_RUNTIME);

  private readonly recorder = new SpeechRecorder(
    this.runtime,
    (audio) => this.speech.transcribe(audio),
    (text) => this.appendUtterance(text),
  );

  protected readonly recording = computed(() => this.recorder.state() === 'recording');
  protected readonly starting = computed(() => this.recorder.state() === 'starting');

  /**
   * Asked before the button is drawn rather than after it is pressed.
   *
   * A Record button that only explains itself once you have pressed it is a button that lies until
   * then, and this is the one capability check the answer to is known up front.
   */
  protected readonly unsupported = computed(
    () => !this.runtime.supported() || this.recorder.state() === 'unsupported',
  );
  protected readonly level = this.recorder.level;
  protected readonly transcribing = this.recorder.transcribing;
  protected readonly micProblem = this.recorder.problem;

  private timer: ReturnType<typeof setTimeout> | null = null;

  /** What was last written, so the `prompt-draft` hint can tell our own echo from someone else's. */
  private lastWrittenAt: string | null = null;
  private loadedFor = 0;
  private seenHint = -1;

  private readonly draftHints = this.events.invalidations('prompt-draft');

  constructor() {
    effect(() => {
      const workspaceRowId = this.workspaceRowId();
      untracked(() => {
        this.picked.use(workspaceRowId);
        if (this.loadedFor !== workspaceRowId) {
          this.loadedFor = workspaceRowId;
          void this.restore(workspaceRowId);
        }
      });
    });

    // The counter's *movement* is the signal, so the first run is skipped: the restore above is
    // already the initial read, and answering the effect's own first tick would double it.
    effect(() => {
      const hint = this.draftHints();
      untracked(() => {
        if (this.seenHint < 0) {
          this.seenHint = hint;
          return;
        }
        if (hint === this.seenHint) {
          return;
        }
        this.seenHint = hint;
        void this.reconcile(this.workspaceRowId());
      });
    });

    inject(DestroyRef).onDestroy(() => {
      this.clearTimer();
      this.recorder.dispose();
    });
  }

  // ---- composition ------------------------------------------------------------------------------

  protected readonly composition = computed<DraftComposition>(() => ({
    text: this.text(),
    references: this.picked.references(),
    elements: this.picked.elements(),
  }));

  /** Whether there is anything to launch with. An empty prompt is not a launch. */
  protected readonly composed = computed(() => serializePrompt(this.composition()).trim());

  protected readonly canLaunch = computed(
    () => this.composed().length > 0 && !this.launching() && !this.recording(),
  );

  protected readonly canRefine = computed(
    () => this.text().trim().length > 0 && !this.refining() && !this.recording(),
  );

  protected label(reference: CodeReference): string {
    return referenceLabel(reference);
  }

  /** How long ago the restored draft was written — "2h ago", the hint's whole content. */
  protected ago(iso: string): string {
    return relativeSince(iso);
  }

  /**
   * What the footer says about the draft.
   *
   * `clean` says nothing at all. A box that permanently announces "saved" is noise; the states worth
   * a word are the two where the server and the box disagree.
   */
  protected readonly saveLabel = computed(() => {
    switch (this.save()) {
      case 'pending':
        return 'Not saved yet';
      case 'saving':
        return 'Saving…';
      case 'dirty':
        return 'Not saved — the next edit retries';
      default:
        return '';
    }
  });

  protected onType(value: string): void {
    this.text.set(value);
    // The hint is about the draft that was found, and the first edit is the moment it stops being
    // someone else's work and becomes yours.
    this.restoredAt.set(null);
    this.scheduleSave();
  }

  protected insertReference(index: number): void {
    const reference = this.picked.references()[index];
    if (reference) {
      this.insert(referenceText(reference));
    }
  }

  protected insertElement(index: number): void {
    const element = this.picked.elements()[index];
    if (element) {
      this.insert(elementText(element));
    }
  }

  private insert(fragment: string): void {
    this.text.update((current) => (current.trim() ? `${current.trimEnd()}\n\n${fragment}` : fragment));
    this.scheduleSave();
  }

  private appendUtterance(utterance: string): void {
    this.text.update((current) => (current.trim() ? `${current.trimEnd()} ${utterance}` : utterance));
    this.offerRefine.set(true);
    this.restoredAt.set(null);
    this.scheduleSave();
  }

  // ---- speech -----------------------------------------------------------------------------------

  protected async record(): Promise<void> {
    await this.recorder.start();
  }

  protected async stopRecording(): Promise<void> {
    await this.recorder.stop();
    await this.flush();
  }

  // ---- refinement -------------------------------------------------------------------------------

  /**
   * Rewrite what is in the box into a prompt.
   *
   * The transcript is whatever the box holds — dictated, typed, or both — because the model that
   * does this was written for exactly that: fixing recognition artifacts and false starts while
   * preserving every technical detail. Sending a hand-typed prompt through it is harmless and
   * sometimes useful; it is one button and the user decides.
   */
  protected async refine(): Promise<void> {
    const transcript = this.text().trim();
    if (!transcript) {
      return;
    }
    this.refining.set(true);
    this.refineProblem.set(null);
    try {
      const prompt = await this.commandsApi.refinePrompt(
        this.workspaceRowId(),
        transcript,
        this.preamble(),
      );
      this.text.set(prompt);
      this.offerRefine.set(false);
      this.scheduleSave();
    } catch (error) {
      this.refineProblem.set(`The rewrite did not happen — ${describeError(error)}.`);
    } finally {
      this.refining.set(false);
    }
  }

  /** Keep the words as spoken. No request, no change — just the offer put away. */
  protected useAsIs(): void {
    this.offerRefine.set(false);
    this.refineProblem.set(null);
  }

  // ---- the draft --------------------------------------------------------------------------------

  private async restore(workspaceRowId: number): Promise<void> {
    if (workspaceRowId <= 0) {
      return;
    }
    try {
      const draft = await this.drafts.draft(workspaceRowId);
      if (this.workspaceRowId() !== workspaceRowId || !draft) {
        return;
      }
      const composition = parseComposition(draft.content);
      this.text.set(composition.text);
      this.picked.restore(composition);
      this.lastWrittenAt = draft.updatedAt;
      this.restoredAt.set(draft.updatedAt);
      this.save.set('clean');
    } catch (error) {
      this.saveProblem.set(`The saved draft could not be read — ${describeError(error)}.`);
    }
  }

  /**
   * A `prompt-draft` hint arrived. Decide whether it was us.
   *
   * Our own save fires the same topic, so a blind refetch would fight the box on every keystroke's
   * debounce. The `updatedAt` a save answers with is byte-identical to the one a read gives, so it
   * is an exact echo test — and when the answer is *not* our echo it is another device, adopted only
   * if there is nothing local it would throw away. Anything else is a merge, and a text box is the
   * wrong place to invent one.
   */
  private async reconcile(workspaceRowId: number): Promise<void> {
    if (workspaceRowId <= 0 || this.save() !== 'clean') {
      return;
    }
    try {
      const draft = await this.drafts.draft(workspaceRowId);
      if (!draft || draft.updatedAt === this.lastWrittenAt || this.save() !== 'clean') {
        return;
      }
      const composition = parseComposition(draft.content);
      this.text.set(composition.text);
      this.picked.restore(composition);
      this.lastWrittenAt = draft.updatedAt;
      this.restoredAt.set(draft.updatedAt);
    } catch {
      // A failed reconcile leaves the box exactly as it was, which is the safe half of the trade.
    }
  }

  private scheduleSave(): void {
    this.save.set('pending');
    this.clearTimer();
    this.timer = setTimeout(() => void this.write(), DRAFT_DEBOUNCE_MS);
  }

  /** Write now, if anything is waiting. What the launch path calls before it launches. */
  protected async flush(): Promise<void> {
    if (this.save() === 'clean') {
      return;
    }
    this.clearTimer();
    await this.write();
  }

  private async write(): Promise<void> {
    this.clearTimer();
    const workspaceRowId = this.workspaceRowId();
    const composition = this.composition();
    this.save.set('saving');
    try {
      const draft = await this.drafts.save(
        workspaceRowId,
        JSON.stringify(composition),
        serializePrompt(composition),
      );
      this.lastWrittenAt = draft.updatedAt;
      // Only clean if nothing was typed while the request was out — otherwise the next debounce owns
      // it, and marking clean here would be the one way to actually lose a keystroke.
      if (this.save() === 'saving') {
        this.save.set('clean');
      }
      this.saveProblem.set(null);
    } catch (error) {
      this.save.set('dirty');
      this.saveProblem.set(`The draft is not saved — ${describeError(error)}.`);
    }
  }

  /** Throw the restored draft away. The hint's own action, and it clears the picks with it. */
  protected async discard(): Promise<void> {
    this.clearTimer();
    this.text.set('');
    this.picked.clear();
    this.restoredAt.set(null);
    this.save.set('clean');
    try {
      await this.drafts.discard(this.workspaceRowId());
      this.lastWrittenAt = null;
      this.saveProblem.set(null);
    } catch (error) {
      this.saveProblem.set(`The draft could not be discarded — ${describeError(error)}.`);
    }
  }

  // ---- launching --------------------------------------------------------------------------------

  /**
   * Flush, then launch as a chat.
   *
   * The flush is awaited and its failure is fatal to the launch. `deliverTaskPrompt` stays false and
   * the composed prompt rides `initialContext`: text, code references and picked elements are all
   * text, and the fetch path exists only for images, which are phase two.
   */
  protected async launchChat(): Promise<void> {
    if (!this.canLaunch()) {
      return;
    }
    this.launching.set(true);
    this.launchProblem.set(null);
    try {
      await this.flush();
      if (this.save() === 'dirty') {
        this.launchProblem.set(
          'The draft did not save, so nothing was launched — the agent would have read the wrong prompt. Try again.',
        );
        return;
      }
      const command = await this.commandsApi.launchAgent(this.workspaceRowId(), {
        scope: 'REPOSITORY',
        mode: 'CHAT',
        initialContext: this.composed(),
        deliverTaskPrompt: false,
      });
      this.launched.emit(command);
    } catch (error) {
      this.launchProblem.set(`The agent did not start — ${describeError(error)}.`);
    } finally {
      this.launching.set(false);
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
