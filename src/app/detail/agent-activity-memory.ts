import { Injectable } from '@angular/core';
import type { AgentActivityState, WorkspaceDto } from '../api/dto';

/**
 * When each workspace's agent activity last changed — client-side memory, because the server keeps
 * none.
 *
 * **This is the whole point of the activity bar.** Buttons are ordered by when a workspace's activity
 * last moved, most recent first — not by name and not by state. A session that has just stopped
 * bubbles to the far left, because stopping is its most recent change, and that is exactly the
 * workspace waiting for your next prompt. Sorting by name would be a directory; sorting by state
 * would bury the one that needs you under everything that is busy.
 *
 * **It lives at application scope, and that is load-bearing.** The bar is on the page you reach by
 * clicking one of its own buttons. Page-scoped memory would be rebuilt on every such click, every
 * workspace would look like it changed at that instant, and the row would re-shuffle into an
 * arbitrary order precisely as you tried to use it.
 *
 * A monotonic counter rather than a clock: the order is all that is read, one observation is one
 * step, and everything first seen together is genuinely tied — which is what the identifier
 * tie-break is for.
 */
@Injectable({ providedIn: 'root' })
export class AgentActivityMemory {
  private readonly seen = new Map<number, { activity: AgentActivityState | null; at: number }>();
  private step = 0;

  /**
   * Record what a fresh listing says. Called on every workspace-list read; only an actual change of
   * value moves a workspace's mark.
   */
  observe(workspaces: readonly WorkspaceDto[]): void {
    const at = ++this.step;
    for (const workspace of workspaces) {
      const previous = this.seen.get(workspace.id);
      if (!previous || previous.activity !== workspace.agentActivity) {
        this.seen.set(workspace.id, { activity: workspace.agentActivity, at });
      }
    }
  }

  /** How recently this workspace's activity changed. Higher is more recent; 0 is never seen. */
  changedAt(workspaceRowId: number): number {
    return this.seen.get(workspaceRowId)?.at ?? 0;
  }
}
