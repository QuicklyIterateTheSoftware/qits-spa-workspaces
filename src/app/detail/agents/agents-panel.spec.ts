import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { CommandDto } from '../../api/commands-api';
import type { AgentActivityState } from '../../api/dto';
import { EVENT_SOURCE_FACTORY, type EventSourceLike } from '../../api/event-source';
import { WEB_SOCKET_FACTORY, WEB_SOCKET_OPEN, type WebSocketLike } from '../../api/web-socket';
import { WorkspaceEvents } from '../../api/workspace-events';
import { AgentsPanel } from './agents-panel';

const settle = async () => {
  for (let turn = 0; turn < 12; turn++) {
    await Promise.resolve();
  }
};

class FakeStream implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  close(): void {
    this.readyState = 2;
  }
}

class FakeSocket implements WebSocketLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = WEB_SOCKET_OPEN;
  constructor(readonly url: string) {}
  send(): void {
    // Nothing is typed into a terminal in this suite; the panel's reads are what it is about.
  }
  close(): void {
    // Detaching is the socket's own test's business.
  }
}

const finished: CommandDto = {
  id: 'c1',
  repoId: 'r',
  workspaceId: 'w',
  branch: 'b',
  actionName: 'claude',
  status: 'EXITED',
  interactive: true,
  kind: 'TERMINAL',
  launchedAt: '2026-08-01T10:00:00Z',
  agentSessions: [{ sessionId: 's1', source: 'PINNED', recordedAt: '2026-08-01T10:00:00Z' }],
};

@Component({
  selector: 'app-panel-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AgentsPanel],
  template: `<app-agents-panel
    [workspaceRowId]="id()"
    [activity]="activity()"
    [visible]="visible()"
  />`,
})
class PanelHost {
  readonly id = signal(7);
  readonly activity = signal<AgentActivityState | null>(null);
  readonly visible = signal(true);
}

/**
 * The Agents tab as a whole.
 *
 * **The load budget is asserted, not just written down.** Three reads of its own plus the two shared
 * entries when it is the first to want them, and no more — a fourth request appearing here would be
 * a panel quietly re-reading something another surface already owns, which is exactly the failure
 * the shared entries exist to prevent and exactly the kind nobody notices.
 */
describe('AgentsPanel', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<PanelHost>;
  let host: PanelHost;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        // The deferred branch's jump link is a URL write, so the panel needs a router to write to.
        provideRouter([]),
        { provide: EVENT_SOURCE_FACTORY, useValue: () => new FakeStream() },
        { provide: WEB_SOCKET_FACTORY, useValue: (url: string) => new FakeSocket(url) },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';

  /** Open the tab and answer everything it asks for, returning the URLs it asked for. */
  async function open(): Promise<string[]> {
    fixture = TestBed.createComponent(PanelHost);
    host = fixture.componentInstance;
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    const asked = http.match(() => true);
    for (const request of asked) {
      const url = request.request.url;
      if (url.endsWith('/agent-sessions')) {
        request.flush({ sessions: [{ sessionId: 's1', subagents: [], children: [] }] });
      } else if (url.endsWith('/agents/available')) {
        request.flush({ agents: ['CLAUDE'], defaultAgent: 'CLAUDE' });
      } else if (url.endsWith('/commands')) {
        request.flush({ entries: [{ command: finished }] });
      } else if (url.endsWith('/agent-plugins')) {
        request.flush({ installed: [] });
      } else if (url.endsWith('/detection')) {
        request.flush({ projects: [], frameworks: [], links: [], generation: 'g1' });
      }
    }
    await settle();
    fixture.detectChanges();
    return asked.map((request) => request.request.url);
  }

  it('reads exactly five surfaces on first open, and nothing twice', async () => {
    const asked = await open();
    expect(asked.sort()).toEqual([
      '/workspaces/container/7/agent-plugins',
      '/workspaces/container/7/agent-sessions',
      '/workspaces/container/7/agents/available',
      '/workspaces/container/7/commands',
      '/workspaces/container/7/detection',
    ]);
    http.expectNone(() => true);
  });

  it('does not resume the recorded session, and offers the choice instead', async () => {
    await open();
    expect(text()).toContain('Sessions are not resumed automatically');
    expect(text()).toContain('Resume the last session');
    http.expectNone('/workspaces/container/7/agents');
  });

  it('names the activity, including the ended state and how long it lasts', async () => {
    await open();
    expect(text()).toContain('No active agent');
    host.activity.set('BUSY');
    fixture.detectChanges();
    expect(text()).toContain('Cooking…');
    host.activity.set('ENDED');
    fixture.detectChanges();
    expect(text()).toContain('Ended');
    expect(text()).toContain('then as “no active agent”');
  });

  it('does not build the activity-tracking checkbox, and says where the setting lives', async () => {
    await open();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('input[type="checkbox"]'),
    ).toBeNull();
    expect(text()).toContain('no endpoint reads or writes it');
    expect(text()).toContain('.qits-config.yml');
  });

  it('holds a hint that lands behind another tab and answers it once on becoming visible', async () => {
    await open();
    host.visible.set(false);
    fixture.detectChanges();

    const events = TestBed.inject(WorkspaceEvents);
    events.invalidateAll();
    fixture.detectChanges();
    await settle();
    // The shared command entry keeps itself fresh while hidden — the *panel's* lineage read does not.
    http
      .match('/workspaces/container/7/commands')
      .forEach((request) => request.flush({ entries: [{ command: finished }] }));
    http.expectNone('/workspaces/container/7/agent-sessions');

    host.visible.set(true);
    fixture.detectChanges();
    await settle();
    http
      .expectOne('/workspaces/container/7/agent-sessions')
      .flush({ sessions: [{ sessionId: 's1', subagents: [], children: [] }] });
    await settle();
    fixture.detectChanges();
    http.expectNone('/workspaces/container/7/agent-sessions');
  });
});
