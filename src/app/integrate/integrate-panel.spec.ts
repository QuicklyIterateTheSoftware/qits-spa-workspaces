import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { IntegrateResponse, WorkspaceDto } from '../api/dto';
import { IntegratePanel } from './integrate-panel';

/**
 * Every state this affordance can be in, one `it` at a time.
 *
 * The five failure surfaces are the reason this suite is long, and they earn it: they look
 * identical in review (five `@case` blocks) and completely different on screen, and getting one
 * wrong sends a person to fix a conflict that does not exist or to re-press a button that will
 * never work. So each is asserted by what it *says*, not by which branch rendered.
 *
 * Two assertions carry more than their length. **The summary survives a failure**, because `moved`
 * is resolved by pressing the same button again and a person who has to retype their sentence will
 * write a worse one. And **the retry is never automatic**, because integrate is not idempotent —
 * each call stamps a new version — so a client that retried on its own could publish a release
 * nobody asked for.
 */
describe('IntegratePanel', () => {
  let fixture: ComponentFixture<IntegratePanel>;
  let http: HttpTestingController;
  let element: HTMLElement;

  const WORKSPACE: WorkspaceDto = {
    id: 7,
    workspaceId: 'explorer-grouping',
    parent: 'main',
    branch: 'explorer-grouping',
    ahead: 3,
    behind: 0,
    conflictsWithParent: false,
    status: 'ACTIVE',
    runtimeStatus: 'RUNNING',
    runtimeError: null,
    clean: true,
    agentActivity: null,
    preamble: null,
    result: null,
    resolvedAt: null,
    daemonConnectedAt: null,
    daemonVersion: null,
    daemonBuildTime: null,
    daemonOutdated: null,
  };

  const RELEASE: IntegrateResponse = {
    version: '2026.731.193059',
    commitSha: '9f2c1ab3d4e5f60718293a4b5c6d7e8f90123456',
    branch: 'explorer-grouping',
  };

  const INTEGRATE_URL = '/workspaces/api/workspaces/7/integrate';

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(IntegratePanel);
    fixture.componentRef.setInput('workspace', WORKSPACE);
    fixture.componentRef.setInput('targetBranch', 'main');
    element = fixture.nativeElement as HTMLElement;
    await settle();
  });

  afterEach(() => http.verify());

  /**
   * Let every pending microtask land, then render.
   *
   * The panel's state changes at the end of a promise chain — `firstValueFrom` resolving or
   * rejecting, then the component's own `await` — so a single `whenStable()` can return before the
   * `catch` that sets the surface has even run. Yielding a macrotask first drains the whole chain,
   * and only then is there anything for change detection to draw.
   */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
  }

  /** Every rendered button, by its visible label. */
  function button(label: string): HTMLButtonElement {
    const found = [...element.querySelectorAll('button')].find((candidate) =>
      (candidate.textContent ?? '').trim().includes(label),
    );
    if (!found) {
      throw new Error(
        `no button labelled "${label}"; saw: ${[...element.querySelectorAll('button')]
          .map((candidate) => `"${(candidate.textContent ?? '').trim()}"`)
          .join(', ')}`,
      );
    }
    return found;
  }

  async function press(label: string): Promise<void> {
    button(label).click();
    await settle();
  }

  function summaryInput(): HTMLInputElement {
    const input = element.querySelector<HTMLInputElement>('input.summary');
    if (!input) {
      throw new Error('the summary field is not on screen');
    }
    return input;
  }

  async function type(text: string): Promise<void> {
    const input = summaryInput();
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await settle();
  }

  /** Submit the form the way the submit button does, without depending on jsdom's form plumbing. */
  async function submit(): Promise<void> {
    const form = element.querySelector('form');
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
  }

  async function openAndSubmit(text = 'teach the explorer to group runs'): Promise<void> {
    await press('Integrate…');
    await type(text);
    await submit();
  }

  /** Fail the pending integrate with a status and body, then settle. */
  async function reject(status: number, body: Record<string, unknown>): Promise<void> {
    http.expectOne(INTEGRATE_URL).flush(body, { status, statusText: 'Error' });
    await settle();
  }

  it('is a button and a destination, not an open form', () => {
    expect(button('Integrate…')).toBeTruthy();
    expect(element.querySelector('input.summary')).toBeNull();
    expect(element.textContent).toContain('merges into');
    expect(element.textContent).toContain('main');
  });

  it('opens the summary field on the press and previews the commit it will write', async () => {
    await press('Integrate…');
    await type('teach the explorer to group runs');

    expect(element.querySelector('.preview')?.textContent).toContain(
      'release(YYYY.MMDD.HHMMSS): teach the explorer to group runs',
    );
    expect(summaryInput().maxLength).toBe(100);
  });

  it('refuses a blank summary before the service has to', async () => {
    await press('Integrate…');
    expect(button('Integrate into main').disabled).toBe(true);

    await type('   ');
    expect(button('Integrate into main').disabled).toBe(true);

    await type('something');
    expect(button('Integrate into main').disabled).toBe(false);
  });

  it('sends the trimmed summary and says what it is doing', async () => {
    await press('Integrate…');
    await type('  teach the explorer to group runs  ');
    await submit();

    const request = http.expectOne(INTEGRATE_URL);
    expect(request.request.body).toEqual({ summary: 'teach the explorer to group runs' });
    expect(element.querySelector('.working')?.textContent).toContain('pushing to');

    request.flush(RELEASE);
    await settle();
  });

  it('shows the version and the merge sha on success, and announces the release', async () => {
    const released: IntegrateResponse[] = [];
    fixture.componentInstance.integrated.subscribe((result) => released.push(result));

    await openAndSubmit();
    http.expectOne(INTEGRATE_URL).flush(RELEASE);
    await settle();

    const done = element.querySelector('.surface-done');
    expect(done?.textContent).toContain('2026.731.193059');
    expect(done?.textContent).toContain('9f2c1ab');
    expect(done?.textContent).toContain('explorer-grouping');
    // Seven characters is a label; the whole sha is the fact, and it is what gets pasted.
    expect(done?.querySelector('.sha')?.getAttribute('title')).toBe(RELEASE.commitSha);
    expect(released).toEqual([RELEASE]);
  });

  it('reports a merge conflict honestly, with the files and with what was not touched', async () => {
    await openAndSubmit();
    await reject(409, {
      message: 'merge conflict in 2 files',
      conflicts: ['pom.xml', 'src/main/java/A.java'],
    });

    const surface = element.querySelector('.surface-conflict');
    expect(surface?.textContent).toContain('Merge conflict');
    expect(surface?.textContent).toContain('Nothing was released');
    expect([...(surface?.querySelectorAll('.files li') ?? [])].map((li) => li.textContent)).toEqual(
      ['pom.xml', 'src/main/java/A.java'],
    );
    expect(surface?.textContent).toContain('merge conflict in 2 files');
  });

  it('draws a conflict without a file list rather than an empty list', async () => {
    // The platform's error envelope carries only `message` today, so this is the shape a conflict
    // most likely arrives in — and it must still be a conflict, not a bare status code.
    await openAndSubmit();
    await reject(409, { message: 'merge conflict: README.md' });

    expect(element.querySelector('.surface-conflict')).not.toBeNull();
    expect(element.querySelector('.files')).toBeNull();
    expect(element.textContent).toContain('README.md');
  });

  it('offers one more press when main moved, keeping the summary', async () => {
    await openAndSubmit('teach the explorer to group runs');
    await reject(409, { message: 'push rejected: not a fast-forward' });

    expect(element.querySelector('.surface-moved')?.textContent).toContain('moved');
    expect(element.textContent).toContain('no version was spent');

    // The retry is a press, never automatic: an integrate is not idempotent.
    http.verify();
    await press('Try again');

    const retry = http.expectOne(INTEGRATE_URL);
    expect(retry.request.body).toEqual({ summary: 'teach the explorer to group runs' });
    retry.flush(RELEASE);
    await settle();
  });

  it('treats “already integrated” as news, not as a failure, and offers the refresh', async () => {
    let refreshed = 0;
    fixture.componentInstance.refresh.subscribe(() => (refreshed += 1));

    await openAndSubmit();
    await reject(409, { message: 'branch is already integrated into main' });

    const surface = element.querySelector('.surface-already');
    expect(surface?.textContent).toContain('Already integrated');
    expect(surface?.textContent).toContain('no second release');

    await press('Refresh the list');
    expect(refreshed).toBe(1);
  });

  it('shows an unrecognised refusal in the service’s own words', async () => {
    await openAndSubmit();
    await reject(409, { message: 'the workspace is not ACTIVE' });

    expect(element.querySelector('.surface-refused')?.textContent).toContain(
      'the workspace is not ACTIVE',
    );
    expect(element.querySelector('.surface-conflict')).toBeNull();
  });

  it('admits it does not know what happened when the service does not answer', async () => {
    await openAndSubmit();
    await reject(500, { message: 'push failed' });

    const surface = element.querySelector('.surface-unavailable');
    expect(surface?.textContent).toContain('unknown');
    expect(surface?.textContent).toContain('Refresh the list');
  });

  it('goes back to the field with the text still in it', async () => {
    await openAndSubmit('a summary worth keeping');
    await reject(409, { message: 'the workspace is not ACTIVE' });

    await press('Back to the summary');
    expect(summaryInput().value).toBe('a summary worth keeping');
  });
});
