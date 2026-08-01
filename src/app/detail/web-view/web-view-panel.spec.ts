import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { EVENT_SOURCE_FACTORY, type EventSourceLike } from '../../api/event-source';
import { PickedContext } from '../chat/picked-context';
import type { ServiceDto, ServiceState } from '../../api/services-api';
import { provideRouter } from '@angular/router';
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
        // A picked element's source files deep-link into the Files tab, which is a URL write.
        provideRouter([]),
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

  describe('the element picker', () => {
    const pickButton = () => element().querySelector<HTMLButtonElement>('.pick')!;

    /**
     * Put something in the framed document.
     *
     * jsdom gives the iframe a real, same-origin document but never loads its `src`, so the body is
     * written here — which is exactly the same-origin access the picker itself depends on.
     */
    function framedButton(): HTMLElement {
      const framed = frame()!.contentDocument!;
      framed.open();
      framed.write('<body><app-greeting><button id="go">Go</button></app-greeting></body>');
      framed.close();
      return framed.querySelector<HTMLElement>('#go')!;
    }

    async function armed(): Promise<HTMLElement> {
      await open([service('dev', 'READY', { webViewable: true, webView: { entryPath: 'home' } })]);
      const button = framedButton();
      pickButton().click();
      fixture.detectChanges();
      http.expectOne('/workspaces/container/7/component-map').flush({
        framework: 'angular',
        components: [
          {
            className: 'GreetingComponent',
            componentFile: 'webui/src/app/greeting.ts',
            styleFiles: [],
            selectors: [{ element: 'app-greeting' }],
          },
        ],
      });
      await settle();
      fixture.detectChanges();
      return button;
    }

    it('fetches the attribution map once per activation, and never per pick', async () => {
      const button = await armed();
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      fixture.detectChanges();
      http.expectNone('/workspaces/container/7/component-map');
      expect(TestBed.inject(PickedContext).elements()).toHaveLength(1);
    });

    it('captures the component, the selector and the app-side route', async () => {
      const button = await armed();
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      fixture.detectChanges();
      const pick = TestBed.inject(PickedContext).elements()[0];
      expect(pick.tag).toBe('button');
      expect(pick.selector).toBe('#go');
      expect(pick.componentName).toBe('GreetingComponent');
      expect(pick.sourceFiles).toEqual(['webui/src/app/greeting.ts']);
    });

    it('disarms after a plain pick, so the framed app is usable again at once', async () => {
      const button = await armed();
      expect(pickButton().textContent).toContain('Picking');
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      fixture.detectChanges();
      expect(pickButton().textContent).toContain('Pick an element');
    });

    it('keeps picking while shift is held', async () => {
      const button = await armed();
      button.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }),
      );
      fixture.detectChanges();
      expect(pickButton().textContent).toContain('Picking');
    });

    it('unpicks an element that is picked again, and counts what is held', async () => {
      const button = await armed();
      button.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }),
      );
      fixture.detectChanges();
      expect(text()).toContain('1 picked');

      button.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }),
      );
      fixture.detectChanges();
      expect(TestBed.inject(PickedContext).elements()).toHaveLength(0);
    });

    it('marks a picked element inside the frame, and unmarks it when the store drops it', async () => {
      const button = await armed();
      button.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }),
      );
      fixture.detectChanges();
      expect(button.dataset['qitsPicked']).toBe('true');

      TestBed.inject(PickedContext).clear();
      fixture.detectChanges();
      expect(button.dataset['qitsPicked']).toBeUndefined();
    });
  });
});
