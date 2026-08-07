import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideQitsNavigationLinks, type QitsNavLink } from '@qits/ui-components';
import { App } from './app';
import { routes } from './app.routes';

/**
 * The shell owns one thing — the outlet — so that is what is asserted here, plus the route table
 * actually reaching the layout behind it. What the layout itself renders is qits-spa-ui-components'
 * business; all this repo has to prove is that it is mounted, and mounted as a *route* rather than
 * around the shell, which is what keeps it alive across navigation.
 *
 * The root view is empty while the overview is redone, so `/` mounts the chrome and nothing else —
 * no request goes out, and the assertion below is that the layout's own outlet is standing and
 * holding nothing.
 */

/**
 * The navigation the layout is handed, standing in for the gateway's `/main-navigation`.
 *
 * The literal source rather than a fourth request through the testing backend, and in this suite
 * that is load-bearing twice over: an unflushed `/main-navigation` would keep the harness from
 * settling, and `http.verify()` below would fail on it. Nothing is fetched, so the chrome stays out
 * of a spec that is about routing.
 */
const NAV: readonly QitsNavLink[] = [
  { label: 'Home', href: '/' },
  { label: 'Workspaces', href: '/workspaces/' },
  { label: 'Projects', href: '/projects/' },
];

describe('App', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideQitsNavigationLinks(NAV),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  it('is an outlet and nothing else', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();

    const shell = fixture.nativeElement as HTMLElement;
    expect(shell.querySelector('router-outlet')).not.toBeNull();
    expect(shell.querySelector('h1')).toBeNull();
  });

  it('routes the root URL to the shared layout, with an empty outlet inside it', async () => {
    const harness = await RouterTestingHarness.create('/');
    await harness.fixture.whenStable();

    const layout = harness.routeNativeElement;

    expect(layout?.tagName.toLowerCase()).toBe('qits-main-layout');
    // The count is this fixture's, and only this fixture's. What the assertion proves is that the
    // app mounts the chrome and the chrome renders what it is told — how many doors the platform
    // really has is a deployment fact the gateway answers from its own route table, so asserting
    // that number is qits-gateway's spec's job, not this one's.
    expect(layout?.querySelectorAll('nav a')).toHaveLength(NAV.length);
    // The layout carries its own outlet; it is standing, and the root view puts nothing in it.
    expect(layout?.querySelector('router-outlet')).not.toBeNull();
    expect(layout?.querySelector('app-not-found')).toBeNull();

    http.verify();
  });
});
