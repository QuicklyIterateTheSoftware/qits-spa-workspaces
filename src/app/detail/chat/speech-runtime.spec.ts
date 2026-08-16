import { describe, expect, it, vi } from 'vitest';
import { activatedMicrophone } from './speech-runtime';

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
