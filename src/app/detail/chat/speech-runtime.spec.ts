import { describe, expect, it, vi } from 'vitest';
import { activatedMicrophone, meterGraph } from './speech-runtime';

describe('activatedMicrophone', () => {
  it('resumes Web Audio inside the click before waiting for microphone permission', async () => {
    const order: string[] = [];
    const context = {
      resume: vi.fn(async () => {
        order.push('resume');
      }),
      close: vi.fn(async () => undefined),
    } as unknown as AudioContext;
    const stream = {} as MediaStream;

    const opened = await activatedMicrophone(
      () => {
        order.push('context');
        return context;
      },
      async () => {
        order.push('permission');
        return stream;
      },
    );

    expect(order).toEqual(['context', 'resume', 'permission', 'resume']);
    expect(opened).toEqual([context, stream]);
    expect(context.close).not.toHaveBeenCalled();
  });

  it('closes the audio context when microphone permission fails', async () => {
    const denied = new DOMException('denied', 'NotAllowedError');
    const context = {
      resume: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as AudioContext;

    await expect(
      activatedMicrophone(
        () => context,
        async () => {
          throw denied;
        },
      ),
    ).rejects.toBe(denied);
    expect(context.close).toHaveBeenCalledOnce();
  });
});

describe('meterGraph', () => {
  it('retains a silently consumed path from the microphone to the context destination', () => {
    const analyser = { connect: vi.fn() } as unknown as AnalyserNode;
    const source = { connect: vi.fn() } as unknown as MediaStreamAudioSourceNode;
    const sink = {
      gain: { value: 1 },
      connect: vi.fn(),
    } as unknown as GainNode;
    const destination = {} as AudioDestinationNode;
    const stream = {} as MediaStream;
    const context = {
      destination,
      createMediaStreamSource: vi.fn(() => source),
      createGain: vi.fn(() => sink),
    } as unknown as AudioContext;

    expect(meterGraph(context, stream, analyser)).toEqual([source, sink]);
    expect(source.connect).toHaveBeenCalledWith(analyser);
    expect(analyser.connect).toHaveBeenCalledWith(sink);
    expect(sink.connect).toHaveBeenCalledWith(destination);
    expect(sink.gain.value).toBe(0);
  });
});
