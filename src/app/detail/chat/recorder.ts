import { signal, type Signal } from '@angular/core';
import type { AudioCapture, SpeechRuntime } from './speech-runtime';

/** How often the level is sampled. Fast enough to look live, slow enough to be a spec's tick. */
export const LEVEL_POLL_MS = 50;

/** How long a quiet stretch has to last before it counts as the end of an utterance. */
export const PAUSE_MS = 1200;

/** Above this, something is being said. Below it for {@link PAUSE_MS}, the utterance is over. */
export const SPEECH_LEVEL = 0.04;

const PAUSE_TICKS = Math.round(PAUSE_MS / LEVEL_POLL_MS);

/** Where the recorder is. */
export type RecorderState = 'idle' | 'starting' | 'recording' | 'unsupported';

/**
 * Record → transcribe → append, one utterance at a time.
 *
 * This is the record half of the oldest flow on this page, and the reason it is worth having back is
 * in the shape of the work: describing a change out loud is faster than typing it, and the model
 * that rewrites the result is already installed in the container. The refine half never went away —
 * the daemon's `POST /prompt-refinements` still exists and its meta-prompt still says *"You rewrite
 * raw speech-to-text transcripts"*, which is a button with no microphone in front of it.
 *
 * ## Utterances, not one long clip
 *
 * The transcript grows **as you pause** rather than when you stop, so a long dictation is readable
 * while it is happening and a bad recognition is visible before you have said three more sentences.
 * A pause is {@link PAUSE_MS} below {@link SPEECH_LEVEL} after something was actually said, measured
 * off the same level the meter draws — one signal, two readers.
 *
 * ## Uploads are serialised, because order is the whole content
 *
 * Two clips in flight at once come back in whichever order the model finished, and a transcript in
 * the wrong order is worse than a slow one. Each upload waits for the previous one; recording never
 * waits for either.
 *
 * ## What it does not do
 *
 * It does not stop recording while a clip is transcribing, it does not retry a failed clip, and it
 * does not hold audio anywhere after the text comes back. A failed clip says so once and the
 * recording carries on — losing one sentence is recoverable by saying it again, and a recorder that
 * stops on a hiccup loses everything after it.
 */
export class SpeechRecorder {
  private readonly phase = signal<RecorderState>('idle');
  private readonly loudness = signal(0);
  private readonly inFlight = signal(0);
  private readonly failure = signal<string | null>(null);

  readonly state: Signal<RecorderState> = this.phase.asReadonly();

  /** The input level, 0 to 1. Flat while you speak means the microphone is not reaching the page. */
  readonly level: Signal<number> = this.loudness.asReadonly();

  /** How many clips are waiting on the transcription service. */
  readonly transcribing: Signal<number> = this.inFlight.asReadonly();

  /** The last thing that went wrong, in a sentence. Cleared by the next successful start. */
  readonly problem: Signal<string | null> = this.failure.asReadonly();

  private capture: AudioCapture | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private quietTicks = 0;
  private heardSpeech = false;

  /** The upload chain. Every clip is appended to it, so they land in the order they were spoken. */
  private uploads: Promise<void> = Promise.resolve();

  constructor(
    private readonly runtime: SpeechRuntime,
    private readonly transcribe: (audioBase64: string) => Promise<string>,
    private readonly append: (text: string) => void,
  ) {}

  /** Ask for the microphone and start. A refusal is a state, not an exception the caller handles. */
  async start(): Promise<void> {
    if (this.phase() !== 'idle') {
      return;
    }
    if (!this.runtime.supported()) {
      this.phase.set('unsupported');
      return;
    }
    this.failure.set(null);
    this.phase.set('starting');
    try {
      this.capture = await this.runtime.capture();
    } catch (error) {
      this.phase.set('idle');
      this.failure.set(describeMicrophone(error));
      return;
    }
    this.quietTicks = 0;
    this.heardSpeech = false;
    this.phase.set('recording');
    this.ticker = setInterval(() => this.tick(), LEVEL_POLL_MS);
  }

  /** Stop, send whatever is left, and release the microphone. */
  async stop(): Promise<void> {
    if (this.phase() !== 'recording' && this.phase() !== 'starting') {
      return;
    }
    this.clearTicker();
    this.phase.set('idle');
    this.loudness.set(0);
    const capture = this.capture;
    this.capture = null;
    if (!capture) {
      return;
    }
    try {
      this.enqueue(await capture.stop());
    } catch (error) {
      this.failure.set(describeMicrophone(error));
    }
    await this.uploads;
  }

  /** Tear down without waiting for anything. The panel's destroy hook. */
  dispose(): void {
    this.clearTicker();
    const capture = this.capture;
    this.capture = null;
    this.phase.set('idle');
    void capture?.stop().catch(() => undefined);
  }

  private tick(): void {
    const capture = this.capture;
    if (!capture) {
      return;
    }
    const level = capture.level();
    this.loudness.set(level);

    if (level >= SPEECH_LEVEL) {
      this.heardSpeech = true;
      this.quietTicks = 0;
      return;
    }
    if (!this.heardSpeech) {
      return;
    }
    this.quietTicks += 1;
    if (this.quietTicks < PAUSE_TICKS) {
      return;
    }
    // An utterance has ended. Reset before the await so the next one starts counting immediately;
    // the cut itself is asynchronous and recording does not pause for it.
    this.quietTicks = 0;
    this.heardSpeech = false;
    void capture
      .cut()
      .then((clip) => this.enqueue(clip))
      .catch((error: unknown) => this.failure.set(describeMicrophone(error)));
  }

  /** Put one clip at the back of the upload chain. */
  private enqueue(audioBase64: string | null): void {
    if (!audioBase64) {
      return;
    }
    this.inFlight.update((count) => count + 1);
    this.uploads = this.uploads.then(async () => {
      try {
        const text = (await this.transcribe(audioBase64)).trim();
        if (text) {
          this.append(text);
        }
      } catch {
        this.failure.set('That clip was not transcribed — the speech service did not answer.');
      } finally {
        this.inFlight.update((count) => count - 1);
      }
    });
  }

  private clearTicker(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }
}

/**
 * Why the microphone is not available, in the user's terms.
 *
 * A refused permission is by far the common case and it is the one where the browser's own message
 * ("Permission denied") is least useful — it does not say what to do about it.
 */
function describeMicrophone(error: unknown): string {
  const name = typeof error === 'object' && error !== null ? (error as { name?: string }).name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'The microphone is blocked — allow it for this site and press Record again.';
  }
  if (name === 'NotFoundError') {
    return 'No microphone was found.';
  }
  return 'The microphone could not be started.';
}
