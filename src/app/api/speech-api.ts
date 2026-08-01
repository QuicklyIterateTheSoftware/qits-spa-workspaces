import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { QITS_API_BASE } from './api-base';

/**
 * qits-stt: one route, one field in, one field out.
 *
 * `POST /stt/api/transcriptions` takes `{audioBase64}` and answers `{text}`. It is a third service
 * this page talks to and it needs nothing special to reach: the SPA is served at `/workspaces/`
 * behind the same gateway that serves `/stt/`, so the session cookie rides a same-origin absolute
 * path with no CORS and no machine token — the same reason {@link QITS_API_BASE} is empty.
 *
 * **The bytes must be a WAV.** The service decodes the base64, writes it to a `.wav` file and hands
 * the path to a resident python worker; any common PCM rate is fine because the model resamples, but
 * the container is not a transcoder. Encoding is the browser's job — see `chat/recorder.ts`.
 *
 * It is a *host-side* service on purpose, which is why it is not behind the container proxy: the
 * model is loaded once and stays loaded, and transcription is not workspace-scoped — nothing here
 * takes a workspace or a repository.
 */
@Injectable({ providedIn: 'root' })
export class SpeechApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(QITS_API_BASE);

  /**
   * Transcribe one WAV clip.
   *
   * A blank `audioBase64` is a 400 — and note the envelope differs from the rest of the platform:
   * this one fails validation before the controller, so the body is Quarkus' `{title, status,
   * violations}` rather than the usual `{message}`. Nothing here reads it; the caller says its own
   * sentence about a failed clip, because "the transcription service is not answering" is more use
   * than a constraint name.
   */
  async transcribe(audioBase64: string): Promise<string> {
    const answer = await firstValueFrom(
      this.http.post<{ text?: string }>(`${this.base}/stt/api/transcriptions`, { audioBase64 }),
    );
    return answer.text ?? '';
  }
}
