import { TestBed } from '@angular/core/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { App } from './app';
import { routes } from './app.routes';

/**
 * The shell owns one thing — the outlet — so that is what is asserted here, plus the route table
 * actually reaching the layout behind it. What the layout itself renders is qits-spa-ui-components'
 * business; all this repo has to prove is that it is mounted, and mounted as a *route* rather than
 * around the shell, which is what keeps it alive across navigation.
 */
describe('App', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter(routes), provideLocationMocks()],
    });
  });

  it('is an outlet and nothing else', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();

    const shell = fixture.nativeElement as HTMLElement;
    expect(shell.querySelector('router-outlet')).not.toBeNull();
    expect(shell.querySelector('h1')).toBeNull();
  });

  it('routes the root URL to the shared layout', async () => {
    const harness = await RouterTestingHarness.create('/');
    const layout = harness.routeNativeElement;

    expect(layout?.tagName.toLowerCase()).toBe('qits-main-layout');
    expect(layout?.querySelectorAll('nav a').length).toBeGreaterThan(0);
    // The layout carries its own outlet; the pages that will fill `children` render in it.
    expect(layout?.querySelector('router-outlet')).not.toBeNull();
  });
});
