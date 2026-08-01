import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { EVENT_SOURCE_FACTORY, type EventSourceLike } from '../../api/event-source';
import type { ServiceDto, ServiceState } from '../../api/services-api';
import { WebViewPanel } from './web-view-panel';

const settle = async () => {
  for (let turn = 0; turn < 8; turn++) {
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

const service = (
  name: string,
  state: ServiceState,
  over: Partial<ServiceDto> = {},
): ServiceDto => ({
  name,
  state,
  restartCount: 0,
  webViewable: false,
  ...over,
});

@Component({
  selector: 'app-panel-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [WebViewPanel],
  template: `<app-web-view-panel [workspaceRowId]="id()" />`,
})
class PanelHost {
  readonly id = signal(7);
}

/**
 * The Web view tab.
 *
 * The two things worth asserting are the two that are easy to get subtly wrong. **The frame's URL is
 * built from the checkout's declaration and this platform's own shape** — `basePath` and `entryPath`
 * are the app's, the proxy prefix is ours, and getting the slashes wrong lands the frame on a 404
 * that looks like a broken service. And **a web-viewable service that is not running is a different
 * empty state from a checkout that declares none**: one of them is fixed by pressing Start on
 * another tab, and saying so is the difference between a dead end and an instruction.
 */
describe('WebViewPanel', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<PanelHost>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: EVENT_SOURCE_FACTORY, useValue: () => new FakeStream() },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const element = () => fixture.nativeElement as HTMLElement;
  const text = () => element().textContent ?? '';
  const frame = () => element().querySelector<HTMLIFrameElement>('iframe');

  async function open(services: readonly ServiceDto[]): Promise<void> {
    fixture = TestBed.createComponent(PanelHost);
    fixture.detectChanges();
    await settle();
    http.expectOne('/workspaces/container/7/services').flush({ services });
    await settle();
    fixture.detectChanges();
  }

  it('reads one surface, the shared services entry, and nothing else', async () => {
    await open([]);
    http.expectNone(() => true);
  });

  it('frames the running service at the path the checkout declares', async () => {
    await open([
      service('dev', 'READY', {
        id: 'dev-server',
        webViewable: true,
        webView: { port: 4200, basePath: '/app/', entryPath: 'home' },
      }),
    ]);
    expect(frame()?.getAttribute('src')).toBe('/workspaces/service/7/dev-server/app/home');
  });

  it('falls back to the service name when the declaration carries no id', async () => {
    await open([service('dev', 'READY', { webViewable: true, webView: { port: 4200 } })]);
    expect(frame()?.getAttribute('src')).toBe('/workspaces/service/7/dev/');
  });

  it('names the one service, and offers a selector only when there are several', async () => {
    await open([service('dev', 'READY', { webViewable: true, webView: {} })]);
    expect(element().querySelector('select')).toBeNull();
    expect(text()).toContain('dev');
  });

  it('offers a selector across several live web views', async () => {
    await open([
      service('dev', 'READY', { webViewable: true, webView: {} }),
      service('docs', 'READY', { webViewable: true, webView: {} }),
    ]);
    const selector = element().querySelector<HTMLSelectElement>('select');
    expect(selector?.options.length).toBe(2);
  });

  it('says a web-viewable service is stopped rather than framing a 502', async () => {
    await open([service('dev', 'STOPPED', { webViewable: true, webView: {} })]);
    expect(frame()).toBeNull();
    expect(text()).toContain('start one from the Services tab');
  });

  it('says a checkout declares no web view at all, which is a different sentence', async () => {
    await open([service('worker', 'READY')]);
    expect(frame()).toBeNull();
    expect(text()).toContain('declares no web-viewable service');
  });

  it('opens a URL bar seeded from the frame, and refuses another address', async () => {
    await open([service('dev', 'READY', { webViewable: true, webView: { entryPath: 'home' } })]);
    element().querySelector<HTMLButtonElement>('.globe')!.click();
    fixture.detectChanges();

    const input = element().querySelector<HTMLInputElement>('.bar input')!;
    // jsdom never loads the frame, so the seed falls back to the opened path — which is the same
    // rule: the bar says where the frame is, and only the frame can say otherwise.
    expect(input.value).toBe('home');

    input.value = 'https://example.test/';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    element()
      .querySelectorAll<HTMLButtonElement>('button')
      .forEach((button) => {
        if (button.textContent?.includes('Go')) {
          button.click();
        }
      });
    fixture.detectChanges();
    expect(text()).toContain('Only a path inside this application');
  });

  it('discards an edit when the bar is closed rather than keeping it as a claim', async () => {
    await open([service('dev', 'READY', { webViewable: true, webView: { entryPath: 'home' } })]);
    element().querySelector<HTMLButtonElement>('.globe')!.click();
    fixture.detectChanges();
    const input = element().querySelector<HTMLInputElement>('.bar input')!;
    input.value = 'somewhere/else';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    element()
      .querySelectorAll<HTMLButtonElement>('button')
      .forEach((button) => {
        if (button.textContent?.includes('Close')) {
          button.click();
        }
      });
    fixture.detectChanges();
    expect(frame()?.getAttribute('src')).toBe('/workspaces/service/7/dev/home');
  });
});
