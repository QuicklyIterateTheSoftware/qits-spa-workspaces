import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { ServiceEventDto, WorkspaceRuntimeStatus } from '../../api/dto';
import type { ServiceDto, ServiceState } from '../../api/services-api';
import { WorkspaceServices } from '../../api/workspace-services';
import { ServicesPanel } from './services-panel';

const service = (
  name: string,
  state: ServiceState,
  extra: Partial<ServiceDto> = {},
): ServiceDto => ({
  name,
  state,
  restartCount: 0,
  webViewable: false,
  ...extra,
});

const event = (over: Partial<ServiceEventDto> = {}): ServiceEventDto => ({
  repoId: 'repo',
  workspaceId: 'task-login',
  workspaceRowId: 7,
  serviceId: 'dev',
  serviceName: 'dev',
  kind: 'STATUS_CHANGED',
  severity: 'INFO',
  status: 'READY',
  summary: 'dev is ready',
  logExcerpt: null,
  commandId: null,
  source: null,
  anchorFrom: null,
  anchorTo: null,
  sourceEpoch: null,
  timestamp: '2026-08-01T10:00:00Z',
  ...over,
});

@Component({
  selector: 'app-panel-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ServicesPanel],
  template: `<app-services-panel
    [workspaceRowId]="id()"
    [repositoryId]="'repo'"
    [workspaceLabel]="'task-login'"
    [runtimeStatus]="runtime()"
    [visible]="visible()"
  />`,
})
class PanelHost {
  readonly id = signal(7);
  readonly visible = signal(true);
  readonly runtime = signal<WorkspaceRuntimeStatus | null>('RUNNING');
}

/**
 * The services panel, in the terms the measurement set it.
 *
 * **The load budget is asserted, not just written down**: two requests on first open, the daemon's
 * service list and one page of the host's durable feed. A budget that lives only in a comment grows
 * a third request the first time somebody needs one, and nobody notices.
 *
 * **Health is asserted as absent.** There is no `health` field on the daemon's list, because nothing
 * anywhere runs the checks a checkout declares — so the panel's job is to say so and to *not* derive
 * a verdict from the supervisor's process state. A test that only checked the happy list would pass
 * just as happily against a panel that had quietly started colouring `READY` as "healthy", which is
 * the one lie this surface could tell.
 *
 * **`STOPPED`'s ambiguity is asserted too.** A service that crashes leaves the supervisor's live map
 * and reads `STOPPED` on a later list; the `CRASHED` transition is on the control socket, which no
 * browser can attach to. The chip has to say that rather than reporting a clean stop.
 */
