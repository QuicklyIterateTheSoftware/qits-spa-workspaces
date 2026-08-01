import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { IDLE, LOADING, failed, ready, type Loadable } from '../ui/loadable';
import { CommandsApi, type CommandDto } from './commands-api';
import { WorkspaceEvents } from './workspace-events';

/**
 * The one command-list entry, owned in one place.
 *
 * Four surfaces read this list — the Chat tab's "is a conversation live", the Actions run history,
 * the Agents session tree and the embedded session — and the rule that makes four readers affordable
 * is **identical key and identical result shape**, or they silently stop sharing. In a signals
 * codebase that means exactly this: one `@Injectable` owning one signal, injected everywhere, never
 * a second fetch against the same URL.
 *
 * **It owns its own freshness.** The `commands` hint fires when a command's lifecycle changes, and
 * the transcript sweep nudges it again on exit — so the refetch belongs here rather than in each
 * reader, where four readers would answer one hint with four identical requests.
 *
 * **It stays fresh while its tab is hidden**, unlike most panels. Chat is one of the three surfaces
 * that keep working out of sight, and this is why: a conversation started from the list, from the
 * Agents tab or from another device has to be noticed by the Chat tab that is not currently showing,
 * or coming back to it shows a prompt panel over a running agent.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceCommands {
  private readonly api = inject(CommandsApi);
  private readonly events = inject(WorkspaceEvents);

  private readonly workspaceRowId = signal(0);
  private readonly state = signal<Loadable<readonly CommandDto[]>>(IDLE);

  /** Every command this container has run, newest first. */
  readonly commands = this.state.asReadonly();

  /** Which workspace the list on hand belongs to, so a reader can tell it apart from a stale one. */
  readonly loadedFor = computed(() => this.workspaceRowId());

  private readonly hints = this.events.invalidations('commands');

  constructor() {
    effect(() => {
      const workspaceRowId = this.workspaceRowId();
      this.hints();
      untracked(() => void this.load(workspaceRowId));
    });
  }

  /**
   * Read this workspace's commands, and keep reading them.
   *
   * Idempotent for the same id, so every reader may call it on every render; a different id moves
   * the entry and blanks it first, because one workspace's runs are not a stale view of another's.
   */
  use(workspaceRowId: number): void {
    if (this.workspaceRowId() === workspaceRowId) {
      return;
    }
    this.state.set(workspaceRowId > 0 ? LOADING : IDLE);
    this.workspaceRowId.set(workspaceRowId);
  }

  /** Re-read now. For a mutation that settles: the truth is refetched, not patched. */
  async refresh(): Promise<void> {
    await this.load(this.workspaceRowId());
  }

  /**
   * The conversation that owns this workspace right now, or null.
   *
   * A chat is a command of kind `CHAT` that is still `RUNNING`. There is at most one that matters:
   * a concurrent second one is the collision session-pinning exists to prevent, so the newest wins
   * and the list is already newest-first.
   */
  readonly runningChat = computed<CommandDto | null>(() => {
    const state = this.state();
    if (state.kind !== 'ready') {
      return null;
    }
    return state.value.find((command) => command.kind === 'CHAT' && command.status === 'RUNNING') ?? null;
  });

  /** Whether the list has been read at all. `idle` is not "nothing running", it is "not asked". */
  readonly asked = computed(() => this.state().kind !== 'idle');

  private async load(workspaceRowId: number): Promise<void> {
    if (workspaceRowId <= 0) {
      this.state.set(IDLE);
      return;
    }
    try {
      const commands = await this.api.commands(workspaceRowId);
      // A late answer for a workspace that has since been left is dropped rather than shown.
      if (this.workspaceRowId() === workspaceRowId) {
        this.state.set(ready(commands));
      }
    } catch (error) {
      if (this.workspaceRowId() === workspaceRowId) {
        this.state.set(failed(error));
      }
    }
  }
}
