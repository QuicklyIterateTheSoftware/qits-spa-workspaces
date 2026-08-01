import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core';
import type { AgentActivityState } from '../../api/dto';
import { WorkspaceEvents } from '../../api/workspace-events';
import { Async } from '../../ui/async';
import { AgentSession } from './agent-session';
import { EmbeddedSession } from './embedded-session';
import { PluginsSection } from './plugins-section';
import { SessionTree } from './session-tree';

/**
 * The Agents tab: the session you are in, what the agent is doing, everything it has done here, and
 * what is installed for it.
 *
 * ## What it loads
 *
 * **On first selection this panel reads `3`, plus the two shared entries when it is the first to ask
 * for them:**
 *
 * 1. `GET /agent-sessions` — the lineage, for the tree and for the "is there any history" question
 *    branch 3 turns on.
 * 2. `GET /agents/available` — the harnesses, once per container. It cannot change under a running
 *    one, so it is never re-read.
 * 3. `GET /agent-plugins` — the shared agent home's store.
 * 4. `GET /commands` — the shared command list, which the Chat tab, the Actions history and this
 *    tab's resolution all read. Free if anything has already asked.
 * 5. `GET /detection` — only if **nothing** has read one yet. It is the file browser's read, handed
 *    over through the shared entry; the plugin recommender pays for it only when the Files tab has
 *    never been opened, and does without the badges if it fails.
 *
 * Nothing here is launched on page load, and that is the point: a session is expensive to
 * materialise, so the tab latches on first selection and resolves then.
 *
 * **The session keeps working while this tab is hidden**, because the PTY socket must stay attached
 * — a detached terminal stops replaying and the run looks dead. The *reads* obey the ordinary rule
 * instead: a `commands` hint that arrives behind another tab is remembered and answered with one
 * catch-up read on becoming visible.
 *
 * ## The activity-tracking checkbox is not built, deliberately
 *
 * The old screen had an instance-wide checkbox toggling whether the turn-boundary hooks are injected
 * at all. **No endpoint reads or writes that setting** — it is a daemon configuration key with a
 * `.qits-config.yml` override, and there is nothing on any HTTP surface to bind a checkbox to. A
 * control that cannot report its own value and cannot change it is worse than none, so this panel
 * says where the setting lives instead, and the badge below says plainly which hook it does *not*
 * gate: the `SessionStart` lineage hook is injected unconditionally, which is why the session tree
 * fills in whether or not activity tracking is on.
 */
@Component({
  selector: 'app-agents-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, EmbeddedSession, PluginsSection, SessionTree],
  templateUrl: './agents-panel.html',
  styleUrl: './agents-panel.css',
})
export class AgentsPanel {
  protected readonly session = inject(AgentSession);
  private readonly events = inject(WorkspaceEvents);

  /** Which workspace's container to read. The row id, which is what the proxy addresses. */
  readonly workspaceRowId = input.required<number>();

  /**
   * The workspace's live agent state, as the host rolled it up.
   *
   * An input rather than a fetch: the shell already holds the workspace row that carries it, and a
   * second read here would put a request on the page for a value that is already on screen in the
   * status strip.
   */
  readonly activity = input<AgentActivityState | null>(null);

  /** Whether this tab is showing. The socket ignores it; the reads do not. */
  readonly visible = input(false);

  private readonly hints = this.events.invalidations('commands');

  private readFor: number | null = null;
  private seenHint = -1;
  private missedHint = false;

  constructor() {
    // Driven off the id, never off a click: the resolution has to be the same whether the tab was
    // pressed or the URL was pasted.
    effect(() => this.session.use(this.workspaceRowId()));

    effect(() => {
      const workspaceRowId = this.workspaceRowId();
      const hint = this.hints();
      const visible = this.visible();
      untracked(() => this.decideRead(workspaceRowId, hint, visible));
    });

    // Closing detaches; it never terminates. The agent keeps running after the page goes away, which
    // is the whole reason this is safe to do on destroy.
    inject(DestroyRef).onDestroy(() => this.session.detach());
  }

  // ---- what is on screen -------------------------------------------------------------------

  protected readonly sessionState = this.session.sessions;

  protected readonly sessionList = computed(() => {
    const state = this.sessionState();
    return state.kind === 'ready' ? state.value : [];
  });

  /**
   * The activity badge.
   *
   * `ENDED` **does arrive**: the host keeps the entry when a session stops and expires it after
   * thirty minutes. So a session that has just stopped reads as "Ended" here, and falls back to "No
   * active agent" once the window passes. The difference is worth drawing — "Ended" is exactly the
   * moment a workspace is waiting for your next prompt — so it gets its own tone rather than
   * borrowing idle's.
   */
  protected readonly badge = computed(() => {
    switch (this.activity()) {
      case 'BUSY':
        return { label: 'Cooking…', tone: 'busy' };
      case 'WAITING':
        return { label: 'Waiting on you', tone: 'waiting' };
      case 'IDLE':
        return { label: 'Idle', tone: 'idle' };
      case 'ENDED':
        return { label: 'Ended', tone: 'ended' };
      default:
        return { label: 'No active agent', tone: 'none' };
    }
  });

  // ---- what the panel does -----------------------------------------------------------------

  protected resume(sessionId: string): void {
    void this.session.resume(sessionId);
  }

  /** A fork branches the session rather than continuing it — and `fork` never rides without an id. */
  protected fork(sessionId: string): void {
    void this.session.resume(sessionId, true);
  }

  protected reloadSessions(): void {
    void this.session.refreshSessions();
  }

  /**
   * The catch-up read.
   *
   * The first observation is not a refetch: {@link AgentSession.use} has just read the lineage, and
   * answering the same hint twice would make first open cost four requests instead of three.
   */
  private decideRead(workspaceRowId: number, hint: number, visible: boolean): void {
    if (workspaceRowId <= 0) {
      return;
    }
    if (this.readFor !== workspaceRowId) {
      this.readFor = workspaceRowId;
      this.seenHint = hint;
      this.missedHint = false;
      return;
    }
    if (hint !== this.seenHint) {
      this.seenHint = hint;
      this.missedHint = true;
    }
    if (!visible || !this.missedHint) {
      return;
    }
    this.missedHint = false;
    void this.session.refreshSessions();
  }
}
