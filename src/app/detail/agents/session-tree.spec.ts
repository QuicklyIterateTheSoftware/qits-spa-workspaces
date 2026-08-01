import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { AgentSessionNodeDto } from '../../api/agents-api';
import { SessionTree, sessionRows } from './session-tree';

const node = (sessionId: string, over: Partial<AgentSessionNodeDto> = {}): AgentSessionNodeDto => ({
  sessionId,
  subagents: [],
  children: [],
  ...over,
});

@Component({
  selector: 'app-tree-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SessionTree],
  template: `<app-session-tree
    [sessions]="sessions()"
    [liveSessionId]="live()"
    [owned]="owned()"
    (resumeSession)="resumed.push($event)"
    (forkSession)="forked.push($event)"
  />`,
})
class TreeHost {
  readonly sessions = signal<readonly AgentSessionNodeDto[]>([]);
  readonly live = signal<string | null>(null);
  readonly owned = signal(false);
  readonly resumed: string[] = [];
  readonly forked: string[] = [];
}

/**
 * The session history.
 *
 * Two rules carry the whole surface. **Resume is absent, not disabled, while something owns the
 * conversation** — a greyed button invites a click that cannot be honoured, and the collision it
 * would cause is the one session-pinning exists to prevent. And **a missing message count is not a
 * zero**: the count is written by the transcript sweep on exit, so printing "0 messages" over a live
 * conversation would be the one number here that is simply wrong.
 */
describe('SessionTree', () => {
  let fixture: ComponentFixture<TreeHost>;
  let host: TreeHost;

  beforeEach(() => {
    fixture = TestBed.createComponent(TreeHost);
    host = fixture.componentInstance;
  });

  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const rows = () =>
    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.row'));

  it('flattens the nesting, newest root first, with forks under their origin', () => {
    const flattened = sessionRows([
      node('old', { firstRecordedAt: '2026-07-01T10:00:00Z' }),
      node('new', {
        firstRecordedAt: '2026-08-01T10:00:00Z',
        children: [node('branch', { forkedFromSessionId: 'new' })],
      }),
    ]);
    expect(flattened.map((row) => row.id)).toEqual(['new', 'branch', 'old']);
    expect(flattened[1].depth).toBe(1);
    expect(flattened[1].forked).toBe(true);
  });

  it('gives every descendant of a root the same accent, so a lineage reads as one', () => {
    const flattened = sessionRows([
      node('a', { children: [node('a1', { children: [node('a2')] })] }),
      node('b'),
    ]);
    expect(flattened[0].accent).toBe(flattened[1].accent);
    expect(flattened[0].accent).toBe(flattened[2].accent);
    expect(flattened[3].accent).not.toBe(flattened[0].accent);
  });

  it('puts a side-chain one level deeper than the session that spawned it', () => {
    const flattened = sessionRows([
      node('root', {
        subagents: [{ agentId: 'sub1', messageCount: 4, description: 'read the plan' }],
        children: [node('child')],
      }),
    ]);
    expect(flattened.map((row) => [row.kind, row.depth])).toEqual([
      ['session', 0],
      ['subagent', 1],
      ['session', 1],
    ]);
  });

  it('says a count is pending rather than printing a zero it does not have', () => {
    host.sessions.set([node('live'), node('done', { messageCount: 0 })]);
    fixture.detectChanges();
    expect(text()).toContain('messages counted when the run ends');
    expect(text()).toContain('0 messages');
  });

  it('offers Resume and Fork only while nothing owns the conversation', () => {
    host.sessions.set([node('s1')]);
    fixture.detectChanges();
    expect(rows()[0].textContent).toContain('Resume');

    host.owned.set(true);
    fixture.detectChanges();
    expect(rows()[0].textContent).not.toContain('Resume');
    expect(text()).toContain('Resume is hidden');
  });

  it('reports which session was pressed', () => {
    host.sessions.set([node('s1')]);
    fixture.detectChanges();
    const buttons = rows()[0].querySelectorAll<HTMLButtonElement>('button');
    buttons[0].click();
    buttons[1].click();
    expect(host.resumed).toEqual(['s1']);
    expect(host.forked).toEqual(['s1']);
  });

  it('marks the session the terminal is attached to', () => {
    host.sessions.set([node('s1'), node('s2')]);
    host.live.set('s2');
    fixture.detectChanges();
    expect(rows()[1].classList.contains('live')).toBe(true);
    expect(rows()[0].classList.contains('live')).toBe(false);
  });

  it('says the container has no sessions rather than drawing nothing', () => {
    host.sessions.set([]);
    fixture.detectChanges();
    expect(text()).toContain('No sessions have been recorded');
  });
});
