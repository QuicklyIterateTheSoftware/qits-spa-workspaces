import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { ServiceEventDto } from '../../api/dto';
import { ServiceEventsFeed } from './service-events-feed';

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
  selector: 'app-feed-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ServiceEventsFeed],
  template: `<app-service-events-feed
    [workspaceRowId]="id()"
    [repositoryId]="'repo'"
    [workspaceLabel]="'task-login'"
    [visible]="visible()"
    [filterService]="scoped()"
  />`,
})
class FeedHost {
  readonly id = signal(7);
  readonly visible = signal(true);
  readonly scoped = signal<string | null>(null);
}

/**
 * The durable service-event feed, and the one trap that shapes it.
 *
 * **`GET /service-events` filters by the branch-derived label, not by the row id, and that label is
 * reused once a workspace resolves.** So the server can and will answer with a *previous*
 * workspace's events under the name this one now carries. Every assertion about the row-id filter
 * here is about that: the rows are attributed by `workspaceRowId`, and the ones that do not belong
 * are counted and named rather than silently dropped — a feed that is quietly short is exactly how
 * this bug hides.
 */
describe('ServiceEventsFeed', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<FeedHost>;
  let host: FeedHost;

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

  function rows(): string[] {
    return Array.from(element().querySelectorAll<HTMLElement>('.event .service')).map(
      (node) => node.textContent?.trim() ?? '',
    );
  }

  async function open(events: readonly ServiceEventDto[]): Promise<void> {
    fixture = TestBed.createComponent(FeedHost);
    host = fixture.componentInstance;
    await settle();
    http.expectOne((request) => request.url === '/workspaces/api/service-events').flush({ events });
    await settle();
  }

  it('reads exactly one page, scoped by repository and label', async () => {
    fixture = TestBed.createComponent(FeedHost);
    host = fixture.componentInstance;
    await settle();

    const request = http.expectOne(() => true);
    expect(request.request.url).toBe('/workspaces/api/service-events');
    expect(request.request.params.get('pageSize')).toBe('20');
    request.flush({ events: [] });
    await settle();
  });

  it('keeps only this workspace’s rows when the label has been recycled', async () => {
    await open([
      event({ serviceName: 'dev', workspaceRowId: 7 }),
      event({ serviceName: 'ghost', workspaceRowId: 4 }),
      event({ serviceName: 'worker', workspaceRowId: 7 }),
    ]);

    expect(rows()).toEqual(['dev', 'worker']);
  });

  it('says how many rows belonged to a different workspace, rather than looking short', async () => {
    await open([
      event({ serviceName: 'dev', workspaceRowId: 7 }),
      event({ serviceName: 'ghost', workspaceRowId: 4 }),
    ]);

    expect(text()).toContain('1 further');
    expect(text()).toContain('belongs to a different workspace');
    expect(text()).toContain('reused after a workspace resolves');
  });

  it('drops a row that carries no workspace id at all, by the same rule', async () => {
    await open([
      event({ serviceName: 'dev', workspaceRowId: 7 }),
      event({ serviceName: 'unattributed', workspaceRowId: null }),
    ]);

    expect(rows()).toEqual(['dev']);
    expect(text()).toContain('1 further');
  });

  it('shows a crash, which is the one thing the live list can never report', async () => {
    await open([
      event({ serviceName: 'dev', status: 'CRASHED', severity: 'ERROR', summary: 'exit 1' }),
    ]);

    expect(rows()).toEqual(['dev']);
    expect(text()).toContain('exit 1');
    expect(element().querySelector('.sev.error')).not.toBeNull();
  });

  it('expands to the captured excerpt, and says so when none was captured', async () => {
    await open([
      event({ serviceName: 'dev', timestamp: '2026-08-01T10:00:00Z', logExcerpt: 'boom\nstack' }),
      event({ serviceName: 'worker', timestamp: '2026-08-01T09:00:00Z', logExcerpt: null }),
    ]);

    const lines = Array.from(element().querySelectorAll<HTMLElement>('.line'));
    lines[0].click();
    await settle();
    expect(element().querySelector('.excerpt')?.textContent).toContain('boom');

    lines[1].click();
    await settle();
    expect(text()).toContain('No log excerpt was captured with this event.');
  });

  it('narrows to one service when the panel scopes it', async () => {
    await open([event({ serviceName: 'dev' }), event({ serviceName: 'worker' })]);

    host.scoped.set('worker');
    await settle();
    expect(rows()).toEqual(['worker']);
  });

  it('does not read while hidden, and does one catch-up read on becoming visible', async () => {
    fixture = TestBed.createComponent(FeedHost);
    host = fixture.componentInstance;
    host.visible.set(false);
    await settle();

    http.expectNone(() => true);

    host.visible.set(true);
    await settle();
    http.expectOne(() => true).flush({ events: [] });
    await settle();
  });

  it('says nothing has been recorded rather than drawing blank space', async () => {
    await open([]);
    expect(text()).toContain('No service events have been recorded for this workspace.');
  });
});
