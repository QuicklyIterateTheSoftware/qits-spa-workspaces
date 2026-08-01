import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { CommandsApi, type CommandDto } from './commands-api';

const COMMAND: CommandDto = {
  id: 'cmd-1',
  repoId: 'qits-spa-workspaces',
  workspaceId: 'ws-chat',
  branch: 'ws/chat',
  actionName: 'claude chat',
  status: 'RUNNING',
  interactive: false,
  kind: 'CHAT',
  launchedAt: '2026-08-01T10:00:00Z',
  agentSessions: [{ sessionId: 's-1', source: 'PINNED', recordedAt: '2026-08-01T10:00:00Z' }],
};

/**
 * The daemon's command and agent surface, and the two things about it that are easy to get wrong.
 *
 * The proxy **rewrites nothing** — `/commands` on the daemon is `/workspaces/container/{id}/commands`
 * from the browser — and a coding agent **is** a command, so `POST /agents` answers the same
 * `{command: …}` envelope `POST /commands` does.
 */
describe('CommandsApi', () => {
  let api: CommandsApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(CommandsApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('reads the whole list, unfiltered, and unwraps the envelope', async () => {
    // Unfiltered on purpose: one entry is shared by Chat, the run history, the session tree and the
    // embedded session, and a narrower read here would be a second cache of the same thing.
    const answer = api.commands(7);
    const request = http.expectOne('/workspaces/container/7/commands');
    request.flush({ entries: [{ command: COMMAND }] });

    expect(request.request.method).toBe('GET');
    expect(await answer).toEqual([COMMAND]);
  });

  it('reads an absent entries array as an empty list rather than throwing', async () => {
    const answer = api.commands(7);
    http.expectOne('/workspaces/container/7/commands').flush({});
    expect(await answer).toEqual([]);
  });

  it('launches an agent as a chat, inline, and never through the missing MCP tool', async () => {
    // `deliverTaskPrompt` sends the agent to fetch `taskPrompt`, which is not implemented anywhere
    // on the platform — the agent would be told to call something that does not exist.
    const answer = api.launchAgent(7, {
      scope: 'REPOSITORY',
      mode: 'CHAT',
      initialContext: 'add a health check',
      deliverTaskPrompt: false,
    });
    const request = http.expectOne('/workspaces/container/7/agents');
    request.flush({ command: COMMAND });

    expect(request.request.body).toEqual({
      scope: 'REPOSITORY',
      mode: 'CHAT',
      initialContext: 'add a health check',
      deliverTaskPrompt: false,
    });
    expect(await answer).toEqual(COMMAND);
  });

  it('terminates by id and answers the command in its post-terminate state', async () => {
    const answer = api.terminate(7, 'cmd-1');
    const request = http.expectOne('/workspaces/container/7/commands/cmd-1/terminate');
    request.flush({ command: { ...COMMAND, status: 'TERMINATED' } });

    expect(request.request.method).toBe('POST');
    expect((await answer).status).toBe('TERMINATED');
  });

  it('sends the preamble with a refinement when there is one', async () => {
    // The preamble is host-side workspace metadata with no source inside the container, so the
    // caller has to carry it.
    const answer = api.refinePrompt(7, 'uh make the thing faster', 'Speed up the export');
    const request = http.expectOne('/workspaces/container/7/prompt-refinements');
    request.flush({ prompt: 'Make the export faster.' });

    expect(request.request.body).toEqual({
      transcript: 'uh make the thing faster',
      preamble: 'Speed up the export',
    });
    expect(await answer).toBe('Make the export faster.');
  });

  it('omits the preamble entirely when the workspace has none', async () => {
    const answer = api.refinePrompt(7, 'transcript', null);
    const request = http.expectOne('/workspaces/container/7/prompt-refinements');
    request.flush({ prompt: 'refined' });

    expect(request.request.body).toEqual({ transcript: 'transcript' });
    await answer;
  });
});
