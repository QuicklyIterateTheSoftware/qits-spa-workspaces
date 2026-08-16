import { InjectionToken } from '@angular/core';

/**
 * The browser's audio capture, behind an interface small enough to fake.
 *
 * Everything platform-specific lives in this file: `getUserMedia`, `AudioContext`, `AnalyserNode`,
 * `MediaRecorder` and the WAV encoder. None of it exists under jsdom, so none of it is unit-tested
 * — and that is exactly why the seam is here rather than inside the recorder. The part worth testing
 * is the state machine over it: when an utterance is cut, that uploads are serialised, that a
 * refused microphone says so. That part sees only {@link AudioCapture}.
 *
 * **No dependency was added for any of this.** `MediaRecorder` and `AudioContext` are browser-native
 * and `decodeAudioData` is what turns the one into the other's PCM.
 */

/** One live microphone capture. */
export interface AudioCapture {
  /**
   * The most recent input level, 0 to 1.
   *
   * This is the level meter's whole point and it is a diagnostic before it is decoration: **if the
   * bar stays flat while you speak, no audio is reaching the page.** That single fact is the most
   * useful thing this surface can tell you, and it is invisible without a meter.
   */
  level(): number;

  /**
   * End the current utterance and hand it over as base64 WAV, then keep capturing.
   *
   * Null when the utterance held no audio worth sending — a clip of pure silence is a round trip for
   * an empty string.
   */
  cut(): Promise<string | null>;

  /** Cut a last time, then release the microphone and close the audio graph. */
  stop(): Promise<string | null>;
}

/** How the page asks for a microphone. */
export interface SpeechRuntime {
  /** Whether this browser can do any of it. False means the Record button explains itself. */
  supported(): boolean;

  /** Ask for the microphone and start capturing. Rejects when permission is refused. */
  capture(): Promise<AudioCapture>;
}

/**
 * How this application records.
 *
 * A token for the same reason the socket and stream factories are tokens: the behaviour worth
 * testing is unreachable without driving it by hand, and here it is unreachable *at all* under
 * jsdom.
 */
export const SPEECH_RUNTIME = new InjectionToken<SpeechRuntime>('qits.speech-runtime', {
  providedIn: 'root',
  factory: () => new BrowserSpeechRuntime(),
});

/** The sample rate the WAV declares. The model resamples, so this is whatever the device gave us. */
const BITS_PER_SAMPLE = 16;

/** The browser implementation. Constructed eagerly, but it touches nothing until {@link capture}. */
export class BrowserSpeechRuntime implements SpeechRuntime {
  supported(): boolean {
    return (
      typeof MediaRecorder !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof AudioContext !== 'undefined'
    );
  }

  async capture(): Promise<AudioCapture> {
    const [context, stream] = await activatedMicrophone(
      () => navigator.mediaDevices.getUserMedia({ audio: true }),
      () => new AudioContext(),
    );
    return new BrowserCapture(stream, context);
  }
}

/**
 * Open the microphone first, then the Web Audio graph while the page is actively capturing.
 *
 * The Record control reaches this code through qits-button's custom `pressed` event. Chromium
 * carries native-click activation through that event; Firefox may not, and therefore keeps a
 * context created before getUserMedia suspended. Once getUserMedia resolves the document is an
 * active capture document, which Firefox permits to start Web Audio. Checking the resulting state
 * keeps a suspended graph from masquerading as a recording with a permanently flat meter.
 */
export async function activatedMicrophone(
  getStream: () => Promise<MediaStream>,
  createContext: () => AudioContext,
): Promise<readonly [AudioContext, MediaStream]> {
  const stream = await getStream();
  const context = createContext();
  try {
    await context.resume();
    if (context.state !== 'running') {
      throw new DOMException('The browser kept Web Audio suspended', 'NotAllowedError');
    }
    return [context, stream] as const;
  } catch (error) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    await context.close();
    throw error;
  }
}

class BrowserCapture implements AudioCapture {
  private readonly analyser: AnalyserNode;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly sink: GainNode;
  private readonly samples: Uint8Array<ArrayBuffer>;
  private recorder: MediaRecorder;
  private chunks: Blob[] = [];
  private closed = false;

