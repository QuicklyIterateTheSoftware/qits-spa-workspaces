import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SpeechApi } from './speech-api';

/**
 * qits-stt, which is one route with one field either way.
 *
 * It is a *third* service this page talks to and it needs nothing special to reach: the SPA is
 * served at `/workspaces/` behind the same gateway that serves `/stt/`, so a same-origin absolute
 * path carries the session cookie with no CORS and no machine token.
 */
describe('SpeechApi', () => {
  let api: SpeechApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(SpeechApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('posts the clip to the gateway path and answers the text', async () => {
    const answer = api.transcribe('UklGRg==');
    const request = http.expectOne('/stt/api/transcriptions');
    request.flush({ text: 'add a health check' });

    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ audioBase64: 'UklGRg==' });
    expect(await answer).toBe('add a health check');
  });

  it('reads a missing text field as an empty transcript', async () => {
    const answer = api.transcribe('UklGRg==');
    http.expectOne('/stt/api/transcriptions').flush({});
    expect(await answer).toBe('');
  });
});
