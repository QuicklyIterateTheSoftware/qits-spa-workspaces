import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { App } from './app';
import { routes } from './app.routes';

/**
 * The shell owns one thing — the outlet — so that is what is asserted here, plus the route table
 * actually reaching the layout behind it, and now the page behind that. What the layout itself
 * renders is qits-spa-ui-components' business; all this repo has to prove is that it is mounted,
 * and mounted as a *route* rather than around the shell, which is what keeps it alive across
 * navigation.
 *
 * The http providers arrived with the first real page: navigating to `/` now mounts a component
 * that reads the platform's projects, so a spec about routing has to answer that request or the
 * navigation never settles.
 */
describe('App', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
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

  it('routes the root URL to the shared layout, with the workspaces page inside it', async () => {
    const harness = await RouterTestingHarness.create('/');
    http.expectOne('/projects/api/projects').flush({ entries: [] });
    await harness.fixture.whenStable();

    const layout = harness.routeNativeElement;

    expect(layout?.tagName.toLowerCase()).toBe('qits-main-layout');
    // A floor, not a count: the navigation grows a door whenever the platform grows an app, and a
    // spec that asserted the exact number would fail on somebody else's release.
    expect(layout?.querySelectorAll('nav a').length).toBeGreaterThan(0);
    // The layout carries its own outlet; the page renders in it.
    expect(layout?.querySelector('router-outlet')).not.toBeNull();
    expect(layout?.querySelector('app-workspaces-page')).not.toBeNull();

    http.verify();
  });
});
