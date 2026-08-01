import { LEVEL_POLL_MS, PAUSE_MS, SPEECH_LEVEL, SpeechRecorder } from './recorder';
import type { AudioCapture, SpeechRuntime } from './speech-runtime';

/** A microphone whose level is whatever the test last said it was. */
class FakeCapture implements AudioCapture {
  loudness = 0;
  cuts = 0;
  stopped = false;

  level(): number {
    return this.loudness;
  }

  async cut(): Promise<string | null> {
    this.cuts += 1;
    return `clip-${this.cuts}`;
  }

  async stop(): Promise<string | null> {
    this.stopped = true;
    return 'final';
  }
}

class FakeRuntime implements SpeechRuntime {
  capture_: FakeCapture | null = null;
  failure: Error | null = null;
  available = true;

  supported(): boolean {
    return this.available;
  }

  async capture(): Promise<AudioCapture> {
    if (this.failure) {
      throw this.failure;
    }
    this.capture_ = new FakeCapture();
    return this.capture_;
  }
}

/**
 * The record half of the flow, restored.
 *
 * The platform half — `getUserMedia`, `MediaRecorder`, the WAV encoder — is behind the runtime seam
 * and does not exist under jsdom. What is here is the part with decisions in it: when an utterance
 * ends, that uploads are serialised because order is the whole content, and that a refused
 * microphone is a state with a sentence rather than an exception.
 */
describe('SpeechRecorder', () => {
  let runtime: FakeRuntime;
  let transcripts: string[];
  let appended: string[];
  let answers: Map<string, string | Error>;
  let recorder: SpeechRecorder;
  let release: (() => void)[];

  beforeEach(() => {
    vi.useFakeTimers();
    runtime = new FakeRuntime();
    transcripts = [];
    appended = [];
    answers = new Map();
    release = [];
    recorder = new SpeechRecorder(
      runtime,
      async (clip) => {
        transcripts.push(clip);
        const answer = answers.get(clip);
        if (answer instanceof Error) {
          throw answer;
        }
        // Held open so a test can prove the second upload waits for the first.
        await new Promise<void>((resolve) => release.push(resolve));
        return answer ?? `text for ${clip}`;
      },
      (text) => appended.push(text),
    );
  });

  afterEach(() => {
    recorder.dispose();
    vi.useRealTimers();
  });

  /** Speak, then go quiet for long enough to end the utterance. */
  const utterance = (capture: FakeCapture) => {
    capture.loudness = SPEECH_LEVEL + 0.1;
    vi.advanceTimersByTime(LEVEL_POLL_MS * 3);
    capture.loudness = 0;
    vi.advanceTimersByTime(PAUSE_MS + LEVEL_POLL_MS);
  };

  it('says so rather than failing when the browser cannot record', async () => {
    runtime.available = false;
    await recorder.start();
    expect(recorder.state()).toBe('unsupported');
  });

  it('turns a refused microphone into a sentence about what to do', async () => {
    runtime.failure = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    await recorder.start();

    expect(recorder.state()).toBe('idle');
    expect(recorder.problem()).toContain('allow it for this site');
  });

  it('publishes the level while recording, which is the meter’s whole point', async () => {
    await recorder.start();
    const capture = runtime.capture_!;

    capture.loudness = 0.42;
    vi.advanceTimersByTime(LEVEL_POLL_MS);
    expect(recorder.level()).toBeCloseTo(0.42);
  });

  it('cuts an utterance on a pause, not on every quiet tick', async () => {
    await recorder.start();
    const capture = runtime.capture_!;

    // Quiet before anything was said is not a pause — it is a microphone waiting.
    capture.loudness = 0;
    vi.advanceTimersByTime(PAUSE_MS * 2);
    expect(capture.cuts).toBe(0);

    utterance(capture);
    expect(capture.cuts).toBe(1);
  });

  it('does not cut again until something else has been said', async () => {
    await recorder.start();
    const capture = runtime.capture_!;

    utterance(capture);
    vi.advanceTimersByTime(PAUSE_MS * 3);
    expect(capture.cuts).toBe(1);

    utterance(capture);
    expect(capture.cuts).toBe(2);
  });

  it('serialises uploads so the transcript stays in the order it was spoken', async () => {
    await recorder.start();
    const capture = runtime.capture_!;

    utterance(capture);
    await vi.advanceTimersByTimeAsync(0);
    utterance(capture);
    await vi.advanceTimersByTimeAsync(0);

    // Two clips cut, one in flight: the second is waiting on the first, not racing it.
    expect(capture.cuts).toBe(2);
    expect(transcripts).toEqual(['clip-1']);
    expect(recorder.transcribing()).toBe(2);

    release.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(transcripts).toEqual(['clip-1', 'clip-2']);

    release.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(appended).toEqual(['text for clip-1', 'text for clip-2']);
    expect(recorder.transcribing()).toBe(0);
  });

  it('carries on after a clip fails, because a hiccup must not lose what comes next', async () => {
    answers.set('clip-1', new Error('stt is down'));
    await recorder.start();
    const capture = runtime.capture_!;

    utterance(capture);
    await vi.advanceTimersByTimeAsync(0);
    expect(recorder.problem()).toContain('not transcribed');
    expect(recorder.state()).toBe('recording');

    utterance(capture);
    await vi.advanceTimersByTimeAsync(0);
    expect(transcripts).toEqual(['clip-1', 'clip-2']);
  });

  it('sends the last utterance on stop and then releases the microphone', async () => {
    await recorder.start();
    const capture = runtime.capture_!;
    capture.loudness = SPEECH_LEVEL + 0.1;
    vi.advanceTimersByTime(LEVEL_POLL_MS * 2);

    const stopping = recorder.stop();
    await vi.advanceTimersByTimeAsync(0);
    release.shift()?.();
    await stopping;

    expect(capture.stopped).toBe(true);
    expect(transcripts).toEqual(['final']);
    expect(appended).toEqual(['text for final']);
    expect(recorder.state()).toBe('idle');
    expect(recorder.level()).toBe(0);
  });

  it('stops the level poll on stop, so nothing ticks against a released microphone', async () => {
    await recorder.start();
    const capture = runtime.capture_!;

    const stopping = recorder.stop();
    await vi.advanceTimersByTimeAsync(0);
    release.shift()?.();
    await stopping;

    const cutsAtStop = capture.cuts;
    vi.advanceTimersByTime(PAUSE_MS * 4);
    expect(capture.cuts).toBe(cutsAtStop);
  });
});
