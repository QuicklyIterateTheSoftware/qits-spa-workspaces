import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { WorkspaceDto } from '../api/dto';
import type { MergeResult } from './merge-outcome';
import { MergePanel } from './merge-panel';

/**
 * Every state this affordance can be in, one `it` at a time, through both of its doors.
 *
 * **Which door a row offers is read from the workspace, not chosen** — a workspace off the default
 * branch releases, anything else integrates into its parent — so the first assertions here are
 * about a row picking the right one. Getting that wrong puts a button on a row that answers 409
 * every time it is pressed.
 *
 * The six failure surfaces are the reason this suite is long, and they earn it: they look identical
 * in review (six `@case` blocks) and completely different on screen, and getting one wrong sends a
 * person to fix a conflict that does not exist or to re-press a button that will never work. So
 * each is asserted by what it *says*, not by which branch rendered. They are shared by both doors,
 * which is asserted rather than assumed.
 *
 * Two assertions carry more than their length. **The summary survives a failure**, because `moved`
 * is resolved by pressing the same button again and a person who has to retype their sentence will
 * write a worse one. And **the retry is never automatic**, because a release is not idempotent —
 * each call stamps a new version — so a client that retried on its own could publish a release
 * nobody asked for.
 */
describe('MergePanel', () => {
  let fixture: ComponentFixture<MergePanel>;
  let http: HttpTestingController;
  let element: HTMLElement;

  const workspace = (over: Partial<WorkspaceDto> = {}): WorkspaceDto => ({
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
    ...over,
  });

  /** A task workspace: parented on an epic, so its door is integrate. */
  const STACKED = workspace({
    id: 7,
    workspaceId: 'group-runs',
    parent: 'epic/explorer',
    branch: 'task/group-runs',
  });

  const RELEASE = {
    version: '2026.731.193059',
    commitSha: '9f2c1ab3d4e5f60718293a4b5c6d7e8f90123456',
    branch: 'explorer-grouping',
  };

  const INTEGRATE = {
    commitSha: '4b5c6d7e8f90123456789abcdef0123456789abc',
    branch: 'task/group-runs',
    targetBranch: 'epic/explorer',
  };

  const RELEASE_URL = '/workspaces/api/workspaces/7/release';
  const INTEGRATE_URL = '/workspaces/api/workspaces/7/integrate';

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  /** Mount the panel for one workspace. Called by every test, because the door is an input. */
  async function mount(dto: WorkspaceDto = workspace(), mainBranch = 'main'): Promise<void> {
    fixture = TestBed.createComponent(MergePanel);
    fixture.componentRef.setInput('workspace', dto);
    fixture.componentRef.setInput('mainBranch', mainBranch);
    element = fixture.nativeElement as HTMLElement;
    await settle();
  }

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

  /** Open the door this row offers and send a summary through it. */
  async function openAndSubmit(text = 'teach the explorer to group runs'): Promise<void> {
    await press('…');
    await type(text);
    await submit();
  }

  /** Fail the pending call with a status and body, then settle. */
  async function reject(
    status: number,
    body: Record<string, unknown>,
    url = RELEASE_URL,
  ): Promise<void> {
    http.expectOne(url).flush(body, { status, statusText: 'Error' });
    await settle();
  }

  it('offers the release door to work branched off the default branch', async () => {
    await mount();
    expect(button('Release…')).toBeTruthy();
    expect(element.querySelector('input.summary')).toBeNull();
    expect(element.textContent).toContain('merges into');
    expect(element.textContent).toContain('stamps a release version');
  });

  it('offers the integrate door to a workspace parented on anything else', async () => {
    await mount(STACKED);
    expect(button('Integrate…')).toBeTruthy();
    expect(element.textContent).toContain('epic/explorer');
    expect(element.textContent).toContain('no release');
  });

  it('reads the door from the repository’s own default branch, not from the word “main”', async () => {
    // A repository on `trunk` releases work parented on `trunk`; a workspace off `main` there is
    // ordinary stacked work and integrates.
    await mount(workspace({ parent: 'trunk' }), 'trunk');
    expect(button('Release…')).toBeTruthy();

    await mount(workspace({ parent: 'main' }), 'trunk');
    expect(button('Integrate…')).toBeTruthy();
  });

  it('previews the release commit, with the version left undecided', async () => {
    await mount();
    await press('Release…');
    await type('teach the explorer to group runs');

    expect(element.querySelector('.preview')?.textContent).toContain(
      'release(YYYY.MMDD.HHMMSS): teach the explorer to group runs',
    );
    expect(summaryInput().maxLength).toBe(100);
  });

  it('previews the integrate commit exactly, because its scope is a branch it knows', async () => {
    await mount(STACKED);
    await press('Integrate…');
    await type('land the task on its epic');

    expect(element.querySelector('.preview')?.textContent).toContain(
      'integrate(task/group-runs): land the task on its epic',
    );
  });

  it('refuses a blank summary before the service has to', async () => {
    await mount();
    await press('Release…');
    expect(button('Release into main').disabled).toBe(true);

    await type('   ');
    expect(button('Release into main').disabled).toBe(true);

    await type('something');
    expect(button('Release into main').disabled).toBe(false);
  });

  it('sends the trimmed summary to the release route and says what it is doing', async () => {
    await mount();
    await press('Release…');
    await type('  teach the explorer to group runs  ');
    await submit();

    const request = http.expectOne(RELEASE_URL);
    expect(request.request.body).toEqual({ summary: 'teach the explorer to group runs' });
    expect(element.querySelector('.working')?.textContent).toContain('stamping a version');

    request.flush(RELEASE);
    await settle();
  });

  it('sends an integrate to its own route, and does not promise a version while working', async () => {
    await mount(STACKED);
    await press('Integrate…');
    await type('land the task on its epic');
    await submit();

    const request = http.expectOne(INTEGRATE_URL);
    expect(request.request.body).toEqual({ summary: 'land the task on its epic' });
    expect(element.querySelector('.working')?.textContent).not.toContain('version');

    request.flush(INTEGRATE);
    await settle();
  });

  it('shows the version and the merge sha on success, and announces the release', async () => {
    await mount();
    const landed: MergeResult[] = [];
    fixture.componentInstance.merged.subscribe((result) => landed.push(result));

    await openAndSubmit();
    http.expectOne(RELEASE_URL).flush(RELEASE);
    await settle();

    const done = element.querySelector('.surface-done');
    expect(done?.textContent).toContain('2026.731.193059');
    expect(done?.textContent).toContain('9f2c1ab');
    expect(done?.textContent).toContain('explorer-grouping');
    // Seven characters is a label; the whole sha is the fact, and it is what gets pasted.
    expect(done?.querySelector('.sha')?.getAttribute('title')).toBe(RELEASE.commitSha);
    expect(landed).toEqual([
      {
        action: 'release',
        version: '2026.731.193059',
        commitSha: RELEASE.commitSha,
        branch: 'explorer-grouping',
        targetBranch: 'main',
      },
    ]);
  });

  it('shows an integrate’s sha and target, and draws no empty version slot', async () => {
    await mount(STACKED);
    const landed: MergeResult[] = [];
    fixture.componentInstance.merged.subscribe((result) => landed.push(result));

    await openAndSubmit('land the task on its epic');
    http.expectOne(INTEGRATE_URL).flush(INTEGRATE);
    await settle();

    const done = element.querySelector('.surface-done');
    expect(done?.textContent).toContain('Integrated into epic/explorer');
    expect(done?.textContent).toContain('4b5c6d7');
    expect(done?.querySelector('.sha')?.getAttribute('title')).toBe(INTEGRATE.commitSha);
    // There is no version, so there is no version — not a label with nothing under it.
    expect(done?.textContent).not.toContain('Version');
    expect(done?.querySelector('.version')).toBeNull();
    expect(done?.textContent).toContain('nothing was released');
    expect(landed).toEqual([
      {
        action: 'integrate',
        version: null,
        commitSha: INTEGRATE.commitSha,
        branch: 'task/group-runs',
        targetBranch: 'epic/explorer',
      },
    ]);
  });

  it('reports a merge conflict honestly, with the files and with what was not touched', async () => {
    await mount();
    await openAndSubmit();
    await reject(409, {
      message: 'merge conflict in 2 files',
      conflicts: ['pom.xml', 'src/main/java/A.java'],
    });

    const surface = element.querySelector('.surface-conflict');
    expect(surface?.textContent).toContain('Merge conflict');
    expect(surface?.textContent).toContain('Nothing landed');
    expect([...(surface?.querySelectorAll('.files li') ?? [])].map((li) => li.textContent)).toEqual(
      ['pom.xml', 'src/main/java/A.java'],
    );
    expect(surface?.textContent).toContain('merge conflict in 2 files');
  });

  it('draws the same conflict surface for an integrate, naming the parent it did not touch', async () => {
    await mount(STACKED);
    await openAndSubmit('land the task on its epic');
    await reject(
      409,
      { reason: 'CONFLICT', message: 'merge conflict', conflicts: ['pom.xml'] },
      INTEGRATE_URL,
    );

    const surface = element.querySelector('.surface-conflict');
    expect(surface?.textContent).toContain('Merge conflict');
    expect(surface?.textContent).toContain('epic/explorer');
    expect([...(surface?.querySelectorAll('.files li') ?? [])].map((li) => li.textContent)).toEqual(
      ['pom.xml'],
    );
  });

  it('draws a conflict without a file list rather than an empty list', async () => {
    // The platform's error envelope carries only `message` today, so this is the shape a conflict
    // most likely arrives in — and it must still be a conflict, not a bare status code.
    await mount();
    await openAndSubmit();
    await reject(409, { message: 'merge conflict: README.md' });

    expect(element.querySelector('.surface-conflict')).not.toBeNull();
    expect(element.querySelector('.files')).toBeNull();
    expect(element.textContent).toContain('README.md');
  });

  it('offers one more press when the target moved, keeping the summary', async () => {
    await mount();
    await openAndSubmit('teach the explorer to group runs');
    await reject(409, { message: 'push rejected: not a fast-forward' });

    expect(element.querySelector('.surface-moved')?.textContent).toContain('moved');
    expect(element.textContent).toContain('no version was spent');

    // The retry is a press, never automatic: a release is not idempotent.
    http.verify();
    await press('Try again');

    const retry = http.expectOne(RELEASE_URL);
    expect(retry.request.body).toEqual({ summary: 'teach the explorer to group runs' });
    retry.flush(RELEASE);
    await settle();
  });

  it('does not claim a version was spent when an integrate loses the race', async () => {
    await mount(STACKED);
    await openAndSubmit('land the task on its epic');
    await reject(
      409,
      { reason: 'NOT_FAST_FORWARD', message: 'epic/explorer moved' },
      INTEGRATE_URL,
    );

    const surface = element.querySelector('.surface-moved');
    expect(surface?.textContent).toContain('Nothing landed here.');
    expect(surface?.textContent).not.toContain('version');
  });

  it('treats “already integrated” as news, not as a failure, and offers the refresh', async () => {
    await mount();
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

  it('shows an unrecognised refusal in the service’s own words, under this row’s door', async () => {
    await mount();
    await openAndSubmit();
    await reject(409, { message: 'the workspace is not ACTIVE' });

    const surface = element.querySelector('.surface-refused');
    expect(surface?.textContent).toContain('Release was refused');
    expect(surface?.textContent).toContain('the workspace is not ACTIVE');
    expect(element.querySelector('.surface-conflict')).toBeNull();
  });

  it('answers the wrong door with the right one, and sends the same summary through it', async () => {
    // The row said integrate, from a `parent` the list read a while ago. The service's main-target
    // guard is the authority, so its answer overrules the reading — and the way out is the other
    // door, offered rather than described.
    await mount(STACKED);
    await openAndSubmit('land the task on its epic');
    await reject(
      409,
      { reason: 'RELEASE_REQUIRED', message: 'target main requires a release' },
      INTEGRATE_URL,
    );

    const surface = element.querySelector('.surface-release-required');
    expect(surface?.textContent).toContain('has one door');
    expect(surface?.textContent).toContain('target main requires a release');
    expect(element.querySelector('.surface-refused')).toBeNull();

    // The switch stops at the form: this press now stamps a version and publishes, which is a
    // different act from the one that was asked for, so it is confirmed rather than assumed.
    await press('Release into main instead');
    expect(summaryInput().value).toBe('land the task on its epic');
    expect(element.querySelector('.preview')?.textContent).toContain(
      'release(YYYY.MMDD.HHMMSS): land the task on its epic',
    );
    expect(button('Release into main').disabled).toBe(false);
    http.verify();

    await submit();
    const retry = http.expectOne(RELEASE_URL);
    expect(retry.request.body).toEqual({ summary: 'land the task on its epic' });
    retry.flush(RELEASE);
    await settle();

    expect(element.querySelector('.surface-done')?.textContent).toContain('2026.731.193059');
  });

  it('offers the summary back, not a loop, when the release door itself is guarded', async () => {
    // Both endpoints throw RELEASE_REQUIRED, so a release can meet it too. "Release instead" would
    // be advice to do what just failed.
    await mount();
    await openAndSubmit();
    await reject(409, { reason: 'RELEASE_REQUIRED', message: 'target main requires a release' });

    const surface = element.querySelector('.surface-release-required');
    expect(surface?.textContent).toContain('has one door');
    expect(surface?.textContent).not.toContain('instead');
    expect(button('Back to the summary')).toBeTruthy();
  });

  it('admits it does not know what happened when the service does not answer', async () => {
    await mount();
    await openAndSubmit();
    await reject(500, { message: 'push failed' });

    const surface = element.querySelector('.surface-unavailable');
    expect(surface?.textContent).toContain('unknown');
    expect(surface?.textContent).toContain('Refresh the list');
  });

  it('goes back to the field with the text still in it', async () => {
    await mount();
    await openAndSubmit('a summary worth keeping');
    await reject(409, { message: 'the workspace is not ACTIVE' });

    await press('Back to the summary');
    expect(summaryInput().value).toBe('a summary worth keeping');
  });
});