describe('ServicesPanel', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<PanelHost>;
  let host: PanelHost;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function element(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function text(): string {
    return element().textContent ?? '';
  }

  function rowNames(): string[] {
    return Array.from(element().querySelectorAll<HTMLElement>('.service .name')).map(
      (node) => node.textContent?.trim() ?? '',
    );
  }

  async function open(
    services: readonly ServiceDto[],
    events: readonly ServiceEventDto[] = [],
  ): Promise<void> {
    fixture = TestBed.createComponent(PanelHost);
    host = fixture.componentInstance;
    await settle();
    http.expectOne('/workspaces/container/7/services').flush({ services });
    http.expectOne((request) => request.url === '/workspaces/api/service-events').flush({ events });
    await settle();
  }

  it('reads exactly two surfaces on first open: the list and one page of the feed', async () => {
    fixture = TestBed.createComponent(PanelHost);
    host = fixture.componentInstance;
    await settle();

    const requests = http.match(() => true);
    expect(requests.length).toBe(2);
    expect(requests.map((request) => request.request.url).sort()).toEqual([
      '/workspaces/api/service-events',
      '/workspaces/container/7/services',
    ]);

    // The feed asks for one page of twenty, which is the window the panel shows.
    const feed = requests.find((request) => request.request.url.endsWith('service-events'))!;
    expect(feed.request.params.get('pageSize')).toBe('20');
    expect(feed.request.params.get('repoId')).toBe('repo');
    expect(feed.request.params.get('workspaceId')).toBe('task-login');

    requests[0].flush({ services: [] });
    requests[1].flush({ events: [] });
    await settle();
  });

  it('lists every declared service, running or not', async () => {
    await open([service('dev', 'READY'), service('worker', 'STOPPED')]);
    expect(rowNames()).toEqual(['dev', 'worker']);
  });

  it('says health is unknown, and never derives a verdict from the running state', async () => {
    await open([service('dev', 'READY')]);

    expect(text()).toContain('Health is unknown, for every service');
    expect(text()).toContain('nothing runs them');
    // The state is reported as the supervisor's process state and nothing stronger.
    expect(text()).toContain('a process that started is not a service that works');
    expect(text()).not.toContain('healthy');
  });

  it('shows the restart count on the chip line, and only when there is one', async () => {
    await open([
      service('dev', 'READY', { restartCount: 3 }),
      service('worker', 'READY', { restartCount: 0 }),
    ]);

    const restarts = Array.from(element().querySelectorAll<HTMLElement>('.restarts'));
    expect(restarts.length).toBe(1);
    expect(restarts[0].textContent).toContain('restarted 3');
  });

  it('says a stopped service may equally have crashed, because the list cannot tell', async () => {
    await open([service('worker', 'STOPPED')]);

    const chip = element().querySelector<HTMLElement>('.state qits-badge')!;
    expect(chip.getAttribute('title')).toContain('crashed');
    expect(chip.getAttribute('title')).toContain('events below');
  });

  it('refetches the list when a stop settles, not when it succeeds', async () => {
    await open([service('dev', 'READY')]);

    const button = element().querySelector<HTMLElement>('.verbs qits-button button')!;
    button.click();
    await settle();

    // The signal is refused. The truth is still re-read: a failed stop has changed what is true.
    http
      .expectOne('/workspaces/container/7/services/dev/signal')
      .flush({ message: 'no' }, { status: 500, statusText: 'Server Error' });
    await settle();

    http.expectOne('/workspaces/container/7/services').flush({
      services: [service('dev', 'READY')],
    });
    await settle();
    expect(rowNames()).toEqual(['dev']);
  });

  it('starts a service that is not running, and stops one that is', async () => {
    await open([service('worker', 'STOPPED')]);

    element().querySelector<HTMLElement>('.verbs qits-button button')!.click();
    await settle();

    http.expectOne('/workspaces/container/7/services/worker/start').flush({ accepted: true });
    await settle();
    http.expectOne('/workspaces/container/7/services').flush({ services: [] });
    await settle();
  });

  it('names the container as the reason when the list cannot be read, and keeps the feed', async () => {
    fixture = TestBed.createComponent(PanelHost);
    host = fixture.componentInstance;
    host.runtime.set('STOPPED');
    await settle();

    http
      .expectOne('/workspaces/container/7/services')
      .flush({ message: 'No workspace here.' }, { status: 502, statusText: 'Bad Gateway' });
    http
      .expectOne((request) => request.url === '/workspaces/api/service-events')
      .flush({ events: [event({ status: 'CRASHED', severity: 'ERROR' })] });
    await settle();

    expect(text()).toContain('The container is stopped — the service list lives in the container');
    // The feed is host-held, so it survives the container and is still drawn.
    expect(text()).toContain('dev');
    // And the 502 is not also reported as a bare status beside the sentence that explains it.
    expect(element().querySelector('.async-error')).toBeNull();
  });

  it('aggregates the tab dot: restarting outranks ready, and nothing running draws none', async () => {
    await open([service('dev', 'READY'), service('worker', 'RESTARTING')]);
    const entry = TestBed.inject(WorkspaceServices);
    expect(entry.dot()).toBe('warning');
    expect(entry.dotTitle()).toBe('A service is restarting');
  });

  it('draws no dot at all until the list has been read', () => {
    // Nothing has asked, so the label says nothing — which is not the same as "nothing is running",
    // and is exactly why the shell does not fetch this to colour a tab nobody has opened.
    expect(TestBed.inject(WorkspaceServices).dot()).toBeNull();
  });
});
