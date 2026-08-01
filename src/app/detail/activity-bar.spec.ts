import { TestBed } from '@angular/core/testing';
import type { AgentActivityState, WorkspaceDto } from '../api/dto';
import { ActivityBar } from './activity-bar';
import { AgentActivityMemory } from './agent-activity-memory';

const workspace = (
  id: number,
  label: string,
  agentActivity: AgentActivityState | null,
): WorkspaceDto => ({
  id,
  workspaceId: label,
  parent: 'main',
  branch: label,
  ahead: 0,
  behind: 0,
  conflictsWithParent: false,
  status: 'ACTIVE',
  runtimeStatus: 'RUNNING',
  runtimeError: null,
  clean: true,
  agentActivity,
  preamble: null,
  result: null,
  resolvedAt: null,
  daemonConnectedAt: null,
  daemonVersion: null,
  daemonBuildTime: null,
  daemonOutdated: null,
});

/**
 * The bar's ordering rule, which is the whole reason it is not a list of names.
 *
 * Buttons sort by **when a workspace's activity last changed**, most recent first. The consequence
 * is the point: a session that has just stopped sorts to the far left, because stopping is a change
 * — and that is exactly the workspace waiting for your next prompt. Sorting by name would be a
 * directory and sorting by state would bury the one that needs you under everything that is busy.
 *
 * The memory is application-scoped for a reason the last test does not cover but which is worth
 * stating: the bar is on the page you reach by clicking one of its own buttons, so page-scoped
 * memory would be rebuilt on every click and the row would re-shuffle precisely as you tried to use
 * it.
 */
describe('ActivityBar', () => {
  let memory: AgentActivityMemory;

  const render = async (workspaces: readonly WorkspaceDto[], currentId = 1) => {
    const fixture = TestBed.createComponent(ActivityBar);
    fixture.componentRef.setInput('workspaces', workspaces);
    fixture.componentRef.setInput('currentId', currentId);
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  };

  const labels = (fixture: { nativeElement: HTMLElement }): string[] =>
    Array.from(fixture.nativeElement.querySelectorAll('.entry .name')).map(
      (node) => (node as HTMLElement).textContent ?? '',
    );

  beforeEach(() => {
    TestBed.configureTestingModule({});
    memory = TestBed.inject(AgentActivityMemory);
  });

  it('renders nothing at all when no workspace has agent activity', async () => {
    const fixture = await render([workspace(1, 'a', null), workspace(2, 'b', null)]);

    expect(fixture.nativeElement.querySelector('.bar')).toBeNull();
  });

  it('leaves out the workspaces with no activity and keeps the ones that have any', async () => {
    const fixture = await render([
      workspace(1, 'quiet', null),
      workspace(2, 'busy', 'BUSY'),
      workspace(3, 'idle', 'IDLE'),
    ]);

    expect(labels(fixture)).toEqual(['busy', 'idle']);
  });

  it('puts the workspace whose activity changed most recently first', async () => {
    const first = [workspace(1, 'alpha', 'BUSY'), workspace(2, 'beta', 'BUSY')];
    memory.observe(first);

    // beta stops. That is a change, and it is the most recent one.
    const second = [workspace(1, 'alpha', 'BUSY'), workspace(2, 'beta', 'IDLE')];
    memory.observe(second);

    const fixture = await render(second);

    expect(labels(fixture)).toEqual(['beta', 'alpha']);
  });

  it('breaks a tie by identifier, so the order does not wander', async () => {
    const workspaces = [workspace(9, 'nine', 'BUSY'), workspace(4, 'four', 'BUSY')];
    memory.observe(workspaces);

    const fixture = await render(workspaces);

    expect(labels(fixture)).toEqual(['four', 'nine']);
  });

  it('says what each state is, including the one the host cannot report yet', async () => {
    const fixture = await render([
      workspace(1, 'cooking', 'BUSY'),
      workspace(2, 'waiting', 'WAITING'),
      workspace(3, 'idle', 'IDLE'),
      workspace(4, 'ended', 'ENDED'),
    ]);
    const spoken = Array.from(fixture.nativeElement.querySelectorAll('.entry .sr')).map(
      (node: unknown) => (node as HTMLElement).textContent,
    );

    expect(spoken).toEqual(['Cooking…', 'Waiting on you', 'Idle', 'Ended']);
  });

  it('marks the workspace this page is showing', async () => {
    const fixture = await render([workspace(1, 'here', 'BUSY'), workspace(2, 'there', 'BUSY')], 2);
    const current = fixture.nativeElement.querySelector('.entry.current .name') as HTMLElement;

    expect(current.textContent).toBe('there');
  });

  it('opens a workspace by its id, never by its reusable label', async () => {
    const fixture = await render([workspace(42, 'a-label', 'BUSY')]);
    const opened: number[] = [];
    fixture.componentInstance.open.subscribe((id) => opened.push(id));

    (fixture.nativeElement.querySelector('.entry') as HTMLButtonElement).click();

    expect(opened).toEqual([42]);
  });
});
