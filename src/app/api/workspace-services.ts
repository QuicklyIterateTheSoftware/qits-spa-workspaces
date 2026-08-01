import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { IDLE, LOADING, failed, ready, type Loadable } from '../ui/loadable';
import { ServicesApi, type ServiceDto } from './services-api';
import { WorkspaceEvents } from './workspace-events';

/** How loud the Services tab's label dot is, or null for no dot at all. */
export type ServicesDot = 'accent' | 'success' | 'warning' | null;

/**
 * The one services entry, owned in one place.
 *
 * Three surfaces read this list — the Services panel, the tab's aggregate label dot and (when it
 * lands) the Web view's service picker — and the rule that makes three readers affordable is
 * **identical key and identical result shape**. In a signals codebase that means one `@Injectable`
 * owning one signal, injected everywhere, never a second fetch against the same URL.
 *
 * **It owns its own freshness.** The `services` hint fires on every supervisor transition the daemon
 * reports, so the refetch belongs here rather than in each reader, where three readers would answer
 * one hint with three identical requests.
 *
 * **It is never read until a reader asks for it, and that is what keeps the tab's dot honest.** The
 * shell draws the Agents dot for free, because the workspace row it already holds carries the
 * activity; there is no such free source for services. Fetching the list at page load purely to
 * colour a dot would put a request on every page open for a tab nobody may visit, against a screen
 * whose stated property is that an idle workspace produces no traffic at all. So {@link use} is
 * called by the panel, and {@link dot} answers null while the entry is idle — which the spec already
 * spells "otherwise no dot". No dot means "not asked", never "nothing running", and the panel is one
 * click away from saying which.
 *
 * **Once asked, it stays fresh while its tab is hidden**, unlike most of what a panel owns. The
 * reason is the dot again: it sits in the tab strip, which is on screen whichever tab is selected,
 * so a source that froze when the user navigated away would leave a label claiming a service is
 * ready minutes after it died. A hidden *panel* may go stale because nobody is reading it; an
 * always-visible label may not.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceServices {
  private readonly api = inject(ServicesApi);
  private readonly events = inject(WorkspaceEvents);

  private readonly workspaceRowId = signal(0);
  private readonly state = signal<Loadable<readonly ServiceDto[]>>(IDLE);

  /** Every service this checkout declares, running or not. */
  readonly services = this.state.asReadonly();

  private readonly hints = this.events.invalidations('services');

  constructor() {
    effect(() => {
      const workspaceRowId = this.workspaceRowId();
      this.hints();
      untracked(() => void this.load(workspaceRowId));
    });
  }

  /**
   * Read this workspace's services, and keep reading them.
   *
   * Idempotent for the same id, so every reader may call it on every render; a different id moves
   * the entry and blanks it first, because one container's services are not a stale view of
   * another's.
   */
  use(workspaceRowId: number): void {
    if (this.workspaceRowId() === workspaceRowId) {
      return;
    }
    this.state.set(workspaceRowId > 0 ? LOADING : IDLE);
    this.workspaceRowId.set(workspaceRowId);
  }

  /**
   * Re-read now.
   *
   * Called by a start or a stop **when it settles, not when it succeeds**: a refused start still
   * changes what is true, and a client that only refetched on success would leave the failed row
   * showing whatever it showed before.
   */
  async refresh(): Promise<void> {
    await this.load(this.workspaceRowId());
  }

  /**
   * The aggregate for the tab's label dot: warning if anything is restarting, success if anything is
   * starting or ready, otherwise nothing.
   *
   * The order is a precedence and not a scan: one restarting service is the thing worth a colour
   * even in a list where four others are happily ready.
   */
  readonly dot = computed<ServicesDot>(() => {
    const state = this.state();
    if (state.kind !== 'ready') {
      return null;
    }
    if (state.value.some((service) => service.state === 'RESTARTING')) {
      return 'warning';
    }
    if (state.value.some((service) => service.state === 'STARTING' || service.state === 'READY')) {
      return 'success';
    }
    return null;
  });

  /** What the dot means, in a sentence, for a hover and for a screen reader. */
  readonly dotTitle = computed(() => {
    switch (this.dot()) {
      case 'warning':
        return 'A service is restarting';
      case 'success':
        return 'A service is running';
      default:
        return '';
    }
  });

  private async load(workspaceRowId: number): Promise<void> {
    if (workspaceRowId <= 0) {
      this.state.set(IDLE);
      return;
    }
    try {
      const services = await this.api.services(workspaceRowId);
      // A late answer for a workspace that has since been left is dropped rather than shown.
      if (this.workspaceRowId() === workspaceRowId) {
        this.state.set(ready(services));
      }
    } catch (error) {
      if (this.workspaceRowId() === workspaceRowId) {
        this.state.set(failed(error));
      }
    }
  }
}