  constructor(
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
  ) {
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.samples = new Uint8Array(this.analyser.fftSize);
    [this.source, this.sink] = meterGraph(this.context, stream, this.analyser);
    this.recorder = this.newRecorder();
    this.recorder.start();
  }

  level(): number {
    // Time-domain RMS around the 128 midpoint. Loudness, not spectrum: the question the meter
    // answers is "is anything arriving", and a frequency plot answers it no better and reads worse.
    this.analyser.getByteTimeDomainData(this.samples);
    let sum = 0;
    for (const sample of this.samples) {
      const centred = (sample - 128) / 128;
      sum += centred * centred;
    }
    return Math.min(1, Math.sqrt(sum / this.samples.length) * 4);
  }

  async cut(): Promise<string | null> {
    if (this.closed) {
      return null;
    }
    const clip = await this.flush();
    this.recorder = this.newRecorder();
    this.recorder.start();
    return clip;
  }

  async stop(): Promise<string | null> {
    if (this.closed) {
      return null;
    }
    this.closed = true;
    const clip = await this.flush();
    for (const track of this.stream.getTracks()) {
      track.stop();
    }
    this.source.disconnect();
    this.analyser.disconnect();
    this.sink.disconnect();
    await this.context.close();
    return clip;
  }

  /** Stop the recorder, wait for its last blob, and encode what it held. */
  private async flush(): Promise<string | null> {
    if (this.recorder.state === 'inactive') {
      return null;
    }
    const stopped = new Promise<void>((resolve) => {
      this.recorder.onstop = () => resolve();
    });
    this.recorder.stop();
    await stopped;
    const parts = this.chunks;
    this.chunks = [];
    if (parts.length === 0) {
      return null;
    }
    return this.encode(new Blob(parts, { type: this.recorder.mimeType }));
  }

  private newRecorder(): MediaRecorder {
    const recorder = new MediaRecorder(this.stream);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };
    return recorder;
  }

  /**
   * Compressed capture in, base64 WAV out.
   *
   * `MediaRecorder` produces WebM/Opus and the transcription service wants PCM in a WAV container,
   * so the round trip is `decodeAudioData` — which is the decoder the browser already ships — then a
   * 44-byte header and 16-bit samples. Down-mixed to mono, because the model is monophonic and a
   * second identical channel doubles the upload for nothing. The rate is left as the device gave it;
   * the service resamples.
   */
  private async encode(blob: Blob): Promise<string | null> {
    const audio = await this.context.decodeAudioData(await blob.arrayBuffer());
    const frames = audio.length;
    if (frames === 0) {
      return null;
    }
    const mono = new Float32Array(frames);
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      const data = audio.getChannelData(channel);
      for (let frame = 0; frame < frames; frame++) {
        mono[frame] += data[frame] / audio.numberOfChannels;
      }
    }
    return base64(wav(mono, audio.sampleRate));
  }
}

/**
 * Keep the microphone graph alive and make the browser render it without audible loopback.
 *
 * An analyser with no downstream consumer works in Chromium, but Web Audio permits implementations
 * to prune graph branches that cannot affect an output. A zero-gain node connected to the context
 * destination makes this branch active while guaranteeing that microphone samples are never played
 * into the user's headphones. Returning both nodes also gives BrowserCapture strong references for
 * the whole recording lifetime.
 */
export function meterGraph(
  context: AudioContext,
  stream: MediaStream,
  analyser: AnalyserNode,
): readonly [MediaStreamAudioSourceNode, GainNode] {
  const source = context.createMediaStreamSource(stream);
  const sink = context.createGain();
  sink.gain.value = 0;
  source.connect(analyser);
  analyser.connect(sink);
  sink.connect(context.destination);
  return [source, sink] as const;
}

/** A 16-bit mono PCM WAV around the samples. */
export function wav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }
  return buffer;
}

/** Bytes as base64, in chunks so a long clip does not blow the argument limit on `fromCharCode`. */
export function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}
