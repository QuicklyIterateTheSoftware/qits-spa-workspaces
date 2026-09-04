import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { WorkspaceDto } from '../api/dto';
import type { MergeResult } from './merge-outcome';
import { MergePanel } from './merge-panel';

/**
 * Every state this affordance can be in, one `it` at a time.
 *
 * **Whether a row has a door at all is read from the workspace, not chosen** — work parented on
 * anything but the repository's default branch integrates into that parent, and work parented on the
 * default branch has no way home from this application at all: qits-workspaces does not write that
 * branch, a release request in qits-projects does. So the first assertions here are about a row
 * drawing the right one of those two. Getting it wrong either hides the door on work that has one,
 * or puts a button on a row that cannot possibly work.
 *
 * The failure surfaces are the reason this suite is long, and they earn it: they look identical in
 * review (six `@case` blocks) and completely different on screen, and getting one wrong sends a
 * person to fix a conflict that does not exist or to re-press a button that will never work. So each
 * is asserted by what it *says*, not by which branch rendered.
 *
 * Two assertions carry more than their length. **The summary survives a failure**, because `moved`
 * is resolved by pressing the same button again and a person who has to retype their sentence will
 * write a worse one. And **the retry is never automatic**, because a lost answer and a refusal look
 * the same from here and only one of them is worth repeating.
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

  /** A task workspace: parented on an epic, so it has a door. */
  const STACKED = workspace({
    id: 7,
    workspaceId: 'group-runs',
    parent: 'epic/explorer',
    branch: 'task/group-runs',
  });

  const INTEGRATE = {
    commitSha: '4b5c6d7e8f90123456789abcdef0123456789abc',
    branch: 'task/group-runs',
    targetBranch: 'epic/explorer',
  };

  const INTEGRATE_URL = '/workspaces/api/workspaces/7/integrate';

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  /** Mount the panel for one workspace. Called by every test, because the door is an input. */
  async function mount(dto: WorkspaceDto = STACKED, mainBranch = 'main'): Promise<void> {
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
  async function openAndSubmit(text = 'land the task on its epic'): Promise<void> {
    await press('…');
    await type(text);
    await submit();
  }

  /** Fail the pending call with a status and body, then settle. */
  async function reject(status: number, body: Record<string, unknown>): Promise<void> {
    http.expectOne(INTEGRATE_URL).flush(body, { status, statusText: 'Error' });
    await settle();
  }

  it('offers the integrate door to a workspace parented on anything but the default branch', async () => {
    await mount(STACKED);
    expect(button('Integrate…')).toBeTruthy();
    expect(element.querySelector('input.summary')).toBeNull();
    expect(element.textContent).toContain('epic/explorer');
    expect(element.textContent).toContain('no release');
  });

  /**
   * The row that used to say Release. The door left qits-workspaces, so the press would 404 — and a
   * dead button reads as the platform being broken rather than as the work belonging elsewhere.
   */
  it('offers no door to work parented on the default branch, and says where releasing happens', async () => {
    await mount(workspace());

    expect([...element.querySelectorAll('button')]).toEqual([]);
    const text = element.textContent ?? '';
    expect(text).toContain('written by the release flow alone');
    expect(text).toContain('release request');
    expect(text).toContain('Projects');
  });

  it('reads the door from the repository’s own default branch, not from the word “main”', async () => {
    // A repository on `trunk` has no door for work parented on `trunk`; a workspace off `main` there
    // is ordinary stacked work and integrates.
    await mount(workspace({ parent: 'trunk' }), 'trunk');
    expect(element.querySelector('.no-door')).not.toBeNull();

    await mount(workspace({ parent: 'main' }), 'trunk');
    expect(button('Integrate…')).toBeTruthy();
  });

  it('previews the integrate commit exactly, because its scope is a branch it knows', async () => {
    await mount(STACKED);
    await press('Integrate…');
    await type('land the task on its epic');

    expect(element.querySelector('.preview')?.textContent).toContain(
      'integrate(task/group-runs): land the task on its epic',
    );
    expect(summaryInput().maxLength).toBe(100);
  });

  it('refuses a blank summary before the service has to', async () => {
    await mount(STACKED);
    await press('Integrate…');
    expect(button('Integrate into epic/explorer').disabled).toBe(true);

    await type('   ');
    expect(button('Integrate into epic/explorer').disabled).toBe(true);

    await type('something');
    expect(button('Integrate into epic/explorer').disabled).toBe(false);
  });

  it('sends the trimmed summary, and promises no version while it works', async () => {
    await mount(STACKED);
    await press('Integrate…');
    await type('  land the task on its epic  ');
    await submit();

    const request = http.expectOne(INTEGRATE_URL);
    expect(request.request.body).toEqual({ summary: 'land the task on its epic' });
    expect(element.querySelector('.working')?.textContent).toContain('Merging and pushing');
    expect(element.querySelector('.working')?.textContent).not.toContain('version');

    request.flush(INTEGRATE);
    await settle();
  });

  it('shows the sha and the target it landed on, and announces the merge', async () => {
    await mount(STACKED);
    const landed: MergeResult[] = [];
    fixture.componentInstance.merged.subscribe((result) => landed.push(result));

    await openAndSubmit();
    http.expectOne(INTEGRATE_URL).flush(INTEGRATE);
    await settle();

    const done = element.querySelector('.surface-done');
    expect(done?.textContent).toContain('Integrated into epic/explorer');
    expect(done?.textContent).toContain('4b5c6d7');
    // Seven characters is a label; the whole sha is the fact, and it is what gets pasted.
    expect(done?.querySelector('.sha')?.getAttribute('title')).toBe(INTEGRATE.commitSha);
    // There is no version anywhere in this application now — not a label with nothing under it.
    expect(done?.textContent).not.toContain('Version');
    expect(done?.textContent).toContain('nothing was released');
    expect(landed).toEqual([
      {
        commitSha: INTEGRATE.commitSha,
        branch: 'task/group-runs',
        targetBranch: 'epic/explorer',
      },
    ]);
  });

  it('reports a merge conflict honestly, with the files and with what was not touched', async () => {
    await mount(STACKED);
    await openAndSubmit();
    await reject(409, {
      message: 'merge conflict in 2 files',
      conflicts: ['pom.xml', 'src/main/java/A.java'],
    });

    const surface = element.querySelector('.surface-conflict');
    expect(surface?.textContent).toContain('Merge conflict');
    expect(surface?.textContent).toContain('Nothing landed');
    expect(surface?.textContent).toContain('epic/explorer');
    expect([...(surface?.querySelectorAll('.files li') ?? [])].map((li) => li.textContent)).toEqual(
      ['pom.xml', 'src/main/java/A.java'],
    );
    expect(surface?.textContent).toContain('merge conflict in 2 files');
  });

  it('draws a conflict without a file list rather than an empty list', async () => {
    // The platform's error envelope carries only `message` today, so this is the shape a conflict
    // most likely arrives in — and it must still be a conflict, not a bare status code.
    await mount(STACKED);
    await openAndSubmit();
    await reject(409, { message: 'merge conflict: README.md' });

    expect(element.querySelector('.surface-conflict')).not.toBeNull();
    expect(element.querySelector('.files')).toBeNull();
    expect(element.textContent).toContain('README.md');
  });

  it('offers one more press when the target moved, keeping the summary', async () => {
    await mount(STACKED);
    await openAndSubmit('land the task on its epic');
    await reject(409, { message: 'push rejected: not a fast-forward' });

    const surface = element.querySelector('.surface-moved');
    expect(surface?.textContent).toContain('moved');
    expect(surface?.textContent).toContain('Nothing landed here.');
    // Nothing here stamps a version any more, so nothing here claims one was spent.
    expect(surface?.textContent).not.toContain('version');

    // The retry is a press, never automatic.
    http.verify();
    await press('Try again');

    const retry = http.expectOne(INTEGRATE_URL);
    expect(retry.request.body).toEqual({ summary: 'land the task on its epic' });
    retry.flush(INTEGRATE);
    await settle();
  });

  it('treats “already integrated” as news, not as a failure, and offers the refresh', async () => {
    await mount(STACKED);
    let refreshed = 0;
    fixture.componentInstance.refresh.subscribe(() => (refreshed += 1));

    await openAndSubmit();
    await reject(409, { message: 'branch is already integrated into epic/explorer' });

    const surface = element.querySelector('.surface-already');
    expect(surface?.textContent).toContain('Already integrated');
    expect(surface?.textContent).toContain('nothing was merged a second time');

    await press('Refresh the list');
    expect(refreshed).toBe(1);
  });

  it('shows an unrecognised refusal in the service’s own words', async () => {
    await mount(STACKED);
    await openAndSubmit();
    await reject(409, { message: 'the workspace is not ACTIVE' });

    const surface = element.querySelector('.surface-refused');
    expect(surface?.textContent).toContain('Integrate was refused');
    expect(surface?.textContent).toContain('the workspace is not ACTIVE');
    expect(element.querySelector('.surface-conflict')).toBeNull();
  });

  /**
   * The row said integrate, from a `parent` the list read a while ago, and the service's main-target
   * guard is the authority. There is no second door here to hand the person to any more — the branch
   * is written by a release request in qits-projects — so the surface says that and offers the
   * refresh, rather than a button that would 404.
   */
  it('answers the wrong door with where the right one is, not with another button', async () => {
    await mount(STACKED);
    await openAndSubmit('land the task on its epic');
    await reject(409, { reason: 'RELEASE_REQUIRED', message: 'target main requires a release' });

    const surface = element.querySelector('.surface-release-required');
    expect(surface?.textContent).toContain('is not written here');
    expect(surface?.textContent).toContain('release request');
    expect(surface?.textContent).toContain('Projects');
    expect(surface?.textContent).toContain('target main requires a release');
    expect(element.querySelector('.surface-refused')).toBeNull();
    expect(
      [...element.querySelectorAll('button')].map((candidate) =>
        (candidate.textContent ?? '').trim(),
      ),
    ).toEqual(['Refresh the list', 'Close']);
  });

  it('admits it does not know what happened when the service does not answer', async () => {
    await mount(STACKED);
    await openAndSubmit();
    await reject(500, { message: 'push failed' });

    const surface = element.querySelector('.surface-unavailable');
    expect(surface?.textContent).toContain('unknown');
    expect(surface?.textContent).toContain('Refresh the list');
  });

  it('goes back to the field with the text still in it', async () => {
    await mount(STACKED);
    await openAndSubmit('a summary worth keeping');
    await reject(409, { message: 'the workspace is not ACTIVE' });

    await press('Back to the summary');
    expect(summaryInput().value).toBe('a summary worth keeping');
  });
});
